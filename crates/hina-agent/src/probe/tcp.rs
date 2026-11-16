use std::{
    collections::VecDeque,
    net::{IpAddr, SocketAddr},
    time::Duration,
};

use serde_json::Value;
use tokio::task::JoinSet;

use super::{
    clamp_error,
    family::{FamilyPolicy, IpFamily, ResolveError, resolve},
    outcome::ProbeOutcome,
    remaining_until,
    task::TcpMode,
};

const MAX_TCP_ADDRS: usize = 8;
const TCP_CONNECT_IN_FLIGHT: usize = 2;
const TCP_FALLBACK_DELAY: Duration = Duration::from_millis(250);

pub(crate) async fn probe(
    host: &str,
    port: u16,
    mode: TcpMode,
    deadline: tokio::time::Instant,
) -> ProbeOutcome {
    match mode {
        TcpMode::Connect { family } => probe_connect(host, port, family, deadline).await,
        TcpMode::Syn {
            family,
            packet_size,
        } => super::tcp_syn::probe(host, port, family, packet_size, deadline).await,
    }
}

async fn probe_connect(
    host: &str,
    port: u16,
    family: FamilyPolicy,
    deadline: tokio::time::Instant,
) -> ProbeOutcome {
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

    let addrs = match resolve_tcp_addrs(host, port, family, deadline).await {
        Ok(addrs) => addrs,
        Err(err) => {
            let last_error = tcp_last_error(None, err.code, None, &err.detail);
            return tcp_probe_error(err.code, host, port, &[], 0, Some(last_error), None);
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
                        // Under the automatic family a failing IPv6 path silently falls back to
                        // IPv4; recording the address keeps that visible in the results.
                        return ProbeOutcome::success(latency_ms).with_extra(serde_json::json!({
                            "kind": "tcp",
                            "family": IpFamily::of(addr.ip()).label(),
                            "addr": addr.to_string(),
                        }));
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
    if super::tcp_raw::is_message_too_long(err) {
        return "packet_too_large";
    }
    match err.kind() {
        std::io::ErrorKind::TimedOut => "timeout",
        std::io::ErrorKind::ConnectionRefused => "connection_refused",
        std::io::ErrorKind::PermissionDenied => "permission_denied",
        std::io::ErrorKind::HostUnreachable | std::io::ErrorKind::NetworkUnreachable => {
            "dest_unreachable"
        }
        _ => "connect_failed",
    }
}

/// Connect order for `host`: IPv6 and IPv4 alternate, IPv6 first, capped at `MAX_TCP_ADDRS`.
pub(crate) async fn resolve_tcp_addrs(
    host: &str,
    port: u16,
    family: FamilyPolicy,
    deadline: tokio::time::Instant,
) -> Result<Vec<SocketAddr>, ResolveError> {
    let addrs = resolve(host, family, deadline).await?;
    Ok(interleave_families(addrs)
        .into_iter()
        .map(|ip| SocketAddr::new(ip, port))
        .collect())
}

fn interleave_families(addrs: Vec<IpAddr>) -> Vec<IpAddr> {
    let (v6, v4): (Vec<IpAddr>, Vec<IpAddr>) = addrs.into_iter().partition(IpAddr::is_ipv6);
    let mut v6 = v6.into_iter();
    let mut v4 = v4.into_iter();
    let mut out = Vec::with_capacity(MAX_TCP_ADDRS);
    while out.len() < MAX_TCP_ADDRS {
        let (next_v6, next_v4) = (v6.next(), v4.next());
        if next_v6.is_none() && next_v4.is_none() {
            break;
        }
        out.extend(next_v6);
        if out.len() < MAX_TCP_ADDRS {
            out.extend(next_v4);
        }
    }
    out
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
    join_set.spawn(async move { (addr, tcp_connect_once(addr, deadline).await) });
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interleave_starts_with_ipv6_and_caps_the_list() {
        let v4 = |last: u8| IpAddr::from([192, 0, 2, last]);
        let v6 = |last: u16| IpAddr::from([0x2001, 0xdb8, 0, 0, 0, 0, 0, last]);

        assert_eq!(
            interleave_families(vec![v4(1), v4(2), v6(1)]),
            vec![v6(1), v4(1), v4(2)]
        );

        let many: Vec<IpAddr> = (1..=6).map(v4).chain((1..=6).map(v6)).collect();
        let ordered = interleave_families(many);
        assert_eq!(ordered.len(), MAX_TCP_ADDRS);
        assert_eq!(ordered[..4], [v6(1), v4(1), v6(2), v4(2)]);
    }
}
