use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use anyhow::Context;
use serde_json::Value;
use url::Url;

use crate::protocol::{ProbeTaskKind, ProbeTaskWire};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProbeTarget {
    Icmp { host: String },
    Tcp { host: String, port: u16 },
    Http { url: Url },
    Traceroute { host: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbeTaskSpec {
    pub(crate) id: String,
    pub(crate) interval: Duration,
    pub(crate) timeout: Duration,
    pub(crate) target: ProbeTarget,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NormalizeTaskIssue {
    InvalidTask { task_id: String, error: String },
    DuplicateTaskId { task_id: String },
}

#[derive(Debug, Clone)]
pub(crate) struct NormalizedTasks {
    pub(crate) desired: HashMap<String, ProbeTaskSpec>,
    pub(crate) issues: Vec<NormalizeTaskIssue>,
}

pub(crate) fn normalize_tasks(tasks: &[ProbeTaskWire]) -> NormalizedTasks {
    let mut desired = HashMap::<String, ProbeTaskSpec>::new();
    let mut issues = Vec::<NormalizeTaskIssue>::new();
    let mut seen_task_ids = HashSet::<String>::new();

    for task in tasks {
        if task.enabled == Some(false) {
            continue;
        }

        let spec = match parse_task(task) {
            Ok(spec) => spec,
            Err(err) => {
                issues.push(NormalizeTaskIssue::InvalidTask {
                    task_id: task.id.clone(),
                    error: err.to_string(),
                });
                continue;
            }
        };

        let id = spec.id.clone();
        if !seen_task_ids.insert(id.clone()) {
            issues.push(NormalizeTaskIssue::DuplicateTaskId { task_id: id });
            continue;
        }

        desired.insert(spec.id.clone(), spec);
    }

    NormalizedTasks { desired, issues }
}

pub(crate) fn parse_task(task: &ProbeTaskWire) -> anyhow::Result<ProbeTaskSpec> {
    let id = task.id.trim();
    if id.is_empty() {
        anyhow::bail!("missing id");
    }

    let interval_sec = task.interval_sec.clamp(1, 86_400);
    let timeout_ms = task.timeout_ms.clamp(100, 120_000);

    let interval = Duration::from_secs(interval_sec);
    let timeout = Duration::from_millis(timeout_ms);

    let target = match task.kind {
        ProbeTaskKind::Icmp => ProbeTarget::Icmp {
            host: extract_host(&task.target)?,
        },
        ProbeTaskKind::Traceroute => ProbeTarget::Traceroute {
            host: extract_host(&task.target)?,
        },
        ProbeTaskKind::Tcp => {
            let host = extract_host(&task.target)?;
            let port_u64 = task
                .target
                .get("port")
                .and_then(Value::as_u64)
                .context("missing target.port")?;
            let port = u16::try_from(port_u64).context("invalid target.port")?;
            if port == 0 {
                anyhow::bail!("invalid target.port");
            }
            ProbeTarget::Tcp { host, port }
        }
        ProbeTaskKind::Http => {
            let url_str = task
                .target
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .context("missing target.url")?;
            let url = Url::parse(url_str).context("invalid target.url")?;
            if !matches!(url.scheme(), "http" | "https") {
                anyhow::bail!("unsupported url.scheme");
            }
            ProbeTarget::Http { url }
        }
    };

    Ok(ProbeTaskSpec {
        id: id.to_string(),
        interval,
        timeout,
        target,
    })
}

fn extract_host(target: &Value) -> anyhow::Result<String> {
    target
        .get("host")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("missing target.host")
        .map(str::to_string)
}
