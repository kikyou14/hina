use std::{collections::HashSet, io, net::IpAddr, time::Duration};

use serde_json::Value;
use socket2::{SockAddr, Socket};
use tokio::io::unix::AsyncFd;

use super::{
    clamp_error,
    family::{FamilyPolicy, IpFamily, resolve_first},
    outcome::ProbeOutcome,
    raw_socket::{async_recv_from, async_send_to, probe_origin_addr, transport_payload},
    remaining_until,
    tcp_raw::{
        ProbeFlow, QuoteKind, TCP_ACK, TCP_SYN, is_message_too_long, open_icmp_error_socket,
        open_tcp_socket, parse_tcp_segment, reserve_source_port, set_hop_limit,
    },
    traceroute::{
        HopResult, TRACEROUTE_MAX_HOPS, TRACEROUTE_PER_HOP_TIMEOUT, TRACEROUTE_QUERIES_PER_HOP,
        TRACEROUTE_RDNS_BUDGET_CAP, TRACEROUTE_START_TTL, TracerouteProbeError, average_rtt_ms,
        build_hop_entries, is_permission_error, rdns_best_effort, round_ms,
    },
};

const TRACEROUTE_EXTRA_MAX_BYTES: usize = 48 * 1024;

const PROBE_STYLE: &str = "tcp_syn_payload";
const ERR_PACKET_TOO_LARGE: &str = "packet_too_large";

/// Whether this platform can observe inbound TCP on a raw socket.
///
/// Linux delivers a copy of every matching-protocol datagram to raw sockets, so
/// the target's SYN-ACK/RST is visible. macOS/BSD (XNU) hand inbound TCP to the
/// kernel stack (`tcp_input`) and never copy it to a raw socket, so destination
/// replies would never be seen and every reachable target would be misreported
/// as `not_reached`. Observing them there requires a BPF receive backend, which
/// is not implemented; until then TCP size-pair traceroute is Linux-only. The
/// HELLO capability is gated on this, and `probe` refuses to run when false so a
/// misrouted task fails loudly instead of returning wrong data.
#[cfg(target_os = "linux")]
pub(crate) const TCP_SIZE_PAIR_SUPPORTED: bool = true;
#[cfg(not(target_os = "linux"))]
pub(crate) const TCP_SIZE_PAIR_SUPPORTED: bool = false;

// Sequence-number layout within one round. A target reply is attributed by its
// acknowledgment number in the inclusive range `seq + 1 ..= seq + 1 +
// payload_len` (payload up to 1460 bytes for a 1500-byte IPv4 probe). If two sizes'
// sequences sat only one apart, those ranges could collide — e.g. sizes [41,
// 1400] both accept `S + 2` — and a reply would be credited to whichever pending
// probe came first, fabricating a partial reach or a size divergence. Spacing the
// sizes far above the max payload makes the ranges disjoint; a much larger per-TTL
// stride likewise keeps late and endpoint-retry replies from aliasing.
const SEQ_SIZE_STRIDE: u32 = 1 << 13; // 8192, well above the 1460-byte max payload
const SEQ_RETRY_STRIDE: u32 = 1 << 18; // 262144, isolated within one TTL block
const SEQ_TTL_STRIDE: u32 = 1 << 20; // 1048576, dwarfs any single ACK range

const TARGET_RESET_MIN_GRACE: Duration = Duration::from_millis(20);

pub(crate) fn derive_sequence(nonce: u32, ttl: u8, size_index: usize) -> u32 {
    nonce
        .wrapping_add((ttl as u32).wrapping_mul(SEQ_TTL_STRIDE))
        .wrapping_add((size_index as u32).wrapping_mul(SEQ_SIZE_STRIDE))
}

/// Use a disjoint sequence range when the unresolved size is retried after a
/// target response. This prevents a late response to the paired SYN from being
/// mistaken for the isolated endpoint retry.
pub(crate) fn derive_retry_sequence(nonce: u32, ttl: u8, size_index: usize) -> u32 {
    derive_sequence(nonce, ttl, size_index).wrapping_add(SEQ_RETRY_STRIDE)
}

fn socket_error(context: &str) -> impl FnOnce(io::Error) -> TracerouteProbeError + '_ {
    move |e| TracerouteProbeError {
        code: if is_permission_error(&e) {
            "permission_denied"
        } else {
            "socket_error"
        },
        detail: format!("{context}: {e}"),
    }
}

/// Mutable per-size accumulator for one traceroute round.
pub(crate) struct SizeState {
    pub(crate) packet_size: u16,
    pub(crate) hops: Vec<HopResult>,
    pub(crate) reached: bool,
    pub(crate) stopped: bool,
    pub(crate) error_code: Option<&'static str>,
    pub(crate) path_mtu: Option<u32>,
    /// TTL of the hop entry recorded from an ICMP Fragmentation Needed report.
    /// That reporter sits at an earlier TTL than the probe that elicited it
    /// (the datagram must outlive the reporter to be forwarded into the
    /// too-small link), so the entry is kept for display but must never be
    /// used as same-TTL routing evidence.
    pub(crate) frag_hop_ttl: Option<u8>,
}

impl SizeState {
    pub(crate) fn new(packet_size: u16) -> Self {
        Self {
            packet_size,
            hops: Vec::new(),
            reached: false,
            stopped: false,
            error_code: None,
            path_mtu: None,
            frag_hop_ttl: None,
        }
    }
}

/// A probe awaiting a reply within the current TTL window.
pub(crate) struct Pending {
    pub(crate) size_index: usize,
    pub(crate) seq: u32,
    pub(crate) packet_size: u16,
    pub(crate) sent_at: std::time::Instant,
}

#[derive(Debug, Clone, Copy)]
struct TargetReset {
    seq: u32,
    observed_rtt: Duration,
}

pub(crate) struct TcpRunResult {
    pub(crate) source_ip: IpAddr,
    pub(crate) source_port: u16,
    pub(crate) states: [SizeState; 2],
    pub(crate) total_duration: Duration,
}

pub(crate) async fn probe(
    target: &str,
    family: IpFamily,
    port: u16,
    packet_sizes: [u16; 2],
    deadline: tokio::time::Instant,
) -> ProbeOutcome {
    // Defense in depth: the server gates TCP tasks on the HELLO capability, but
    // if one still reaches an unsupported platform, fail loudly rather than
    // silently returning `not_reached` for a target we simply cannot observe.
    if !TCP_SIZE_PAIR_SUPPORTED {
        return ProbeOutcome::failure("unsupported_platform").with_extra(tcp_error_extra(
            target,
            port,
            packet_sizes,
            "TCP size-pair traceroute requires a raw TCP receive backend not available on this platform",
        ));
    }

    let target_ip = match resolve_first(target, FamilyPolicy::Only(family), deadline).await {
        Ok(ip) => ip,
        Err(err) => {
            return ProbeOutcome::failure(err.code).with_extra(tcp_error_extra(
                target,
                port,
                packet_sizes,
                &err.detail,
            ));
        }
    };

    match run(target_ip, port, packet_sizes, deadline).await {
        Ok(run_result) => assemble_outcome(target, target_ip, port, run_result).await,
        Err(err) => ProbeOutcome::failure(err.code).with_extra(tcp_error_extra(
            target,
            port,
            packet_sizes,
            &err.detail,
        )),
    }
}

async fn run(
    target_ip: IpAddr,
    dest_port: u16,
    packet_sizes: [u16; 2],
    deadline: tokio::time::Instant,
) -> Result<TcpRunResult, TracerouteProbeError> {
    let source_ip = probe_origin_addr(target_ip)
        .await
        .ok_or_else(|| TracerouteProbeError {
            code: "network_unreachable",
            detail: format!("no route to {target_ip}"),
        })?;

    // Reserve an ephemeral source port for the whole round. The socket is never
    // connected; it only keeps the kernel from reusing the port.
    let (reserved, source_port) =
        reserve_source_port(source_ip).map_err(socket_error("bind port-reservation socket"))?;
    let flow = ProbeFlow::new(source_ip, target_ip, source_port, dest_port).ok_or_else(|| {
        TracerouteProbeError {
            code: "socket_error",
            detail: format!("source {source_ip} and target {target_ip} differ in family"),
        }
    })?;

    let icmp = open_icmp_error_socket(flow.family()).map_err(socket_error("open ICMP socket"))?;
    let icmp_fd = AsyncFd::new(icmp).map_err(socket_error("AsyncFd(ICMP)"))?;
    let tcp = open_tcp_socket(&flow).map_err(socket_error("open raw TCP socket"))?;
    let tcp_fd = AsyncFd::new(tcp).map_err(socket_error("AsyncFd(TCP)"))?;

    let dest = flow.target_sockaddr();
    let nonce = fastrand::u32(..);
    let start = std::time::Instant::now();

    let mut states = [
        SizeState::new(packet_sizes[0]),
        SizeState::new(packet_sizes[1]),
    ];

    for ttl in TRACEROUTE_START_TTL..=TRACEROUTE_MAX_HOPS {
        if states.iter().all(|s| s.stopped) {
            break;
        }
        if remaining_until(deadline).is_zero() {
            break;
        }

        // If the TTL can't be set, the socket keeps its previous/default TTL, so
        // any reply this round would be attributed to the wrong hop and could
        // fabricate a divergence. Fail closed like the ICMP path: record this TTL
        // as a timeout for every still-active size and move on without sending.
        if let Err(e) = set_hop_limit(tcp_fd.get_ref(), flow.family(), ttl) {
            tracing::debug!(ttl, error = %e, "tcp traceroute set_ttl failed; recording timeout");
            for state in states.iter_mut() {
                if !state.stopped {
                    state.hops.push(HopResult {
                        ttl,
                        addr: None,
                        rtt: None,
                    });
                }
            }
            continue;
        }

        // Alternate the send order each TTL so neither size is consistently first.
        let order: [usize; 2] = if ttl % 2 == 1 { [0, 1] } else { [1, 0] };
        let hop_deadline =
            tokio::time::Instant::now() + TRACEROUTE_PER_HOP_TIMEOUT.min(remaining_until(deadline));

        let mut pending: Vec<Pending> = Vec::with_capacity(2);
        for &index in &order {
            if states[index].stopped {
                continue;
            }
            let packet_size = states[index].packet_size;
            let seq = derive_sequence(nonce, ttl, index);
            let segment = flow.syn(seq, packet_size);
            let sent_at = std::time::Instant::now();
            match async_send_to(&tcp_fd, &segment, &dest).await {
                Ok(()) => pending.push(Pending {
                    size_index: index,
                    seq,
                    packet_size,
                    sent_at,
                }),
                Err(e) if is_message_too_long(&e) => {
                    states[index].stopped = true;
                    states[index].error_code = Some(ERR_PACKET_TOO_LARGE);
                }
                Err(e) => {
                    tracing::debug!(ttl, index, error = %e, "tcp traceroute send failed");
                    states[index].hops.push(HopResult {
                        ttl,
                        addr: None,
                        rtt: None,
                    });
                }
            }
        }

        let reached_before = [states[0].reached, states[1].reached];
        let target_reset = receive_hop(
            &icmp_fd,
            &tcp_fd,
            &flow,
            ttl,
            hop_deadline,
            &mut pending,
            &mut states,
        )
        .await;

        let newly_reached = states
            .iter()
            .zip(reached_before)
            .any(|(state, was_reached)| state.reached && !was_reached);

        if newly_reached {
            let reset_grace = if let Some(reset) = target_reset {
                send_target_reset(&tcp_fd, &flow, &dest, reset).await;
                reset
                    .observed_rtt
                    .max(TARGET_RESET_MIN_GRACE)
                    .min(TRACEROUTE_PER_HOP_TIMEOUT)
            } else {
                Duration::ZERO
            };

            if !pending.is_empty() {
                retry_pending_after_target_response(
                    &icmp_fd,
                    &tcp_fd,
                    &flow,
                    &dest,
                    ttl,
                    nonce,
                    deadline,
                    reset_grace,
                    &mut pending,
                    &mut states,
                )
                .await;
            }
        }

        // Whatever is still pending timed out at this TTL.
        for probe in &pending {
            states[probe.size_index].hops.push(HopResult {
                ttl,
                addr: None,
                rtt: None,
            });
        }
    }

    drop(reserved);

    Ok(TcpRunResult {
        source_ip,
        source_port,
        states,
        total_duration: start.elapsed(),
    })
}

/// Listen on both raw sockets until every pending probe is resolved or the
/// window expires. The primary per-TTL call passes both sizes; the isolated
/// endpoint retry passes only the unresolved size.
async fn receive_hop(
    icmp_fd: &AsyncFd<Socket>,
    tcp_fd: &AsyncFd<Socket>,
    flow: &ProbeFlow,
    ttl: u8,
    hop_deadline: tokio::time::Instant,
    pending: &mut Vec<Pending>,
    states: &mut [SizeState; 2],
) -> Option<TargetReset> {
    let mut icmp_buf = [0u8; 1500];
    let mut tcp_buf = [0u8; 1500];
    let mut recv_errors = 0u32;
    let reached_before = [states[0].reached, states[1].reached];

    while !pending.is_empty() {
        let remaining = remaining_until(hop_deadline);
        if remaining.is_zero() {
            break;
        }

        tokio::select! {
            result = async_recv_from(icmp_fd, &mut icmp_buf) => {
                match result {
                    Ok((n, from)) => {
                        let msg = transport_payload(flow.family(), &icmp_buf[..n]);
                        apply_icmp(msg, from, flow, ttl, pending, states);
                        if has_newly_reached(states, reached_before) {
                            return None;
                        }
                    }
                    Err(_) => {
                        recv_errors += 1;
                        if recv_errors >= 8 { break; }
                    }
                }
            }
            result = async_recv_from(tcp_fd, &mut tcp_buf) => {
                match result {
                    Ok((n, from)) => {
                        let segment = transport_payload(flow.family(), &tcp_buf[..n]);
                        let target_reset = apply_tcp(segment, from, flow, ttl, pending, states);
                        if target_reset.is_some() || has_newly_reached(states, reached_before) {
                            return target_reset;
                        }
                    }
                    Err(_) => {
                        recv_errors += 1;
                        if recv_errors >= 8 { break; }
                    }
                }
            }
            _ = tokio::time::sleep(remaining) => break,
        }
    }

    None
}

fn has_newly_reached(states: &[SizeState; 2], reached_before: [bool; 2]) -> bool {
    states
        .iter()
        .zip(reached_before)
        .any(|(state, was_reached)| state.reached && !was_reached)
}

async fn send_target_reset(
    tcp_fd: &AsyncFd<Socket>,
    flow: &ProbeFlow,
    dest: &SockAddr,
    reset: TargetReset,
) {
    if let Err(error) = async_send_to(tcp_fd, &flow.reset(reset.seq), dest).await {
        tracing::debug!(error = %error, "tcp traceroute target reset failed");
    }
}

/// A paired SYN that reaches an open target can leave the listener in
/// SYN-RECEIVED before its sibling is processed. Once either size reaches the
/// target, retry only the unresolved size at the same TTL after the reset has
/// had one observed round trip to clear that state. Intermediate-hop evidence
/// still comes from the original back-to-back pair.
#[allow(clippy::too_many_arguments)]
async fn retry_pending_after_target_response(
    icmp_fd: &AsyncFd<Socket>,
    tcp_fd: &AsyncFd<Socket>,
    flow: &ProbeFlow,
    dest: &SockAddr,
    ttl: u8,
    nonce: u32,
    deadline: tokio::time::Instant,
    reset_grace: Duration,
    pending: &mut Vec<Pending>,
    states: &mut [SizeState; 2],
) {
    if !reset_grace.is_zero() {
        tokio::time::sleep(reset_grace.min(remaining_until(deadline))).await;
    }
    if remaining_until(deadline).is_zero() {
        return;
    }

    let unresolved = std::mem::take(pending);
    for probe in unresolved {
        let index = probe.size_index;
        let seq = derive_retry_sequence(nonce, ttl, index);
        let segment = flow.syn(seq, probe.packet_size);
        let sent_at = std::time::Instant::now();
        match async_send_to(tcp_fd, &segment, dest).await {
            Ok(()) => pending.push(Pending {
                size_index: index,
                seq,
                packet_size: probe.packet_size,
                sent_at,
            }),
            Err(error) if is_message_too_long(&error) => {
                states[index].stopped = true;
                states[index].error_code = Some(ERR_PACKET_TOO_LARGE);
            }
            Err(error) => {
                tracing::debug!(ttl, index, error = %error, "tcp traceroute target retry failed");
                states[index].hops.push(HopResult {
                    ttl,
                    addr: None,
                    rtt: None,
                });
            }
        }
    }

    if pending.is_empty() {
        return;
    }

    let retry_deadline =
        tokio::time::Instant::now() + TRACEROUTE_PER_HOP_TIMEOUT.min(remaining_until(deadline));
    if let Some(reset) =
        receive_hop(icmp_fd, tcp_fd, flow, ttl, retry_deadline, pending, states).await
    {
        send_target_reset(tcp_fd, flow, dest, reset).await;
    }
}

pub(crate) fn apply_icmp(
    msg: &[u8],
    from: IpAddr,
    flow: &ProbeFlow,
    ttl: u8,
    pending: &mut Vec<Pending>,
    states: &mut [SizeState; 2],
) {
    let Some(quote) = flow.match_icmp_quote(msg) else {
        return;
    };

    let Some(pos) = pending
        .iter()
        .position(|p| p.seq == quote.inner_seq && quote.inner_total_length == p.packet_size)
    else {
        return;
    };

    let probe = pending.remove(pos);
    let state = &mut states[probe.size_index];
    state.hops.push(HopResult {
        ttl,
        addr: Some(from),
        rtt: Some(probe.sent_at.elapsed()),
    });

    match quote.kind {
        // An ordinary intermediate hop: keep probing.
        QuoteKind::TimeExceeded => {}
        // A downstream link is too small for this size: remember the next-hop MTU and stop sending
        // this size. The hop entry is display-only evidence — the reporter answered from an earlier
        // TTL, so `frag_hop_ttl` marks it for exclusion from route comparison.
        QuoteKind::PacketTooBig { mtu } => {
            state.path_mtu = mtu;
            state.error_code = Some(ERR_PACKET_TOO_LARGE);
            state.frag_hop_ttl = Some(ttl);
            state.stopped = true;
        }
        // Any Destination Unreachable ends this size: from the target it means the host answered
        // (treat as reached, rare for TCP); from an intermediate hop the path is blocked, so stop
        // with the specific reason instead of burning the remaining TTLs re-hitting the same wall.
        QuoteKind::Unreachable(reason) => {
            state.stopped = true;
            if from == flow.target_ip() {
                state.reached = true;
            } else {
                state.error_code = Some(reason.code());
            }
        }
    }
}

fn apply_tcp(
    segment: &[u8],
    from: IpAddr,
    flow: &ProbeFlow,
    ttl: u8,
    pending: &mut Vec<Pending>,
    states: &mut [SizeState; 2],
) -> Option<TargetReset> {
    if from != flow.target_ip() {
        return None;
    }
    let resp = parse_tcp_segment(segment)?;

    if let Some(pos) = pending
        .iter()
        .position(|p| flow.matches_response(&resp, p.seq, p.packet_size))
    {
        let probe = pending.remove(pos);
        let observed_rtt = probe.sent_at.elapsed();
        let target_reset =
            (resp.flags & (TCP_SYN | TCP_ACK) == (TCP_SYN | TCP_ACK)).then_some(TargetReset {
                seq: resp.ack,
                observed_rtt,
            });
        mark_reached(states, probe, flow.target_ip(), ttl, observed_rtt);
        return target_reset;
    }

    None
}

fn mark_reached(
    states: &mut [SizeState; 2],
    probe: Pending,
    target_ip: IpAddr,
    ttl: u8,
    rtt: Duration,
) {
    let index = probe.size_index;
    states[index].hops.push(HopResult {
        ttl,
        addr: Some(target_ip),
        rtt: Some(rtt),
    });
    states[index].reached = true;
    states[index].stopped = true;
}

async fn assemble_outcome(
    target: &str,
    target_ip: IpAddr,
    port: u16,
    run_result: TcpRunResult,
) -> ProbeOutcome {
    let mut uniq_ips = HashSet::<IpAddr>::new();
    for state in &run_result.states {
        for hop in &state.hops {
            if let Some(ip) = hop.addr {
                uniq_ips.insert(ip);
            }
        }
    }
    let mut ips = uniq_ips.into_iter().collect::<Vec<_>>();
    ips.sort_by_key(|ip| ip.to_string());
    let rdns_deadline = tokio::time::Instant::now() + TRACEROUTE_RDNS_BUDGET_CAP;
    let rdns = rdns_best_effort(ips, rdns_deadline).await;

    let reached: Vec<bool> = run_result.states.iter().map(|s| s.reached).collect();
    let (ok, err_code): (bool, Option<&'static str>) = match (reached[0], reached[1]) {
        (true, true) => (true, None),
        (false, false) => (false, Some("not_reached")),
        _ => (false, Some("partial_reach")),
    };

    // Compatibility summary latency uses the smaller size's last valid RTT.
    let lat_ms = round_ms(
        run_result.states[0]
            .hops
            .iter()
            .rev()
            .find_map(|h| h.rtt.map(|d| d.as_secs_f64() * 1000.0)),
    );

    let extra = build_v2_extra(target, target_ip, port, &run_result, &rdns);
    let extra = enforce_extra_size(target, target_ip, port, &run_result, extra);

    let outcome = if ok {
        ProbeOutcome::success(0)
    } else {
        ProbeOutcome::failure(err_code.unwrap_or("not_reached"))
    };
    outcome.with_ok(ok).with_latency(lat_ms).with_extra(extra)
}

fn enforce_extra_size(
    target: &str,
    target_ip: IpAddr,
    port: u16,
    run_result: &TcpRunResult,
    extra: Value,
) -> Value {
    if serialized_len(&extra) <= TRACEROUTE_EXTRA_MAX_BYTES {
        return extra;
    }

    let without_hostnames = build_v2_extra(
        target,
        target_ip,
        port,
        run_result,
        &std::collections::HashMap::new(),
    );
    if serialized_len(&without_hostnames) <= TRACEROUTE_EXTRA_MAX_BYTES {
        return without_hostnames;
    }

    serde_json::json!({
        "kind": "traceroute",
        "v": 2,
        "target": target,
        "target_ip": target_ip.to_string(),
        "protocol_used": "tcp",
        "error_code": "result_too_large",
    })
}

fn serialized_len(value: &Value) -> usize {
    serde_json::to_string(value)
        .map(|s| s.len())
        .unwrap_or(usize::MAX)
}

pub(crate) fn build_v2_extra(
    target: &str,
    target_ip: IpAddr,
    port: u16,
    run_result: &TcpRunResult,
    rdns: &std::collections::HashMap<IpAddr, String>,
) -> Value {
    let traces = run_result
        .states
        .iter()
        .map(|state| {
            serde_json::json!({
                "packet_size_bytes": state.packet_size as u64,
                "destination_reached": state.reached,
                "avg_rtt_ms": average_rtt_ms(&state.hops),
                "error_code": state.error_code,
                "path_mtu_bytes": state.path_mtu.map(|mtu| mtu as u64),
                "frag_hop_ttl": state.frag_hop_ttl.map(|ttl| ttl as u64),
                "hops": build_hop_entries(&state.hops, rdns),
            })
        })
        .collect::<Vec<_>>();

    let comparison = compute_comparison(&run_result.states[0], &run_result.states[1]);

    serde_json::json!({
        "kind": "traceroute",
        "v": 2,
        "target": target,
        "target_ip": target_ip.to_string(),
        "origin_ip": run_result.source_ip.to_string(),
        "destination_asn_info": null,
        "protocol_used": "tcp",
        "socket_mode_used": "raw",
        "probe_style": PROBE_STYLE,
        "port": port as u64,
        "source_port": run_result.source_port as u64,
        "start_ttl": TRACEROUTE_START_TTL as u64,
        "max_hops": TRACEROUTE_MAX_HOPS as u64,
        "queries_per_hop": TRACEROUTE_QUERIES_PER_HOP as u64,
        "total_duration_ms": run_result.total_duration.as_millis().min(u64::MAX as u128) as u64,
        "traces": traces,
        "comparison": comparison,
    })
}

pub(crate) fn compute_comparison(small: &SizeState, large: &SizeState) -> Value {
    let small_ips = ttl_ip_map(small);
    let large_ips = ttl_ip_map(large);

    let mut comparable = false;
    let mut first_diverging_ttl: Option<u8> = None;

    for ttl in TRACEROUTE_START_TTL..=TRACEROUTE_MAX_HOPS {
        let a = lookup_ttl_ip(&small_ips, ttl);
        let b = lookup_ttl_ip(&large_ips, ttl);
        if let (Some(a), Some(b)) = (a, b) {
            comparable = true;
            if a != b {
                first_diverging_ttl = Some(ttl);
                break;
            }
        }
    }

    serde_json::json!({
        "comparable": comparable,
        "route_diverged": first_diverging_ttl.is_some(),
        "first_diverging_ttl": first_diverging_ttl.map(|ttl| ttl as u64),
    })
}

fn ttl_ip_map(state: &SizeState) -> Vec<(u8, IpAddr)> {
    state
        .hops
        .iter()
        .filter(|hop| state.frag_hop_ttl != Some(hop.ttl))
        .filter_map(|hop| hop.addr.map(|ip| (hop.ttl, ip)))
        .collect()
}

fn lookup_ttl_ip(map: &[(u8, IpAddr)], ttl: u8) -> Option<IpAddr> {
    map.iter().find(|(t, _)| *t == ttl).map(|(_, ip)| *ip)
}

fn tcp_error_extra(target: &str, port: u16, packet_sizes: [u16; 2], detail: &str) -> Value {
    serde_json::json!({
        "kind": "traceroute",
        "v": 2,
        "target": target,
        "protocol_used": "tcp",
        "port": port as u64,
        "packet_sizes": [packet_sizes[0] as u64, packet_sizes[1] as u64],
        "error_detail": clamp_error(detail),
    })
}
