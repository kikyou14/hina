use std::{
    collections::{HashSet, VecDeque},
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use serde_json::Value;
use tokio::{net::lookup_host, task::JoinSet};

use super::{clamp_error, outcome::ProbeOutcome, remaining_until};

const MAX_TCP_ADDRS: usize = 8;
const TCP_CONNECT_IN_FLIGHT: usize = 2;
const TCP_FALLBACK_DELAY: Duration = Duration::from_millis(250);

#[derive(Debug)]
struct TcpDnsError {
    code: &'static str,
    message: String,
}

impl std::fmt::Display for TcpDnsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for TcpDnsError {}

pub(crate) async fn probe(host: &str, port: u16, deadline: tokio::time::Instant) -> ProbeOutcome {
    let remaining = remaining_until(deadline);
    if remaining.is_zero() {
        return tcp_probe_error(
            "timeout",
            host,
            port,
            &[],
            0,
            Some(tcp_last_error(None, "timeout", None, "timeout")),
            None,
        );
    }

    let addrs = match resolve_tcp_addrs(host, port, deadline).await {
        Ok(addrs) => addrs,
        Err(err) => {
            let (code, message) = err
                .downcast_ref::<TcpDnsError>()
                .map(|dns| (dns.code, clamp_error(&dns.message)))
                .unwrap_or(("dns_lookup_failed", clamp_error(&err.to_string())));
            let last_error = tcp_last_error(None, code, None, &message);
            return tcp_probe_error(code, host, port, &[], 0, Some(last_error), None);
        }
    };

    tracing::debug!(host = %host, port = port, addrs = ?addrs, "tcp probe resolved addrs");

    let has_v4 = addrs.iter().any(SocketAddr::is_ipv4);
    let has_v6 = addrs.iter().any(SocketAddr::is_ipv6);

    let mut queue = VecDeque::from(addrs.clone());
    let mut join_set: JoinSet<(SocketAddr, Result<u64, std::io::Error>)> = JoinSet::new();

    let Some(first) = queue.pop_front() else {
        let last_error = tcp_last_error(None, "dns_no_records", None, "dns no records");
        return tcp_probe_error("dns_no_records", host, port, &[], 0, Some(last_error), None);
    };

    let mut attempted: u64 = 1;
    spawn_tcp_attempt(&mut join_set, first, deadline);

    let mut fallback_armed = !queue.is_empty();
    let fallback_sleep = tokio::time::sleep(TCP_FALLBACK_DELAY);
    tokio::pin!(fallback_sleep);

    let deadline_sleep = tokio::time::sleep_until(deadline);
    tokio::pin!(deadline_sleep);

    let mut last_error: Option<Value> = None;
    let mut ipv6_timeout_seen = false;
    let mut last_code = "connect_failed";

    loop {
        tokio::select! {
            _ = &mut deadline_sleep => {
                join_set.abort_all();
                let last_error = last_error.or_else(|| Some(tcp_last_error(None, "timeout", None, "timeout")));
                let hint = dual_stack_timeout_hint(has_v4, has_v6, ipv6_timeout_seen);
                return tcp_probe_error("timeout", host, port, &addrs, attempted, last_error, hint);
            }

            _ = &mut fallback_sleep, if fallback_armed && join_set.len() < TCP_CONNECT_IN_FLIGHT && !queue.is_empty() => {
                let addr = queue.pop_front().expect("queue must not be empty");
                attempted = attempted.saturating_add(1);
                spawn_tcp_attempt(&mut join_set, addr, deadline);
                fallback_armed = false;
            }

            next = join_set.join_next() => {
                let Some(next) = next else {
                    break;
                };

                match next {
                    Ok((addr, Ok(latency_ms))) => {
                        tracing::debug!(host = %host, port = port, addr = %addr, latency_ms = latency_ms, "tcp probe connected");
                        join_set.abort_all();
                        return ProbeOutcome::success(latency_ms);
                    }
                    Ok((addr, Err(err))) => {
                        let code = classify_tcp_io_error(&err);
                        last_code = code;
                        if addr.is_ipv6() && code == "timeout" {
                            ipv6_timeout_seen = true;
                        }
                        last_error = Some(tcp_last_error(
                            Some(addr),
                            code,
                            err.raw_os_error(),
                            &clamp_error(&err.to_string()),
                        ));
                        tracing::debug!(host = %host, port = port, addr = %addr, code = %code, error = %err, "tcp probe connect failed");
                    }
                    Err(err) => {
                        last_code = "connect_failed";
                        last_error = Some(tcp_last_error(None, "connect_failed", None, &clamp_error(&err.to_string())));
                    }
                }

                fallback_armed = false;
                while join_set.len() < TCP_CONNECT_IN_FLIGHT {
                    if remaining_until(deadline).is_zero() {
                        break;
                    }

                    let Some(next_addr) = queue.pop_front() else {
                        break;
                    };
                    attempted = attempted.saturating_add(1);
                    spawn_tcp_attempt(&mut join_set, next_addr, deadline);
                }
            }
        }
    }

    let code = if remaining_until(deadline).is_zero() {
        "timeout"
    } else {
        last_code
    };
    let hint = dual_stack_timeout_hint(has_v4, has_v6, ipv6_timeout_seen);
    let last_error =
        last_error.or_else(|| Some(tcp_last_error(None, code, None, "connect_failed")));
    tcp_probe_error(code, host, port, &addrs, attempted, last_error, hint)
}

pub(crate) fn classify_tcp_io_error(err: &std::io::Error) -> &'static str {
    match err.kind() {
        std::io::ErrorKind::TimedOut => "timeout",
        std::io::ErrorKind::ConnectionRefused => "connection_refused",
        std::io::ErrorKind::PermissionDenied => "permission_denied",
        _ => "connect_failed",
    }
}

pub(crate) async fn resolve_tcp_addrs(
    host: &str,
    port: u16,
    deadline: tokio::time::Instant,
) -> anyhow::Result<Vec<SocketAddr>> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }

    let remaining = remaining_until(deadline);
    if remaining.is_zero() {
        return Err(anyhow::Error::new(TcpDnsError {
            code: "timeout",
            message: "dns lookup timeout".to_string(),
        }));
    }

    let addrs = tokio::time::timeout_at(deadline, lookup_host((host, port)))
        .await
        .map_err(|_| {
            anyhow::Error::new(TcpDnsError {
                code: "timeout",
                message: "dns lookup timeout".to_string(),
            })
        })?
        .map_err(|err| {
            anyhow::Error::new(TcpDnsError {
                code: "dns_lookup_failed",
                message: err.to_string(),
            })
        })?;

    let mut seen = HashSet::<SocketAddr>::new();
    let mut v4 = Vec::<SocketAddr>::new();
    let mut v6 = Vec::<SocketAddr>::new();

    for addr in addrs {
        if !seen.insert(addr) {
            continue;
        }

        if addr.is_ipv4() {
            v4.push(addr);
        } else {
            v6.push(addr);
        }
    }

    if v4.is_empty() && v6.is_empty() {
        return Err(anyhow::Error::new(TcpDnsError {
            code: "dns_no_records",
            message: "dns no records".to_string(),
        }));
    }

    let mut out = Vec::<SocketAddr>::with_capacity((v4.len() + v6.len()).min(MAX_TCP_ADDRS));
    let mut v4_index = 0usize;
    let mut v6_index = 0usize;
    while out.len() < MAX_TCP_ADDRS {
        let mut pushed = false;
        if v6_index < v6.len() {
            out.push(v6[v6_index]);
            v6_index += 1;
            pushed = true;
            if out.len() >= MAX_TCP_ADDRS {
                break;
            }
        }
        if v4_index < v4.len() {
            out.push(v4[v4_index]);
            v4_index += 1;
            pushed = true;
        }
        if !pushed {
            break;
        }
    }

    Ok(out)
}

async fn tcp_connect_once(
    addr: SocketAddr,
    deadline: tokio::time::Instant,
) -> Result<u64, std::io::Error> {
    if remaining_until(deadline).is_zero() {
        return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timeout"));
    }

    let start = std::time::Instant::now();
    let connect_fut = tokio::net::TcpStream::connect(addr);
    let stream = match tokio::time::timeout_at(deadline, connect_fut).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(err)) => return Err(err),
        Err(_) => return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, "timeout")),
    };
    drop(stream);

    Ok(start.elapsed().as_millis().min(u64::MAX as u128) as u64)
}

fn spawn_tcp_attempt(
    join_set: &mut JoinSet<(SocketAddr, Result<u64, std::io::Error>)>,
    addr: SocketAddr,
    deadline: tokio::time::Instant,
) {
    join_set.spawn(async move {
        let result = tcp_connect_once(addr, deadline).await;
        (addr, result)
    });
}

fn dual_stack_timeout_hint(
    has_v4: bool,
    has_v6: bool,
    ipv6_timeout_seen: bool,
) -> Option<&'static str> {
    if has_v4 && has_v6 && ipv6_timeout_seen {
        Some("ipv6_timeout")
    } else {
        None
    }
}

fn tcp_probe_error(
    code: &'static str,
    host: &str,
    port: u16,
    addrs: &[SocketAddr],
    attempted: u64,
    last_error: Option<Value>,
    hint: Option<&'static str>,
) -> ProbeOutcome {
    let mut extra = serde_json::json!({
        "kind": "tcp",
        "host": host,
        "port": port,
        "addrs": addrs.iter().map(|addr| addr.to_string()).collect::<Vec<_>>(),
        "attempted": attempted,
    });
    if let Some(last_error) = last_error {
        extra["last_error"] = last_error;
    }
    if let Some(hint) = hint {
        extra["hint"] = Value::String(hint.to_string());
    }

    ProbeOutcome::failure(code).with_extra(extra)
}

fn tcp_last_error(
    addr: Option<SocketAddr>,
    kind: &'static str,
    os_error: Option<i32>,
    message: &str,
) -> Value {
    let mut object = serde_json::json!({
        "kind": kind,
        "message": clamp_error(message),
    });
    if let Some(addr) = addr {
        object["addr"] = Value::String(addr.to_string());
    }
    if let Some(os_error) = os_error {
        object["os_error"] = serde_json::json!(os_error as i64);
    }

    object
}
