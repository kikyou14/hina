use std::{
    collections::{HashMap, HashSet},
    time::Duration,
};

use anyhow::Context;
use serde_json::Value;
use url::Url;

use crate::protocol::{ProbeTaskKind, ProbeTaskWire};

use super::{
    family::{FamilyPolicy, IpFamily},
    tcp_raw::{MAX_PACKET_SIZE, min_packet_size},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TcpMode {
    /// Full handshake through the OS stack; reports reachability and handshake time.
    Connect { family: FamilyPolicy },
    /// Raw SYNs of an exact IP packet size; reports latency, loss and jitter.
    Syn { family: IpFamily, packet_size: u16 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TracerouteMode {
    Icmp {
        family: FamilyPolicy,
    },
    TcpSizePair {
        family: IpFamily,
        port: u16,
        packet_sizes: [u16; 2],
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProbeTarget {
    Icmp {
        host: String,
        family: FamilyPolicy,
    },
    Tcp {
        host: String,
        port: u16,
        mode: TcpMode,
    },
    Http {
        url: Url,
    },
    Traceroute {
        host: String,
        mode: TracerouteMode,
    },
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
        ProbeTaskKind::Icmp => {
            let host = extract_host(&task.target)?;
            let family = FamilyPolicy::parse(&task.target, &host)?;
            ProbeTarget::Icmp { host, family }
        }
        ProbeTaskKind::Traceroute => {
            let host = extract_host(&task.target)?;
            let family = FamilyPolicy::parse(&task.target, &host)?;
            let mode = parse_traceroute_mode(&task.target, family)?;
            ProbeTarget::Traceroute { host, mode }
        }
        ProbeTaskKind::Tcp => {
            let host = extract_host(&task.target)?;
            let port = parse_port(&task.target)?;
            let family = FamilyPolicy::parse(&task.target, &host)?;
            // A packet size selects raw SYN mode, as it did before `family` existed.
            let mode = match task.target.get("packetSize") {
                None => TcpMode::Connect { family },
                Some(value) => {
                    let family = family.raw_tcp_family();
                    TcpMode::Syn {
                        family,
                        packet_size: parse_packet_size(value, family)?,
                    }
                }
            };
            ProbeTarget::Tcp { host, port, mode }
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

fn parse_traceroute_mode(target: &Value, family: FamilyPolicy) -> anyhow::Result<TracerouteMode> {
    let protocol = target
        .get("protocol")
        .and_then(Value::as_str)
        .map(str::trim);

    match protocol {
        None | Some("") | Some("icmp") => Ok(TracerouteMode::Icmp { family }),
        Some("tcp") => {
            let port = parse_port(target)?;
            let family = family.raw_tcp_family();

            let sizes = target
                .get("packetSizes")
                .and_then(Value::as_array)
                .context("missing target.packetSizes")?;
            if sizes.len() != 2 {
                anyhow::bail!("target.packetSizes must contain exactly two sizes");
            }

            let mut packet_sizes = [
                parse_packet_size(&sizes[0], family)?,
                parse_packet_size(&sizes[1], family)?,
            ];
            if packet_sizes[0] == packet_sizes[1] {
                anyhow::bail!("packet sizes must differ");
            }
            packet_sizes.sort_unstable();

            Ok(TracerouteMode::TcpSizePair {
                family,
                port,
                packet_sizes,
            })
        }
        Some(other) => anyhow::bail!("unsupported traceroute protocol: {other}"),
    }
}

fn parse_port(target: &Value) -> anyhow::Result<u16> {
    let port = target
        .get("port")
        .and_then(Value::as_u64)
        .context("missing target.port")?;
    u16::try_from(port)
        .ok()
        .filter(|port| *port != 0)
        .context("invalid target.port")
}

/// Total IP packet size, from a bare SYN of `family` up to `MAX_PACKET_SIZE`.
fn parse_packet_size(value: &Value, family: IpFamily) -> anyhow::Result<u16> {
    let size = value
        .as_u64()
        .and_then(|size| u16::try_from(size).ok())
        .context("invalid packet size")?;
    if !(min_packet_size(family)..=MAX_PACKET_SIZE).contains(&size) {
        anyhow::bail!("packet size out of range");
    }
    Ok(size)
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
