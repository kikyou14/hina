use std::{
    collections::{HashMap, HashSet},
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};

use serde_json::Value;
use socket2::{Domain, Protocol, Socket, Type};
use tokio::{
    io::unix::AsyncFd,
    net::lookup_host,
    sync::Semaphore,
    task::{JoinSet, spawn_blocking},
};

use super::{clamp_error, outcome::ProbeOutcome, remaining_until};

const TRACEROUTE_START_TTL: u8 = 1;
const TRACEROUTE_MAX_HOPS: u8 = 30;
const TRACEROUTE_QUERIES_PER_HOP: u8 = 1;
const TRACEROUTE_PER_HOP_TIMEOUT: Duration = Duration::from_millis(2000);

pub(crate) const TRACEROUTE_MIN_TIMEOUT: Duration = Duration::from_millis(
    TRACEROUTE_MAX_HOPS as u64 * TRACEROUTE_PER_HOP_TIMEOUT.as_millis() as u64 + 5000,
);

const TRACEROUTE_RDNS_LOOKUP_TIMEOUT: Duration = Duration::from_millis(200);
const TRACEROUTE_RDNS_BUDGET_CAP: Duration = Duration::from_millis(800);
const TRACEROUTE_RDNS_MAX_CONCURRENCY: usize = 8;

// ICMP message types
const ICMP_ECHO_REPLY: u8 = 0;
const ICMP_DEST_UNREACHABLE: u8 = 3;
const ICMP_ECHO_REQUEST: u8 = 8;
const ICMP_TIME_EXCEEDED: u8 = 11;

// Minimum sizes for parsing received ICMP packets
const ICMP_HEADER_LEN: usize = 8;
const IP_HEADER_MIN_LEN: usize = 20;

#[derive(Debug, Clone)]
pub(crate) struct HopResult {
    pub(crate) ttl: u8,
    pub(crate) addr: Option<IpAddr>,
    pub(crate) rtt: Option<Duration>,
}

#[derive(Debug)]
pub(crate) struct RawTracerouteResult {
    pub(crate) target: String,
    pub(crate) target_ip: Ipv4Addr,
    pub(crate) hops: Vec<HopResult>,
    pub(crate) destination_reached: bool,
    pub(crate) total_duration: Duration,
}

#[derive(Debug)]
struct TracerouteProbeError {
    code: &'static str,
    detail: String,
}

pub(crate) async fn probe(target: &str, deadline: tokio::time::Instant) -> ProbeOutcome {
    match run_traceroute(target, deadline).await {
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
    deadline: tokio::time::Instant,
) -> Result<TracerouteRunOutcome, TracerouteProbeError> {
    let target_ip = resolve_traceroute_ipv4(target, deadline).await?;

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

    let origin_ip = probe_origin_ip(target_ip).await;

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

fn create_icmp_raw_socket() -> Result<Socket, TracerouteProbeError> {
    let s = Socket::new(Domain::IPV4, Type::RAW, Some(Protocol::ICMPV4)).map_err(|e| {
        TracerouteProbeError {
            code: if is_permission_error(&e) {
                "permission_denied"
            } else {
                "socket_error"
            },
            detail: format!("failed to create ICMP socket: {e}"),
        }
    })?;
    s.set_nonblocking(true).map_err(|e| TracerouteProbeError {
        code: "socket_error",
        detail: format!("set_nonblocking: {e}"),
    })?;

    Ok(s)
}

fn is_permission_error(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::AddrNotAvailable
    ) || matches!(e.raw_os_error(), Some(1) | Some(13))
}

async fn run_raw_traceroute(
    target: &str,
    target_ip: Ipv4Addr,
    probe_timeout: Duration,
    overall_timeout: Duration,
) -> Result<RawTracerouteResult, TracerouteProbeError> {
    let socket = create_icmp_raw_socket()?;
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
                if addr == IpAddr::V4(target_ip) {
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
                if addr == IpAddr::V4(target_ip) {
                    destination_reached = true;
                }
                break;
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
    Timeout,
    Error(io::Error),
}

async fn probe_one_hop(
    fd: &AsyncFd<Socket>,
    target_ip: Ipv4Addr,
    ttl: u8,
    ident: u16,
    seq: u16,
    timeout: Duration,
) -> HopOutcome {
    // Set TTL
    if let Err(e) = fd.get_ref().set_ttl_v4(ttl as u32) {
        return HopOutcome::Error(e);
    }

    // Build & send ICMP Echo Request
    let packet = build_echo_request(ident, seq);
    let dest = socket2::SockAddr::from(SocketAddr::new(IpAddr::V4(target_ip), 0));

    let send_time = std::time::Instant::now();

    if let Err(e) = async_send_to(fd, &packet, &dest).await {
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
        let icmp_data = strip_ip_header(&buf[..n]);

        if icmp_data.len() < ICMP_HEADER_LEN {
            continue;
        }

        let icmp_type = icmp_data[0];

        match icmp_type {
            ICMP_ECHO_REPLY => {
                let recv_ident = u16::from_be_bytes([icmp_data[4], icmp_data[5]]);
                let recv_seq = u16::from_be_bytes([icmp_data[6], icmp_data[7]]);
                if recv_ident == ident && recv_seq == seq {
                    return HopOutcome::Reply {
                        addr: from_addr,
                        rtt,
                    };
                }
            }
            ICMP_TIME_EXCEEDED => {
                if let Some(true) = match_embedded_probe(icmp_data, ident, seq) {
                    return HopOutcome::TimeExceeded {
                        addr: from_addr,
                        rtt,
                    };
                }
            }
            ICMP_DEST_UNREACHABLE => {
                if let Some(true) = match_embedded_probe(icmp_data, ident, seq) {
                    return HopOutcome::DestUnreachable {
                        addr: from_addr,
                        rtt,
                    };
                }
            }
            _ => {}
        }
    }
}

fn match_embedded_probe(icmp_data: &[u8], ident: u16, seq: u16) -> Option<bool> {
    // After the 8-byte ICMP header comes the original IP header + ICMP fragment.
    let inner = icmp_data.get(ICMP_HEADER_LEN..)?;
    if inner.len() < IP_HEADER_MIN_LEN + ICMP_HEADER_LEN {
        return None;
    }
    let ihl = (inner[0] & 0x0F) as usize * 4;
    if inner.len() < ihl + ICMP_HEADER_LEN {
        return None;
    }
    let inner_icmp = &inner[ihl..];
    if inner_icmp[0] != ICMP_ECHO_REQUEST {
        return None;
    }
    let orig_ident = u16::from_be_bytes([inner_icmp[4], inner_icmp[5]]);
    let orig_seq = u16::from_be_bytes([inner_icmp[6], inner_icmp[7]]);
    Some(orig_ident == ident && orig_seq == seq)
}

/// Strip the outer IP header from a RAW socket received buffer to get the ICMP payload.
fn strip_ip_header(buf: &[u8]) -> &[u8] {
    if buf.len() < IP_HEADER_MIN_LEN {
        return &[];
    }
    let ihl = (buf[0] & 0x0F) as usize * 4;
    if buf.len() < ihl {
        return &[];
    }
    &buf[ihl..]
}

fn build_echo_request(ident: u16, seq: u16) -> [u8; 8] {
    let mut pkt = [0u8; 8];
    pkt[0] = ICMP_ECHO_REQUEST;
    pkt[1] = 0; // code
    // checksum at [2..4], filled below
    pkt[4..6].copy_from_slice(&ident.to_be_bytes());
    pkt[6..8].copy_from_slice(&seq.to_be_bytes());

    let cksum = icmp_checksum(&pkt);
    pkt[2..4].copy_from_slice(&cksum.to_be_bytes());
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

async fn async_send_to(
    fd: &AsyncFd<Socket>,
    buf: &[u8],
    addr: &socket2::SockAddr,
) -> io::Result<()> {
    loop {
        let mut guard = fd.writable().await?;
        match guard.try_io(|inner| inner.get_ref().send_to(buf, addr)) {
            Ok(result) => return result.map(|_| ()),
            Err(_would_block) => continue,
        }
    }
}

async fn async_recv_from(fd: &AsyncFd<Socket>, buf: &mut [u8]) -> io::Result<(usize, IpAddr)> {
    loop {
        let mut guard = fd.readable().await?;
        match guard.try_io(|inner| {
            let uninit_buf =
                unsafe { &mut *(buf as *mut [u8] as *mut [std::mem::MaybeUninit<u8>]) };
            let (n, addr) = inner.get_ref().recv_from(uninit_buf)?;
            let ip = addr
                .as_socket_ipv4()
                .map(|v4| IpAddr::V4(*v4.ip()))
                .or_else(|| addr.as_socket_ipv6().map(|v6| IpAddr::V6(*v6.ip())))
                .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
            Ok((n, ip))
        }) {
            Ok(result) => return result,
            Err(_would_block) => continue,
        }
    }
}

async fn resolve_traceroute_ipv4(
    host: &str,
    deadline: tokio::time::Instant,
) -> Result<Ipv4Addr, TracerouteProbeError> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => Ok(v4),
            IpAddr::V6(_) => Err(TracerouteProbeError {
                code: "ipv6_not_supported",
                detail: "IPv6 targets are not supported".to_string(),
            }),
        };
    }

    let addrs = tokio::time::timeout_at(deadline, lookup_host((host, 0)))
        .await
        .map_err(|_| TracerouteProbeError {
            code: "timeout",
            detail: "dns lookup timeout".to_string(),
        })?
        .map_err(|err| TracerouteProbeError {
            code: "dns_error",
            detail: err.to_string(),
        })?;

    let mut first_v4 = None;
    let mut has_v6 = false;
    for addr in addrs {
        match addr.ip() {
            IpAddr::V4(v4) => {
                if first_v4.is_none() {
                    first_v4 = Some(v4);
                }
            }
            IpAddr::V6(_) => has_v6 = true,
        }
    }

    if let Some(v4) = first_v4 {
        return Ok(v4);
    }

    if has_v6 {
        Err(TracerouteProbeError {
            code: "ipv6_not_supported",
            detail: "no IPv4 records found (IPv6 only)".to_string(),
        })
    } else {
        Err(TracerouteProbeError {
            code: "dns_no_ipv4",
            detail: "no IPv4 records found".to_string(),
        })
    }
}

async fn probe_origin_ip(target_ip: Ipv4Addr) -> Option<Ipv4Addr> {
    let socket = tokio::net::UdpSocket::bind("0.0.0.0:0").await.ok()?;
    socket.connect((target_ip, 33434)).await.ok()?;
    let local = socket.local_addr().ok()?;
    match local.ip() {
        IpAddr::V4(v4) => Some(v4),
        IpAddr::V6(_) => None,
    }
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

pub(crate) fn traceroute_extra_v1(
    result: &RawTracerouteResult,
    origin_ip: Option<Ipv4Addr>,
    rdns: &HashMap<IpAddr, String>,
) -> Value {
    let display_max_ttl = result
        .hops
        .iter()
        .map(|hop| hop.ttl)
        .max()
        .unwrap_or(TRACEROUTE_START_TTL);

    let mut by_ttl = HashMap::<u8, &HopResult>::new();
    for hop in &result.hops {
        by_ttl.entry(hop.ttl).or_insert(hop);
    }

    let hops = (TRACEROUTE_START_TTL..=display_max_ttl)
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
        .collect::<Vec<_>>();

    let avg_rtt_ms = {
        let rtts: Vec<f64> = result
            .hops
            .iter()
            .filter_map(|h| h.rtt.map(|d| d.as_secs_f64() * 1000.0))
            .collect();
        if rtts.is_empty() {
            None
        } else {
            Some(rtts.iter().sum::<f64>() / rtts.len() as f64)
        }
    };

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
