use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::{
    sync::{Notify, Semaphore, mpsc, watch},
    task::JoinHandle,
    time::MissedTickBehavior,
};
use tokio_tungstenite::tungstenite::protocol::Message;

use crate::protocol::{MessageType, ProbeConfigBody, encode_envelope, now_unix_ms};

use super::{
    IcmpClients, execute_probe,
    task::{NormalizeTaskIssue, ProbeTaskSpec, normalize_tasks},
};

const DEFAULT_MAX_CONCURRENCY: usize = 32;

#[derive(Clone)]
struct ProbeContext {
    out_tx: mpsc::Sender<Message>,
    http: reqwest::Client,
    concurrency: Arc<Semaphore>,
    trace_serial: Arc<Semaphore>,
    icmp: IcmpClients,
}

struct IntervalGroup {
    specs_tx: watch::Sender<Vec<ProbeTaskSpec>>,
    cancel_tx: watch::Sender<bool>,
    kick: Arc<Notify>,
    handle: JoinHandle<()>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ApplyConfigResult {
    Ignored {
        rev: i64,
        current_rev: i64,
    },
    Applied {
        rev: i64,
        kept: usize,
        started: usize,
        restarted: usize,
        stopped: usize,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TaskDiff {
    keep: Vec<String>,
    start: Vec<ProbeTaskSpec>,
    restart: Vec<ProbeTaskSpec>,
    stop: Vec<String>,
}

type InFlightSet = Arc<Mutex<HashSet<String>>>;

pub struct ProbeRunner {
    ctx: ProbeContext,
    current_rev: Option<i64>,
    groups: HashMap<Duration, IntervalGroup>,
    task_specs: HashMap<String, ProbeTaskSpec>,
    in_flight: InFlightSet,
}

impl ProbeRunner {
    pub fn new(out_tx: mpsc::Sender<Message>) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(format!("hina-agent/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("reqwest client build failed");

        Self {
            ctx: ProbeContext {
                out_tx,
                http,
                concurrency: Arc::new(Semaphore::new(DEFAULT_MAX_CONCURRENCY)),
                trace_serial: Arc::new(Semaphore::new(1)),
                icmp: IcmpClients::new(),
            },
            current_rev: None,
            groups: HashMap::new(),
            task_specs: HashMap::new(),
            in_flight: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    pub(crate) fn apply_config(&mut self, body: ProbeConfigBody) -> ApplyConfigResult {
        if let Some(current_rev) = self.current_rev
            && body.rev <= current_rev
        {
            return ApplyConfigResult::Ignored {
                rev: body.rev,
                current_rev,
            };
        }

        let normalized = normalize_tasks(&body.tasks);
        log_normalize_issues(&normalized.issues);

        let diff = plan_task_diff(&self.task_specs, &normalized.desired);

        self.task_specs = normalized.desired;
        self.rebuild_groups(&diff);
        self.current_rev = Some(body.rev);

        ApplyConfigResult::Applied {
            rev: body.rev,
            kept: diff.keep.len(),
            started: diff.start.len(),
            restarted: diff.restart.len(),
            stopped: diff.stop.len(),
        }
    }

    pub fn shutdown(&mut self) {
        for (_, group) in self.groups.drain() {
            let _ = group.cancel_tx.send(true);
            group.handle.abort();
        }
        self.task_specs.clear();
        self.current_rev = None;
    }

    fn rebuild_groups(&mut self, diff: &TaskDiff) {
        let mut desired_groups: HashMap<Duration, Vec<ProbeTaskSpec>> = HashMap::new();
        for spec in self.task_specs.values() {
            desired_groups
                .entry(spec.interval)
                .or_default()
                .push(spec.clone());
        }

        for specs in desired_groups.values_mut() {
            specs.sort_by(|a, b| a.id.cmp(&b.id));
        }

        let mut kick_intervals = std::collections::HashSet::<Duration>::new();
        for spec in diff.start.iter().chain(diff.restart.iter()) {
            kick_intervals.insert(spec.interval);
        }

        // Update existing groups or create new ones
        for (interval, specs) in &desired_groups {
            if let Some(group) = self.groups.get(interval) {
                group.specs_tx.send_replace(specs.clone());
                if kick_intervals.contains(interval) {
                    group.kick.notify_one();
                }
            } else {
                let (specs_tx, specs_rx) = watch::channel(specs.clone());
                let (cancel_tx, cancel_rx) = watch::channel(false);
                let kick = Arc::new(Notify::new());
                let handle = spawn_group_loop(
                    *interval,
                    specs_rx,
                    cancel_rx,
                    kick.clone(),
                    self.ctx.clone(),
                    self.in_flight.clone(),
                );
                self.groups.insert(
                    *interval,
                    IntervalGroup {
                        specs_tx,
                        cancel_tx,
                        kick,
                        handle,
                    },
                );
            }
        }

        // Remove groups that no longer have any tasks
        self.groups.retain(|interval, group| {
            let keep = desired_groups.contains_key(interval);
            if !keep {
                let _ = group.cancel_tx.send(true);
                group.handle.abort();
            }
            keep
        });
    }

    #[cfg(test)]
    fn task_count(&self) -> usize {
        self.task_specs.len()
    }

    #[cfg(test)]
    fn group_count(&self) -> usize {
        self.groups.len()
    }

    #[cfg(test)]
    fn has_task(&self, task_id: &str) -> bool {
        self.task_specs.contains_key(task_id)
    }

    #[cfg(test)]
    fn task_interval(&self, task_id: &str) -> Option<Duration> {
        self.task_specs.get(task_id).map(|s| s.interval)
    }
}

impl Drop for ProbeRunner {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn spawn_group_loop(
    interval: Duration,
    specs_rx: watch::Receiver<Vec<ProbeTaskSpec>>,
    cancel_rx: watch::Receiver<bool>,
    kick: Arc<Notify>,
    ctx: ProbeContext,
    in_flight: InFlightSet,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let jitter_ms = compute_jitter_ms(interval);
        let start_at = tokio::time::Instant::now() + Duration::from_millis(jitter_ms);
        let mut ticker = tokio::time::interval_at(start_at, interval);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut offset: usize = 0;

        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = kick.notified() => {}
            }

            if ctx.out_tx.is_closed() {
                return;
            }

            let ts_ms = now_unix_ms();
            let mut specs = specs_rx.borrow().clone();
            let len = specs.len();
            if len > 0 {
                specs.rotate_left(offset % len);
            }
            offset = offset.wrapping_add(1);

            for spec in specs {
                {
                    let mut guard = in_flight.lock().unwrap();
                    if !guard.insert(spec.id.clone()) {
                        tracing::debug!(task_id = %spec.id, "skip probe: already in flight");
                        continue;
                    }
                }

                let permit = match ctx.concurrency.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        in_flight.lock().unwrap().remove(&spec.id);
                        tracing::warn!(task_id = %spec.id, "skip probe: no permit available");
                        continue;
                    }
                };

                let cancel_rx = cancel_rx.clone();
                let specs_rx = specs_rx.clone();
                let ctx = ctx.clone();
                let in_flight = in_flight.clone();
                let kick = kick.clone();

                tokio::spawn(async move {
                    let result = tokio::select! {
                        r = execute_probe(&spec, &ctx.http, &ctx.icmp, &ctx.trace_serial, ts_ms) => r,
                        _ = wait_cancelled(cancel_rx.clone()) => {
                            in_flight.lock().unwrap().remove(&spec.id);
                            return;
                        },
                    };
                    drop(permit);
                    in_flight.lock().unwrap().remove(&spec.id);

                    if *cancel_rx.borrow() {
                        return;
                    }

                    if !specs_rx.borrow().iter().any(|s| s == &spec) {
                        tracing::debug!(task_id = %spec.id, "drop stale probe result, kick loop to retry");
                        kick.notify_one();
                        return;
                    }

                    let bytes = match encode_envelope(MessageType::ProbeResult, &result) {
                        Ok(bytes) => bytes,
                        Err(err) => {
                            tracing::warn!(task_id = %spec.id, error = %err, "encode probe result failed");
                            return;
                        }
                    };

                    let _ = ctx.out_tx.send(Message::Binary(bytes.into())).await;
                });
            }
        }
    })
}

async fn wait_cancelled(mut rx: watch::Receiver<bool>) {
    while !*rx.borrow() {
        if rx.changed().await.is_err() {
            return;
        }
    }
}

fn compute_jitter_ms(interval: Duration) -> u64 {
    let interval_ms = interval.as_millis().min(u64::MAX as u128) as u64;
    let jitter_max_ms = (interval_ms / 10).min(1000);
    if jitter_max_ms == 0 {
        0
    } else {
        fastrand::u64(0..=jitter_max_ms)
    }
}

fn log_normalize_issues(issues: &[NormalizeTaskIssue]) {
    for issue in issues {
        match issue {
            NormalizeTaskIssue::InvalidTask { task_id, error } => {
                tracing::warn!(task_id = %task_id, error = %error, "skip invalid probe task");
            }
            NormalizeTaskIssue::DuplicateTaskId { task_id } => {
                tracing::warn!(task_id = %task_id, "duplicate probe task id");
            }
        }
    }
}

fn plan_task_diff(
    current: &HashMap<String, ProbeTaskSpec>,
    desired: &HashMap<String, ProbeTaskSpec>,
) -> TaskDiff {
    let mut keep = Vec::<String>::new();
    let mut start = Vec::<ProbeTaskSpec>::new();
    let mut restart = Vec::<ProbeTaskSpec>::new();
    let mut stop = current
        .keys()
        .filter(|task_id| !desired.contains_key(*task_id))
        .cloned()
        .collect::<Vec<_>>();
    stop.sort();

    let mut desired_ids = desired.keys().cloned().collect::<Vec<_>>();
    desired_ids.sort();
    for task_id in desired_ids {
        let spec = desired
            .get(&task_id)
            .expect("desired task id must exist")
            .clone();
        match current.get(&task_id) {
            Some(current_spec) if current_spec == &spec => keep.push(task_id),
            Some(_) => restart.push(spec),
            None => start.push(spec),
        }
    }

    TaskDiff {
        keep,
        start,
        restart,
        stop,
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, time::Duration};

    use serde_json::json;
    use tokio::sync::mpsc;

    use super::{ApplyConfigResult, ProbeRunner, plan_task_diff};
    use crate::{
        probe::task::{ProbeTarget, ProbeTaskSpec},
        protocol::{ProbeConfigBody, ProbeTaskKind, ProbeTaskWire},
    };

    fn task_wire(
        id: &str,
        interval_sec: u64,
        timeout_ms: u64,
        target: serde_json::Value,
    ) -> ProbeTaskWire {
        ProbeTaskWire {
            id: id.to_string(),
            kind: ProbeTaskKind::Tcp,
            interval_sec,
            timeout_ms,
            target,
            enabled: None,
            name: None,
            extra: None,
        }
    }

    fn tcp_spec(
        id: &str,
        interval_sec: u64,
        timeout_ms: u64,
        host: &str,
        port: u16,
    ) -> ProbeTaskSpec {
        ProbeTaskSpec {
            id: id.to_string(),
            interval: Duration::from_secs(interval_sec),
            timeout: Duration::from_millis(timeout_ms),
            target: ProbeTarget::Tcp {
                host: host.to_string(),
                port,
            },
        }
    }

    fn config(rev: i64, tasks: Vec<ProbeTaskWire>) -> ProbeConfigBody {
        ProbeConfigBody { rev, tasks }
    }

    fn current_specs(pairs: Vec<(&str, ProbeTaskSpec)>) -> HashMap<String, ProbeTaskSpec> {
        pairs
            .into_iter()
            .map(|(task_id, spec)| (task_id.to_string(), spec))
            .collect()
    }

    #[test]
    fn plan_task_diff_keeps_matching_specs() {
        let task = tcp_spec("task-1", 5, 1_000, "example.com", 443);
        let current = current_specs(vec![("task-1", task.clone())]);
        let desired = current_specs(vec![("task-1", task)]);

        let diff = plan_task_diff(&current, &desired);
        assert_eq!(diff.keep, vec!["task-1".to_string()]);
        assert!(diff.start.is_empty());
        assert!(diff.restart.is_empty());
        assert!(diff.stop.is_empty());
    }

    #[test]
    fn plan_task_diff_starts_new_tasks() {
        let diff = plan_task_diff(
            &HashMap::new(),
            &current_specs(vec![(
                "task-1",
                tcp_spec("task-1", 5, 1_000, "example.com", 443),
            )]),
        );

        assert!(diff.keep.is_empty());
        assert_eq!(diff.start.len(), 1);
        assert!(diff.restart.is_empty());
        assert!(diff.stop.is_empty());
    }

    #[test]
    fn plan_task_diff_stops_removed_tasks() {
        let diff = plan_task_diff(
            &current_specs(vec![(
                "task-1",
                tcp_spec("task-1", 5, 1_000, "example.com", 443),
            )]),
            &HashMap::new(),
        );

        assert!(diff.keep.is_empty());
        assert!(diff.start.is_empty());
        assert!(diff.restart.is_empty());
        assert_eq!(diff.stop, vec!["task-1".to_string()]);
    }

    #[test]
    fn plan_task_diff_restarts_changed_tasks() {
        let current = current_specs(vec![(
            "task-1",
            tcp_spec("task-1", 5, 1_000, "example.com", 443),
        )]);
        let desired = current_specs(vec![(
            "task-1",
            tcp_spec("task-1", 10, 1_000, "example.com", 443),
        )]);

        let diff = plan_task_diff(&current, &desired);
        assert!(diff.keep.is_empty());
        assert!(diff.start.is_empty());
        assert_eq!(diff.restart.len(), 1);
        assert!(diff.stop.is_empty());
    }

    #[test]
    fn plan_task_diff_empty_desired_stops_all_tasks() {
        let current = current_specs(vec![
            ("task-1", tcp_spec("task-1", 5, 1_000, "example.com", 443)),
            ("task-2", tcp_spec("task-2", 10, 1_000, "example.net", 80)),
        ]);

        let diff = plan_task_diff(&current, &HashMap::new());
        assert!(diff.keep.is_empty());
        assert!(diff.start.is_empty());
        assert!(diff.restart.is_empty());
        assert_eq!(diff.stop, vec!["task-1".to_string(), "task-2".to_string()]);
    }

    #[tokio::test]
    async fn apply_config_sets_initial_rev_and_tasks() {
        let (out_tx, _out_rx) = mpsc::channel(8);
        let mut runner = ProbeRunner::new(out_tx);

        let result = runner.apply_config(config(
            1,
            vec![task_wire(
                "task-1",
                5,
                1_000,
                json!({ "host": "example.com", "port": 443 }),
            )],
        ));

        assert_eq!(
            result,
            ApplyConfigResult::Applied {
                rev: 1,
                kept: 0,
                started: 1,
                restarted: 0,
                stopped: 0,
            }
        );
        assert_eq!(runner.current_rev, Some(1));
        assert_eq!(runner.task_count(), 1);
        assert_eq!(runner.group_count(), 1);

        runner.shutdown();
    }

    #[tokio::test]
    async fn apply_config_ignores_same_rev_without_changes() {
        let (out_tx, _out_rx) = mpsc::channel(8);
        let mut runner = ProbeRunner::new(out_tx);
        let body = config(
            2,
            vec![task_wire(
                "task-1",
                5,
                1_000,
                json!({ "host": "example.com", "port": 443 }),
            )],
        );

        runner.apply_config(body.clone());
        let result = runner.apply_config(body);

        assert_eq!(
            result,
            ApplyConfigResult::Ignored {
                rev: 2,
                current_rev: 2,
            }
        );
        assert_eq!(runner.current_rev, Some(2));
        assert_eq!(runner.task_count(), 1);

        runner.shutdown();
    }

    #[tokio::test]
    async fn apply_config_ignores_lower_rev() {
        let (out_tx, _out_rx) = mpsc::channel(8);
        let mut runner = ProbeRunner::new(out_tx);

        runner.apply_config(config(
            3,
            vec![task_wire(
                "task-1",
                5,
                1_000,
                json!({ "host": "example.com", "port": 443 }),
            )],
        ));
        let result = runner.apply_config(config(
            2,
            vec![task_wire(
                "task-2",
                5,
                1_000,
                json!({ "host": "example.net", "port": 80 }),
            )],
        ));

        assert_eq!(
            result,
            ApplyConfigResult::Ignored {
                rev: 2,
                current_rev: 3,
            }
        );
        assert_eq!(runner.current_rev, Some(3));
        assert_eq!(runner.task_count(), 1);
        assert!(runner.has_task("task-1"));

        runner.shutdown();
    }

    #[tokio::test]
    async fn apply_config_higher_rev_keeps_unchanged_specs() {
        let (out_tx, _out_rx) = mpsc::channel(8);
        let mut runner = ProbeRunner::new(out_tx);
        let tasks = vec![task_wire(
            "task-1",
            5,
            1_000,
            json!({ "host": "example.com", "port": 443 }),
        )];

        runner.apply_config(config(4, tasks.clone()));
        let result = runner.apply_config(config(5, tasks));

        assert_eq!(
            result,
            ApplyConfigResult::Applied {
                rev: 5,
                kept: 1,
                started: 0,
                restarted: 0,
                stopped: 0,
            }
        );
        assert_eq!(runner.current_rev, Some(5));
        assert_eq!(runner.task_count(), 1);

        runner.shutdown();
    }

    #[tokio::test]
    async fn apply_config_higher_rev_diffs_add_remove_and_update() {
        let (out_tx, _out_rx) = mpsc::channel(8);
        let mut runner = ProbeRunner::new(out_tx);

        runner.apply_config(config(
            6,
            vec![
                task_wire(
                    "task-1",
                    5,
                    1_000,
                    json!({ "host": "example.com", "port": 443 }),
                ),
                task_wire(
                    "task-2",
                    5,
                    1_000,
                    json!({ "host": "example.net", "port": 80 }),
                ),
            ],
        ));
        let result = runner.apply_config(config(
            7,
            vec![
                task_wire(
                    "task-1",
                    10,
                    1_000,
                    json!({ "host": "example.com", "port": 443 }),
                ),
                task_wire(
                    "task-3",
                    5,
                    1_000,
                    json!({ "host": "example.org", "port": 8080 }),
                ),
            ],
        ));

        assert_eq!(
            result,
            ApplyConfigResult::Applied {
                rev: 7,
                kept: 0,
                started: 1,
                restarted: 1,
                stopped: 1,
            }
        );
        assert_eq!(runner.current_rev, Some(7));
        assert_eq!(runner.task_count(), 2);
        assert_eq!(
            runner.task_interval("task-1"),
            Some(Duration::from_secs(10))
        );
        assert!(runner.has_task("task-3"));
        assert!(!runner.has_task("task-2"));

        runner.shutdown();
    }

    #[tokio::test]
    async fn apply_config_groups_tasks_by_interval() {
        let (out_tx, _out_rx) = mpsc::channel(8);
        let mut runner = ProbeRunner::new(out_tx);

        runner.apply_config(config(
            1,
            vec![
                task_wire("t1", 60, 1_000, json!({ "host": "a.com", "port": 443 })),
                task_wire("t2", 60, 1_000, json!({ "host": "b.com", "port": 443 })),
                task_wire("t3", 30, 1_000, json!({ "host": "c.com", "port": 80 })),
            ],
        ));

        assert_eq!(runner.task_count(), 3);
        assert_eq!(runner.group_count(), 2);

        runner.shutdown();
    }

    #[tokio::test]
    async fn apply_config_interval_change_moves_task_between_groups() {
        let (out_tx, _out_rx) = mpsc::channel(8);
        let mut runner = ProbeRunner::new(out_tx);

        runner.apply_config(config(
            1,
            vec![
                task_wire("t1", 60, 1_000, json!({ "host": "a.com", "port": 443 })),
                task_wire("t2", 60, 1_000, json!({ "host": "b.com", "port": 443 })),
            ],
        ));

        assert_eq!(runner.group_count(), 1);

        runner.apply_config(config(
            2,
            vec![
                task_wire("t1", 60, 1_000, json!({ "host": "a.com", "port": 443 })),
                task_wire("t2", 30, 1_000, json!({ "host": "b.com", "port": 443 })),
            ],
        ));

        assert_eq!(runner.task_count(), 2);
        assert_eq!(runner.group_count(), 2);
        assert_eq!(runner.task_interval("t1"), Some(Duration::from_secs(60)));
        assert_eq!(runner.task_interval("t2"), Some(Duration::from_secs(30)));

        runner.shutdown();
    }

    #[tokio::test]
    async fn apply_config_removes_empty_group() {
        let (out_tx, _out_rx) = mpsc::channel(8);
        let mut runner = ProbeRunner::new(out_tx);

        runner.apply_config(config(
            1,
            vec![
                task_wire("t1", 60, 1_000, json!({ "host": "a.com", "port": 443 })),
                task_wire("t2", 30, 1_000, json!({ "host": "b.com", "port": 80 })),
            ],
        ));
        assert_eq!(runner.group_count(), 2);

        runner.apply_config(config(
            2,
            vec![task_wire(
                "t1",
                60,
                1_000,
                json!({ "host": "a.com", "port": 443 }),
            )],
        ));

        assert_eq!(runner.task_count(), 1);
        assert_eq!(runner.group_count(), 1);
        assert!(!runner.has_task("t2"));

        runner.shutdown();
    }

    #[tokio::test]
    async fn shutdown_clears_tasks_and_current_rev() {
        let (out_tx, _out_rx) = mpsc::channel(8);
        let mut runner = ProbeRunner::new(out_tx);

        runner.apply_config(config(
            8,
            vec![task_wire(
                "task-1",
                5,
                1_000,
                json!({ "host": "example.com", "port": 443 }),
            )],
        ));
        runner.shutdown();

        assert_eq!(runner.current_rev, None);
        assert_eq!(runner.task_count(), 0);
        assert_eq!(runner.group_count(), 0);
    }
}
