use std::{
    collections::{HashMap, HashSet},
    io,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use serde_json::Value;
use socket2::{Domain, Protocol, Socket, Type};
use tokio::{
    io::unix::AsyncFd,
    sync::Semaphore,
    task::{JoinSet, spawn_blocking},
};

use super::{
    clamp_error,
    family::{FamilyPolicy, IpFamily, ResolveError, resolve},
    outcome::ProbeOutcome,
    raw_socket::{async_recv_from, async_send_to, probe_origin_addr, transport_payload},
    remaining_until,
    task::TracerouteMode,
};

pub(crate) const TRACEROUTE_START_TTL: u8 = 1;
pub(crate) const TRACEROUTE_MAX_HOPS: u8 = 30;
pub(crate) const TRACEROUTE_QUERIES_PER_HOP: u8 = 1;
pub(crate) const TRACEROUTE_PER_HOP_TIMEOUT: Duration = Duration::from_millis(2000);

pub(crate) const TRACEROUTE_MIN_TIMEOUT: Duration = Duration::from_millis(
    TRACEROUTE_MAX_HOPS as u64 * TRACEROUTE_PER_HOP_TIMEOUT.as_millis() as u64 + 5000,
);

const TRACEROUTE_RDNS_LOOKUP_TIMEOUT: Duration = Duration::from_millis(200);
pub(crate) const TRACEROUTE_RDNS_BUDGET_CAP: Duration = Duration::from_millis(800);
const TRACEROUTE_RDNS_MAX_CONCURRENCY: usize = 8;

// ICMP message types
const ICMP_ECHO_REPLY: u8 = 0;
const ICMP_DEST_UNREACHABLE: u8 = 3;
const ICMP_ECHO_REQUEST: u8 = 8;
const ICMP_TIME_EXCEEDED: u8 = 11;

// ICMPv6 message types
const ICMPV6_DEST_UNREACHABLE: u8 = 1;
const ICMPV6_TIME_EXCEEDED: u8 = 3;
const ICMPV6_ECHO_REQUEST: u8 = 128;
const ICMPV6_ECHO_REPLY: u8 = 129;

// Minimum sizes for parsing received ICMP packets
pub(crate) const ICMP_HEADER_LEN: usize = 8;
pub(crate) const IP_HEADER_MIN_LEN: usize = 20;
const IPV6_HEADER_LEN: usize = 40;
const IPV6_NEXT_HEADER_OFFSET: usize = 6;
const IPPROTO_ICMPV6: u8 = 58;

#[derive(Debug, Clone)]
pub(crate) struct HopResult {
    pub(crate) ttl: u8,
    pub(crate) addr: Option<IpAddr>,
    pub(crate) rtt: Option<Duration>,
}

#[derive(Debug)]
pub(crate) struct RawTracerouteResult {
    pub(crate) target: String,
    pub(crate) target_ip: IpAddr,
    pub(crate) hops: Vec<HopResult>,
    pub(crate) destination_reached: bool,
    pub(crate) total_duration: Duration,
}

#[derive(Debug)]
pub(crate) struct TracerouteProbeError {
    pub(crate) code: &'static str,
    pub(crate) detail: String,
}

impl From<ResolveError> for TracerouteProbeError {
    fn from(err: ResolveError) -> Self {
        Self {
            code: err.code,
            detail: err.detail,
        }
    }
}

pub(crate) async fn probe(
    target: &str,
    mode: &TracerouteMode,
    deadline: tokio::time::Instant,
) -> ProbeOutcome {
    match mode {
        TracerouteMode::Icmp { family } => probe_icmp(target, *family, deadline).await,
        TracerouteMode::TcpSizePair {
            family,
            port,
            packet_sizes,
        } => super::traceroute_tcp::probe(target, *family, *port, *packet_sizes, deadline).await,
    }
}

async fn probe_icmp(
    target: &str,
    family: FamilyPolicy,
    deadline: tokio::time::Instant,
) -> ProbeOutcome {
    match run_traceroute(target, family, deadline).await {
        Ok(result) => {
            let outcome = if result.destination_reached {
                ProbeOutcome::success(0).with_latency(result.latency_ms)
            } else {
                ProbeOutcome::failure("not_reached").with_latency(result.latency_ms)
            };
            outcome.with_extra(result.extra)
        }
        Err(err) => ProbeOutcome::failure(err.code)
            .with_extra(traceroute_error_extra_v1(target, &err.detail)),
    }
}

struct TracerouteRunOutcome {
    destination_reached: bool,
    latency_ms: Option<u64>,
    extra: Value,
}

async fn run_traceroute(
    target: &str,
    family: FamilyPolicy,
    deadline: tokio::time::Instant,
) -> Result<TracerouteRunOutcome, TracerouteProbeError> {
    let target_ip = resolve_traceroute_ip(target, family, deadline).await?;

    let overall_timeout = remaining_until(deadline);
    if overall_timeout.is_zero() {
        return Err(TracerouteProbeError {
            code: "timeout",
            detail: "timeout".to_string(),
        });
    }

    let raw_result = run_raw_traceroute(
        target,
        target_ip,
        TRACEROUTE_PER_HOP_TIMEOUT,
        overall_timeout,
    )
    .await?;

    let origin_ip = probe_origin_addr(target_ip).await;

    // Collect unique IPs for rDNS
    let mut uniq_ips = HashSet::<IpAddr>::new();
    for hop in &raw_result.hops {
        if let Some(ip) = hop.addr {
            uniq_ips.insert(ip);
        }
    }
    let mut ips = uniq_ips.into_iter().collect::<Vec<_>>();
    ips.sort_by_key(|ip| ip.to_string());

    let rdns_deadline = tokio::time::Instant::now() + TRACEROUTE_RDNS_BUDGET_CAP;
    let rdns = rdns_best_effort(ips, rdns_deadline).await;

    let latency_ms = round_ms(
        raw_result
            .hops
            .iter()
            .rev()
            .find_map(|h| h.rtt.map(|d| d.as_secs_f64() * 1000.0)),
    );

    Ok(TracerouteRunOutcome {
        destination_reached: raw_result.destination_reached,
        latency_ms,
        extra: traceroute_extra_v1(&raw_result, origin_ip, &rdns),
    })
}

fn create_icmp_raw_socket(target_ip: IpAddr) -> Result<Socket, TracerouteProbeError> {
    let (domain, protocol) = match target_ip {
        IpAddr::V4(_) => (Domain::IPV4, Protocol::ICMPV4),
        IpAddr::V6(_) => (Domain::IPV6, Protocol::ICMPV6),
    };
    let s = Socket::new(domain, Type::RAW, Some(protocol)).map_err(|e| TracerouteProbeError {
        code: if is_permission_error(&e) {
            "permission_denied"
        } else {
            "socket_error"
        },
        detail: format!("failed to create ICMP socket: {e}"),
    })?;
    s.set_nonblocking(true).map_err(|e| TracerouteProbeError {
        code: "socket_error",
        detail: format!("set_nonblocking: {e}"),
    })?;

    Ok(s)
}

pub(crate) fn is_permission_error(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::AddrNotAvailable
    ) || matches!(e.raw_os_error(), Some(1) | Some(13))
}

async fn run_raw_traceroute(
    target: &str,
    target_ip: IpAddr,
    probe_timeout: Duration,
    overall_timeout: Duration,
) -> Result<RawTracerouteResult, TracerouteProbeError> {
    let socket = create_icmp_raw_socket(target_ip)?;
    let fd = AsyncFd::new(socket).map_err(|e| TracerouteProbeError {
        code: "socket_error",
        detail: format!("AsyncFd: {e}"),
    })?;
    let ident: u16 = fastrand::u16(..);
    let start = std::time::Instant::now();
    let overall_deadline = tokio::time::Instant::now() + overall_timeout;

    let mut hops = Vec::with_capacity(TRACEROUTE_MAX_HOPS as usize);
    let mut destination_reached = false;
    let mut seq: u16 = 0;

    for ttl in TRACEROUTE_START_TTL..=TRACEROUTE_MAX_HOPS {
        if remaining_until(overall_deadline).is_zero() {
            break;
        }

        seq = seq.wrapping_add(1);
        let hop_timeout = probe_timeout.min(remaining_until(overall_deadline));

        match probe_one_hop(&fd, target_ip, ttl, ident, seq, hop_timeout).await {
            HopOutcome::Reply { addr, rtt } => {
                hops.push(HopResult {
                    ttl,
                    addr: Some(addr),
                    rtt: Some(rtt),
                });
                if addr == target_ip {
                    destination_reached = true;
                    break;
                }
            }
            HopOutcome::TimeExceeded { addr, rtt } => {
                hops.push(HopResult {
                    ttl,
                    addr: Some(addr),
                    rtt: Some(rtt),
                });
            }
            HopOutcome::DestUnreachable { addr, rtt } => {
                hops.push(HopResult {
                    ttl,
                    addr: Some(addr),
                    rtt: Some(rtt),
                });
                if addr == target_ip {
                    destination_reached = true;
                }
                break;
            }
            // No route fails every hop the same way; report it instead of a trace of timeouts.
            HopOutcome::Unreachable(e) => {
                return Err(TracerouteProbeError {
                    code: "network_unreachable",
                    detail: format!("failed to send probe: {e}"),
                });
            }
            HopOutcome::Timeout => {
                hops.push(HopResult {
                    ttl,
                    addr: None,
                    rtt: None,
                });
            }
            HopOutcome::Error(e) => {
                tracing::debug!(ttl, error = %e, "traceroute hop error");
                hops.push(HopResult {
                    ttl,
                    addr: None,
                    rtt: None,
                });
            }
        }
    }

    Ok(RawTracerouteResult {
        target: target.to_string(),
        target_ip,
        hops,
        destination_reached,
        total_duration: start.elapsed(),
    })
}

enum HopOutcome {
    Reply { addr: IpAddr, rtt: Duration },
    TimeExceeded { addr: IpAddr, rtt: Duration },
    DestUnreachable { addr: IpAddr, rtt: Duration },
    Unreachable(io::Error),
    Timeout,
    Error(io::Error),
}

async fn probe_one_hop(
    fd: &AsyncFd<Socket>,
    target_ip: IpAddr,
    ttl: u8,
    ident: u16,
    seq: u16,
    timeout: Duration,
) -> HopOutcome {
    let v6 = target_ip.is_ipv6();

    // Set TTL (hop limit for IPv6)
    let set_ttl = if v6 {
        fd.get_ref().set_unicast_hops_v6(ttl as u32)
    } else {
        fd.get_ref().set_ttl_v4(ttl as u32)
    };
    if let Err(e) = set_ttl {
        return HopOutcome::Error(e);
    }

    // Build & send ICMP Echo Request
    let packet = build_echo_request(v6, ident, seq);
    let dest = socket2::SockAddr::from(SocketAddr::new(target_ip, 0));

    let send_time = std::time::Instant::now();

    if let Err(e) = async_send_to(fd, &packet, &dest).await {
        if matches!(
            e.kind(),
            io::ErrorKind::NetworkUnreachable | io::ErrorKind::HostUnreachable
        ) {
            return HopOutcome::Unreachable(e);
        }
        return HopOutcome::Error(e);
    }

    // Receive loop: keep reading until we get our packet or timeout
    let deadline = tokio::time::Instant::now() + timeout;
    let mut buf = [0u8; 512];
    let mut recv_errors = 0u8;

    loop {
        let remaining = remaining_until(deadline);
        if remaining.is_zero() {
            return HopOutcome::Timeout;
        }

        let recv_result = tokio::time::timeout(remaining, async_recv_from(fd, &mut buf)).await;

        let (n, from_addr) = match recv_result {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                recv_errors += 1;
                if recv_errors >= 3 {
                    return HopOutcome::Error(e);
                }
                continue;
            }
            Err(_) => return HopOutcome::Timeout,
        };

        let rtt = send_time.elapsed();
        let icmp_data = transport_payload(IpFamily::of(target_ip), &buf[..n]);

        match classify_reply(icmp_data, v6, ident, seq) {
            Some(ReplyKind::EchoReply) => {
                return HopOutcome::Reply {
                    addr: from_addr,
                    rtt,
                };
            }
            Some(ReplyKind::TimeExceeded) => {
                return HopOutcome::TimeExceeded {
                    addr: from_addr,
                    rtt,
                };
            }
            Some(ReplyKind::DestUnreachable) => {
                return HopOutcome::DestUnreachable {
                    addr: from_addr,
                    rtt,
                };
            }
            None => {}
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReplyKind {
    EchoReply,
    TimeExceeded,
    DestUnreachable,
}

/// Classifies an ICMP or ICMPv6 message, starting at its header, that answers our probe.
fn classify_reply(icmp_data: &[u8], v6: bool, ident: u16, seq: u16) -> Option<ReplyKind> {
    if icmp_data.len() < ICMP_HEADER_LEN {
        return None;
    }
    let kind = match (v6, icmp_data[0]) {
        (false, ICMP_ECHO_REPLY) | (true, ICMPV6_ECHO_REPLY) => {
            return echo_matches(icmp_data, ident, seq).then_some(ReplyKind::EchoReply);
        }
        (false, ICMP_TIME_EXCEEDED) | (true, ICMPV6_TIME_EXCEEDED) => ReplyKind::TimeExceeded,
        (false, ICMP_DEST_UNREACHABLE) | (true, ICMPV6_DEST_UNREACHABLE) => {
            ReplyKind::DestUnreachable
        }
        _ => return None,
    };
    match_embedded_probe(icmp_data, v6, ident, seq).then_some(kind)
}

fn echo_matches(echo: &[u8], ident: u16, seq: u16) -> bool {
    echo[4..6] == ident.to_be_bytes() && echo[6..8] == seq.to_be_bytes()
}

fn match_embedded_probe(icmp_data: &[u8], v6: bool, ident: u16, seq: u16) -> bool {
    // After the 8-byte ICMP header comes the original IP header + ICMP fragment.
    let Some(inner) = icmp_data.get(ICMP_HEADER_LEN..) else {
        return false;
    };
    let (header_len, echo_request) = if v6 {
        // Our probes carry no extension headers, so the echo follows the fixed header.
        if inner.get(IPV6_NEXT_HEADER_OFFSET) != Some(&IPPROTO_ICMPV6) {
            return false;
        }
        (IPV6_HEADER_LEN, ICMPV6_ECHO_REQUEST)
    } else {
        let ihl = inner.first().map_or(0, |b| (b & 0x0F) as usize * 4);
        if ihl < IP_HEADER_MIN_LEN {
            return false;
        }
        (ihl, ICMP_ECHO_REQUEST)
    };
    inner
        .get(header_len..header_len + ICMP_HEADER_LEN)
        .is_some_and(|echo| echo[0] == echo_request && echo_matches(echo, ident, seq))
}

fn build_echo_request(v6: bool, ident: u16, seq: u16) -> [u8; 8] {
    let mut pkt = [0u8; 8];
    pkt[0] = if v6 {
        ICMPV6_ECHO_REQUEST
    } else {
        ICMP_ECHO_REQUEST
    };
    pkt[1] = 0; // code
    pkt[4..6].copy_from_slice(&ident.to_be_bytes());
    pkt[6..8].copy_from_slice(&seq.to_be_bytes());

    // The kernel fills the ICMPv6 checksum: it covers a pseudo-header with the source address.
    if !v6 {
        let cksum = icmp_checksum(&pkt);
        pkt[2..4].copy_from_slice(&cksum.to_be_bytes());
    }
    pkt
}

fn icmp_checksum(data: &[u8]) -> u16 {
    let mut sum: u32 = 0;
    let mut i = 0;
    while i + 1 < data.len() {
        sum += u16::from_be_bytes([data[i], data[i + 1]]) as u32;
        i += 2;
    }
    if i < data.len() {
        sum += (data[i] as u32) << 8;
    }
    while sum >> 16 != 0 {
        sum = (sum & 0xFFFF) + (sum >> 16);
    }
    !(sum as u16)
}

async fn resolve_traceroute_ip(
    host: &str,
    family: FamilyPolicy,
    deadline: tokio::time::Instant,
) -> Result<IpAddr, TracerouteProbeError> {
    let addrs = resolve(host, family, deadline).await?;
    pick_traceroute_addr(&addrs).ok_or_else(|| TracerouteProbeError {
        code: "dns_no_records",
        detail: "no address records found".to_string(),
    })
}

/// Dual-stack hosts keep tracing over IPv4, as they did before IPv6 support, unless `family` asks
/// for IPv6; IPv6 is used when the host has no A record.
fn pick_traceroute_addr(addrs: &[IpAddr]) -> Option<IpAddr> {
    addrs
        .iter()
        .find(|ip| ip.is_ipv4())
        .or(addrs.first())
        .copied()
}

fn reverse_dns_blocking(ip: IpAddr) -> Option<String> {
    let sa = SocketAddr::new(ip, 0);
    let sa = socket2::SockAddr::from(sa);
    let mut host_buf = [0u8; 256];

    let rc = unsafe {
        libc::getnameinfo(
            sa.as_ptr().cast::<libc::sockaddr>(),
            sa.len() as libc::socklen_t,
            host_buf.as_mut_ptr().cast::<libc::c_char>(),
            host_buf.len() as libc::socklen_t,
            std::ptr::null_mut(),
            0,
            0,
        )
    };

    if rc != 0 {
        return None;
    }

    let cstr = unsafe { std::ffi::CStr::from_ptr(host_buf.as_ptr().cast::<std::ffi::c_char>()) };
    let hostname = cstr.to_string_lossy();

    let ip_str = ip.to_string();
    if *hostname == ip_str {
        return None;
    }

    Some(hostname.into_owned())
}

pub(crate) async fn rdns_best_effort(
    ips: Vec<IpAddr>,
    deadline: tokio::time::Instant,
) -> HashMap<IpAddr, String> {
    if ips.is_empty() || remaining_until(deadline).is_zero() {
        return HashMap::new();
    }

    let sem = Arc::new(Semaphore::new(TRACEROUTE_RDNS_MAX_CONCURRENCY));
    let mut join_set: JoinSet<(IpAddr, Option<String>)> = JoinSet::new();

    for ip in ips {
        if remaining_until(deadline).is_zero() {
            break;
        }

        let permit = match tokio::time::timeout_at(deadline, sem.clone().acquire_owned()).await {
            Ok(Ok(permit)) => permit,
            _ => break,
        };

        join_set.spawn(async move {
            let _permit = permit;
            let hostname = match tokio::time::timeout(
                TRACEROUTE_RDNS_LOOKUP_TIMEOUT,
                spawn_blocking(move || reverse_dns_blocking(ip)),
            )
            .await
            {
                Ok(Ok(name)) => name,
                _ => None,
            };
            (ip, hostname)
        });
    }

    let mut out = HashMap::<IpAddr, String>::new();
    loop {
        let remaining = remaining_until(deadline);
        if remaining.is_zero() {
            join_set.abort_all();
            break;
        }

        let next = tokio::time::timeout(remaining, join_set.join_next()).await;
        match next {
            Ok(Some(Ok((ip, Some(hostname))))) => {
                out.insert(ip, hostname);
            }
            Ok(Some(Ok((_ip, None)))) => {}
            Ok(Some(Err(_))) => {}
            Ok(None) => break,
            Err(_) => {
                join_set.abort_all();
                break;
            }
        }
    }

    out
}

pub(crate) fn round_ms(value: Option<f64>) -> Option<u64> {
    let value = value?;
    if !value.is_finite() || value < 0.0 {
        return None;
    }

    let rounded = value.round();
    if rounded >= u64::MAX as f64 {
        return Some(u64::MAX);
    }

    Some(rounded as u64)
}

fn traceroute_error_extra_v1(target: &str, detail: &str) -> Value {
    serde_json::json!({
        "kind": "traceroute",
        "v": 1,
        "target": target,
        "error_detail": clamp_error(detail),
    })
}

pub(crate) fn build_hop_entries(hops: &[HopResult], rdns: &HashMap<IpAddr, String>) -> Vec<Value> {
    if hops.is_empty() {
        return Vec::new();
    }

    let display_max_ttl = hops
        .iter()
        .map(|hop| hop.ttl)
        .max()
        .unwrap_or(TRACEROUTE_START_TTL);

    let mut by_ttl = HashMap::<u8, &HopResult>::new();
    for hop in hops {
        by_ttl.entry(hop.ttl).or_insert(hop);
    }

    (TRACEROUTE_START_TTL..=display_max_ttl)
        .map(|ttl| {
            let Some(hop) = by_ttl.get(&ttl) else {
                // TTL gap — no probe was sent (or result was lost); count as timeout
                return serde_json::json!({
                    "ttl": ttl as u64,
                    "responses": [],
                    "timeouts": TRACEROUTE_QUERIES_PER_HOP as u64,
                });
            };

            if let Some(ip) = hop.addr {
                let hostname = rdns.get(&ip).cloned();
                let responses = vec![serde_json::json!({
                    "ip": ip.to_string(),
                    "hostname": hostname,
                    "asn_info": null,
                    "rtt_ms": hop.rtt.map(|d| round_ms(Some(d.as_secs_f64() * 1000.0))),
                })];
                serde_json::json!({
                    "ttl": ttl as u64,
                    "responses": responses,
                    "timeouts": 0u64,
                })
            } else {
                serde_json::json!({
                    "ttl": ttl as u64,
                    "responses": [],
                    "timeouts": 1u64,
                })
            }
        })
        .collect::<Vec<_>>()
}

pub(crate) fn average_rtt_ms(hops: &[HopResult]) -> Option<f64> {
    let rtts: Vec<f64> = hops
        .iter()
        .filter_map(|hop| hop.rtt.map(|d| d.as_secs_f64() * 1000.0))
        .collect();
    if rtts.is_empty() {
        None
    } else {
        Some(rtts.iter().sum::<f64>() / rtts.len() as f64)
    }
}

pub(crate) fn traceroute_extra_v1(
    result: &RawTracerouteResult,
    origin_ip: Option<IpAddr>,
    rdns: &HashMap<IpAddr, String>,
) -> Value {
    let hops = build_hop_entries(&result.hops, rdns);
    let avg_rtt_ms = average_rtt_ms(&result.hops);

    serde_json::json!({
        "kind": "traceroute",
        "v": 1,
        "target": result.target,
        "target_ip": result.target_ip.to_string(),
        "origin_ip": origin_ip.map(|ip| ip.to_string()),
        "destination_asn_info": null,
        "destination_reached": result.destination_reached,
        "total_duration_ms": result.total_duration.as_millis().min(u64::MAX as u128) as u64,
        "avg_rtt_ms": avg_rtt_ms,
        "protocol_used": "icmp",
        "socket_mode_used": "raw",
        "start_ttl": TRACEROUTE_START_TTL as u64,
        "max_hops": TRACEROUTE_MAX_HOPS as u64,
        "queries_per_hop": TRACEROUTE_QUERIES_PER_HOP as u64,
        "hops": hops,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENT: u16 = 0x1234;
    const SEQ: u16 = 7;

    fn echo(icmp_type: u8, ident: u16, seq: u16) -> Vec<u8> {
        let mut pkt = vec![icmp_type, 0, 0, 0];
        pkt.extend_from_slice(&ident.to_be_bytes());
        pkt.extend_from_slice(&seq.to_be_bytes());
        pkt
    }

    fn icmp_error(icmp_type: u8, quoted_header: &[u8], quoted_echo: &[u8]) -> Vec<u8> {
        let mut pkt = vec![icmp_type, 0, 0, 0, 0, 0, 0, 0];
        pkt.extend_from_slice(quoted_header);
        pkt.extend_from_slice(quoted_echo);
        pkt
    }

    fn ipv6_header(next_header: u8) -> [u8; IPV6_HEADER_LEN] {
        let mut header = [0u8; IPV6_HEADER_LEN];
        header[0] = 0x60;
        header[IPV6_NEXT_HEADER_OFFSET] = next_header;
        header
    }

    #[test]
    fn classifies_icmpv6_replies_to_our_probe() {
        let quoted = ipv6_header(IPPROTO_ICMPV6);
        let probe = echo(ICMPV6_ECHO_REQUEST, IDENT, SEQ);

        assert_eq!(
            classify_reply(&echo(ICMPV6_ECHO_REPLY, IDENT, SEQ), true, IDENT, SEQ),
            Some(ReplyKind::EchoReply)
        );
        assert_eq!(
            classify_reply(
                &icmp_error(ICMPV6_TIME_EXCEEDED, &quoted, &probe),
                true,
                IDENT,
                SEQ
            ),
            Some(ReplyKind::TimeExceeded)
        );
        assert_eq!(
            classify_reply(
                &icmp_error(ICMPV6_DEST_UNREACHABLE, &quoted, &probe),
                true,
                IDENT,
                SEQ
            ),
            Some(ReplyKind::DestUnreachable)
        );
    }

    #[test]
    fn ignores_icmpv6_messages_that_are_not_for_our_probe() {
        let quoted = ipv6_header(IPPROTO_ICMPV6);
        let other_probe = echo(ICMPV6_ECHO_REQUEST, IDENT + 1, SEQ);
        let udp_quote = ipv6_header(17);
        let probe = echo(ICMPV6_ECHO_REQUEST, IDENT, SEQ);

        for packet in [
            echo(ICMPV6_ECHO_REPLY, IDENT, SEQ + 1),
            icmp_error(ICMPV6_TIME_EXCEEDED, &quoted, &other_probe),
            icmp_error(ICMPV6_TIME_EXCEEDED, &udp_quote, &probe),
            // Our own request looped back when tracing a local address.
            echo(ICMPV6_ECHO_REQUEST, IDENT, SEQ),
            // ICMPv4 type numbers mean something else in ICMPv6.
            echo(ICMP_ECHO_REPLY, IDENT, SEQ),
        ] {
            assert_eq!(classify_reply(&packet, true, IDENT, SEQ), None);
        }
    }

    #[test]
    fn classifies_icmpv4_replies_to_our_probe() {
        let mut quoted = [0u8; IP_HEADER_MIN_LEN];
        quoted[0] = 0x45;
        let probe = echo(ICMP_ECHO_REQUEST, IDENT, SEQ);

        assert_eq!(
            classify_reply(&echo(ICMP_ECHO_REPLY, IDENT, SEQ), false, IDENT, SEQ),
            Some(ReplyKind::EchoReply)
        );
        assert_eq!(
            classify_reply(
                &icmp_error(ICMP_TIME_EXCEEDED, &quoted, &probe),
                false,
                IDENT,
                SEQ
            ),
            Some(ReplyKind::TimeExceeded)
        );
        assert_eq!(
            classify_reply(
                &icmp_error(ICMP_DEST_UNREACHABLE, &quoted, &probe),
                false,
                IDENT,
                SEQ
            ),
            Some(ReplyKind::DestUnreachable)
        );
        assert_eq!(
            classify_reply(&echo(ICMPV6_ECHO_REPLY, IDENT, SEQ), false, IDENT, SEQ),
            None
        );
    }

    #[test]
    fn icmpv6_echo_request_leaves_checksum_to_the_kernel() {
        let v4 = build_echo_request(false, IDENT, SEQ);
        assert_eq!(v4[0], ICMP_ECHO_REQUEST);
        assert_eq!(icmp_checksum(&v4), 0, "IPv4 checksum must verify");

        let v6 = build_echo_request(true, IDENT, SEQ);
        assert_eq!(v6[0], ICMPV6_ECHO_REQUEST);
        assert_eq!(v6[2..4], [0, 0]);
        assert_eq!(v6[4..8], v4[4..8]);
    }

    #[test]
    fn dual_stack_hosts_keep_tracing_over_ipv4() {
        let v4: IpAddr = "192.0.2.1".parse().unwrap();
        let v6: IpAddr = "2001:db8::1".parse().unwrap();

        assert_eq!(pick_traceroute_addr(&[v6, v4]), Some(v4));
        assert_eq!(pick_traceroute_addr(&[v6]), Some(v6));
        assert_eq!(pick_traceroute_addr(&[]), None);
    }

    #[tokio::test]
    async fn traceroute_resolution_honors_the_family_policy() {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        let v6: IpAddr = "2001:db8::1".parse().unwrap();

        for family in [FamilyPolicy::Auto, FamilyPolicy::Only(IpFamily::V6)] {
            assert_eq!(
                resolve_traceroute_ip("2001:db8::1", family, deadline)
                    .await
                    .ok(),
                Some(v6)
            );
        }
        let err = resolve_traceroute_ip("2001:db8::1", FamilyPolicy::Only(IpFamily::V4), deadline)
            .await
            .unwrap_err();
        assert_eq!(err.code, "dns_no_ipv4");
    }
}
