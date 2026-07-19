use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use anyhow::Context;
use serde_json::Value;
use url::Url;

use crate::protocol::{ProbeTaskKind, ProbeTaskWire};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TracerouteMode {
    Icmp,
    TcpSizePair { port: u16, packet_sizes: [u16; 2] },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProbeTarget {
    Icmp { host: String },
    Tcp { host: String, port: u16 },
    Http { url: Url },
    Traceroute { host: String, mode: TracerouteMode },
}

pub(crate) const TRACEROUTE_TCP_MIN_PACKET_SIZE: u16 = 40;
pub(crate) const TRACEROUTE_TCP_MAX_PACKET_SIZE: u16 = 1500;

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
            mode: parse_traceroute_mode(&task.target)?,
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

fn parse_traceroute_mode(target: &Value) -> anyhow::Result<TracerouteMode> {
    let protocol = target
        .get("protocol")
        .and_then(Value::as_str)
        .map(str::trim);

    match protocol {
        None | Some("") | Some("icmp") => Ok(TracerouteMode::Icmp),
        Some("tcp") => {
            let port_u64 = target
                .get("port")
                .and_then(Value::as_u64)
                .context("missing target.port")?;
            let port = u16::try_from(port_u64)
                .ok()
                .filter(|port| *port != 0)
                .context("invalid target.port")?;

            let sizes = target
                .get("packetSizes")
                .and_then(Value::as_array)
                .context("missing target.packetSizes")?;
            if sizes.len() != 2 {
                anyhow::bail!("target.packetSizes must contain exactly two sizes");
            }

            let mut packet_sizes = [0u16; 2];
            for (index, value) in sizes.iter().enumerate() {
                let raw = value.as_u64().context("invalid packet size")?;
                let size = u16::try_from(raw).context("invalid packet size")?;
                if !(TRACEROUTE_TCP_MIN_PACKET_SIZE..=TRACEROUTE_TCP_MAX_PACKET_SIZE)
                    .contains(&size)
                {
                    anyhow::bail!("packet size out of range");
                }
                packet_sizes[index] = size;
            }

            if packet_sizes[0] == packet_sizes[1] {
                anyhow::bail!("packet sizes must differ");
            }
            packet_sizes.sort_unstable();

            Ok(TracerouteMode::TcpSizePair { port, packet_sizes })
        }
        Some(other) => anyhow::bail!("unsupported traceroute protocol: {other}"),
    }
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
