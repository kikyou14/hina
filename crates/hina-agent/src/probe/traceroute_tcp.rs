use std::{
    collections::HashSet,
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    os::fd::AsRawFd,
    time::Duration,
};

use serde_json::Value;
use socket2::{Domain, Protocol, SockAddr, Socket, Type};
use tokio::io::unix::AsyncFd;

use super::{
    clamp_error,
    outcome::ProbeOutcome,
    remaining_until,
    traceroute::{
        HopResult, TRACEROUTE_MAX_HOPS, TRACEROUTE_PER_HOP_TIMEOUT, TRACEROUTE_QUERIES_PER_HOP,
        TRACEROUTE_RDNS_BUDGET_CAP, TRACEROUTE_START_TTL, TracerouteProbeError, async_recv_from,
        async_send_to, average_rtt_ms, build_hop_entries, is_permission_error, probe_origin_ip,
        rdns_best_effort, resolve_traceroute_ipv4, round_ms, strip_ip_header,
    },
};

// TCP header layout (no options): fixed 20-byte header.
const TCP_HEADER_LEN: usize = 20;
const IPV4_HEADER_LEN: u16 = 20;
const TCP_WINDOW: u16 = 65535;

// TCP flag bits.
const TCP_SYN: u8 = 0x02;
const TCP_RST: u8 = 0x04;
const TCP_ACK: u8 = 0x10;

// ICMP message types / codes relevant to TCP quotes.
const ICMP_DEST_UNREACHABLE: u8 = 3;
const ICMP_TIME_EXCEEDED: u8 = 11;
const ICMP_CODE_FRAGMENTATION_NEEDED: u8 = 4;
const IP_PROTO_TCP: u8 = 6;

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

/// Payload length carried after the 20-byte TCP header for a given IPv4 total
/// length. `packet_size` is validated to be >= 40, so this never underflows.
pub(crate) fn payload_len_for(packet_size: u16) -> usize {
    packet_size as usize - IPV4_HEADER_LEN as usize - TCP_HEADER_LEN
}

// Sequence-number layout within one round. A target reply is attributed by its
// acknowledgment number in the inclusive range `seq + 1 ..= seq + 1 +
// payload_len` (payload up to 1460 bytes for a 1500-byte probe). If two sizes'
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

fn fill_payload(buf: &mut [u8]) {
    for (i, byte) in buf.iter_mut().enumerate() {
        *byte = (i & 0xff) as u8;
    }
}

/// Internet checksum over the TCP pseudo-header + segment (checksum field 0).
pub(crate) fn tcp_checksum(source: Ipv4Addr, dest: Ipv4Addr, segment: &[u8]) -> u16 {
    let mut sum: u32 = 0;

    let s = source.octets();
    let d = dest.octets();
    sum += u16::from_be_bytes([s[0], s[1]]) as u32;
    sum += u16::from_be_bytes([s[2], s[3]]) as u32;
    sum += u16::from_be_bytes([d[0], d[1]]) as u32;
    sum += u16::from_be_bytes([d[2], d[3]]) as u32;
    sum += IP_PROTO_TCP as u32;
    sum += segment.len() as u32;

    let mut i = 0;
    while i + 1 < segment.len() {
        sum += u16::from_be_bytes([segment[i], segment[i + 1]]) as u32;
        i += 2;
    }
    if i < segment.len() {
        sum += (segment[i] as u32) << 8;
    }

    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

#[derive(Debug, Clone, Copy)]
struct TcpSegmentSpec {
    packet_size: u16,
    flags: u8,
    window: u16,
}

fn build_tcp_segment(
    source_ip: Ipv4Addr,
    dest_ip: Ipv4Addr,
    source_port: u16,
    dest_port: u16,
    seq: u32,
    spec: TcpSegmentSpec,
) -> Vec<u8> {
    let payload_len = payload_len_for(spec.packet_size);
    let mut segment = vec![0u8; TCP_HEADER_LEN + payload_len];

    segment[0..2].copy_from_slice(&source_port.to_be_bytes());
    segment[2..4].copy_from_slice(&dest_port.to_be_bytes());
    segment[4..8].copy_from_slice(&seq.to_be_bytes());
    // acknowledgment [8..12] = 0
    segment[12] = (5u8) << 4; // data offset = 5 words, reserved = 0
    segment[13] = spec.flags;
    segment[14..16].copy_from_slice(&spec.window.to_be_bytes());
    // checksum [16..18] filled below; urgent pointer [18..20] = 0
    fill_payload(&mut segment[TCP_HEADER_LEN..]);

    let checksum = tcp_checksum(source_ip, dest_ip, &segment);
    segment[16..18].copy_from_slice(&checksum.to_be_bytes());
    segment
}

/// Build a TCP SYN segment (header + deterministic payload) with a valid
/// checksum. Returns `packet_size - 20` bytes; the kernel adds the IPv4 header.
pub(crate) fn build_tcp_syn(
    source_ip: Ipv4Addr,
    dest_ip: Ipv4Addr,
    source_port: u16,
    dest_port: u16,
    seq: u32,
    packet_size: u16,
) -> Vec<u8> {
    build_tcp_segment(
        source_ip,
        dest_ip,
        source_port,
        dest_port,
        seq,
        TcpSegmentSpec {
            packet_size,
            flags: TCP_SYN,
            window: TCP_WINDOW,
        },
    )
}

/// Build the reset sent in response to a SYN-ACK. The sequence is the ACK from
/// the target, which is the acceptable reset sequence for its SYN-RECEIVED TCB.
/// A minimal segment is preferable here: cleanup must not depend on the larger
/// experimental packet size being routable.
pub(crate) fn build_tcp_reset(
    source_ip: Ipv4Addr,
    dest_ip: Ipv4Addr,
    source_port: u16,
    dest_port: u16,
    seq: u32,
) -> Vec<u8> {
    build_tcp_segment(
        source_ip,
        dest_ip,
        source_port,
        dest_port,
        seq,
        TcpSegmentSpec {
            packet_size: IPV4_HEADER_LEN + TCP_HEADER_LEN as u16,
            flags: TCP_RST,
            window: 0,
        },
    )
}

/// A matched ICMP error quoting one of our TCP probes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct IcmpQuoteMatch {
    pub(crate) icmp_type: u8,
    pub(crate) icmp_code: u8,
    pub(crate) inner_seq: u32,
    pub(crate) inner_total_length: u16,
    pub(crate) next_hop_mtu: Option<u16>,
}

pub(crate) fn parse_icmp_tcp_quote(
    msg: &[u8],
    source_ip: Ipv4Addr,
    target_ip: Ipv4Addr,
    source_port: u16,
    dest_port: u16,
) -> Option<IcmpQuoteMatch> {
    if msg.len() < 8 {
        return None;
    }
    let icmp_type = msg[0];
    let icmp_code = msg[1];
    if icmp_type != ICMP_TIME_EXCEEDED && icmp_type != ICMP_DEST_UNREACHABLE {
        return None;
    }

    let next_hop_mtu =
        if icmp_type == ICMP_DEST_UNREACHABLE && icmp_code == ICMP_CODE_FRAGMENTATION_NEEDED {
            let mtu = u16::from_be_bytes([msg[6], msg[7]]);
            (mtu != 0).then_some(mtu)
        } else {
            None
        };

    // After the 8-byte ICMP header: quoted original IPv4 header + >= 8 bytes TCP.
    let inner = msg.get(8..)?;
    if inner.len() < 20 || inner[0] >> 4 != 4 {
        return None;
    }
    let ihl = (inner[0] & 0x0f) as usize * 4;
    if ihl < 20 || inner.len() < ihl {
        return None;
    }
    if inner[9] != IP_PROTO_TCP {
        return None;
    }
    let inner_total_length = u16::from_be_bytes([inner[2], inner[3]]);
    let inner_src = Ipv4Addr::new(inner[12], inner[13], inner[14], inner[15]);
    let inner_dst = Ipv4Addr::new(inner[16], inner[17], inner[18], inner[19]);
    if inner_src != source_ip || inner_dst != target_ip {
        return None;
    }

    let tcp = inner.get(ihl..)?;
    if tcp.len() < 8 {
        return None;
    }
    let tcp_src = u16::from_be_bytes([tcp[0], tcp[1]]);
    let tcp_dst = u16::from_be_bytes([tcp[2], tcp[3]]);
    if tcp_src != source_port || tcp_dst != dest_port {
        return None;
    }
    let inner_seq = u32::from_be_bytes([tcp[4], tcp[5], tcp[6], tcp[7]]);

    Some(IcmpQuoteMatch {
        icmp_type,
        icmp_code,
        inner_seq,
        inner_total_length,
        next_hop_mtu,
    })
}

/// A parsed inbound TCP segment (outer IP header already stripped).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TcpResponse {
    pub(crate) src_port: u16,
    pub(crate) dst_port: u16,
    pub(crate) ack: u32,
    pub(crate) flags: u8,
}

pub(crate) fn parse_tcp_segment(segment: &[u8]) -> Option<TcpResponse> {
    if segment.len() < TCP_HEADER_LEN {
        return None;
    }
    Some(TcpResponse {
        src_port: u16::from_be_bytes([segment[0], segment[1]]),
        dst_port: u16::from_be_bytes([segment[2], segment[3]]),
        ack: u32::from_be_bytes([segment[8], segment[9], segment[10], segment[11]]),
        flags: segment[13],
    })
}

pub(crate) fn tcp_response_matches_probe(
    resp: &TcpResponse,
    target_port: u16,
    source_port: u16,
    probe_seq: u32,
    packet_size: u16,
) -> bool {
    if resp.src_port != target_port || resp.dst_port != source_port {
        return false;
    }
    if resp.flags & TCP_ACK == 0 {
        return false;
    }
    let is_syn_ack = resp.flags & (TCP_SYN | TCP_ACK) == (TCP_SYN | TCP_ACK);
    let is_rst_ack = resp.flags & (TCP_RST | TCP_ACK) == (TCP_RST | TCP_ACK);
    if !(is_syn_ack || is_rst_ack) {
        return false;
    }
    let first_valid_ack = probe_seq.wrapping_add(1);
    let acknowledged_payload = resp.ack.wrapping_sub(first_valid_ack);
    acknowledged_payload <= payload_len_for(packet_size) as u32
}

pub(crate) fn is_message_too_long(err: &io::Error) -> bool {
    err.raw_os_error() == Some(libc::EMSGSIZE)
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FilterInsn {
    pub(crate) code: u16,
    pub(crate) jt: u8,
    pub(crate) jf: u8,
    pub(crate) k: u32,
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn tcp_probe_filter(
    target_ip: Ipv4Addr,
    dest_port: u16,
    source_port: u16,
) -> [FilterInsn; 11] {
    // Classic BPF opcodes (linux/bpf_common.h), spelled out because the libc
    // crate only exposes them on Linux.
    const LD_W_ABS: u16 = 0x20; // A = be32 at [k]
    const LD_H_ABS: u16 = 0x28; // A = be16 at [k]
    const LD_H_IND: u16 = 0x48; // A = be16 at [X + k]
    const LDX_B_MSH: u16 = 0xb1; // X = 4 * (pkt[k] & 0x0f), the IPv4 IHL idiom
    const JEQ_K: u16 = 0x15; // pc += (A == k) ? jt : jf
    const JSET_K: u16 = 0x45; // pc += (A & k) != 0 ? jt : jf
    const RET_K: u16 = 0x06; // accept k bytes (0 = drop)

    let insn = |code: u16, jt: u8, jf: u8, k: u32| FilterInsn { code, jt, jf, k };
    [
        // Non-first fragments carry no TCP header, so the port loads below
        // would read payload bytes; drop them outright.
        insn(LD_H_ABS, 0, 0, 6),    // A = IPv4 flags + fragment offset
        insn(JSET_K, 8, 0, 0x1fff), // fragment offset != 0 -> drop
        insn(LD_W_ABS, 0, 0, 12),   // A = source address
        insn(JEQ_K, 0, 6, u32::from(target_ip)),
        insn(LDX_B_MSH, 0, 0, 0), // X = IPv4 header length
        insn(LD_H_IND, 0, 0, 0),  // A = TCP source port
        insn(JEQ_K, 0, 3, u32::from(dest_port)),
        insn(LD_H_IND, 0, 0, 2), // A = TCP destination port
        insn(JEQ_K, 0, 1, u32::from(source_port)),
        insn(RET_K, 0, 0, u32::MAX), // accept
        insn(RET_K, 0, 0, 0),        // drop
    ]
}

#[cfg(target_os = "linux")]
fn attach_tcp_probe_filter(
    socket: &Socket,
    target_ip: Ipv4Addr,
    dest_port: u16,
    source_port: u16,
) -> io::Result<()> {
    let mut prog: Vec<libc::sock_filter> = tcp_probe_filter(target_ip, dest_port, source_port)
        .iter()
        .map(|i| libc::sock_filter {
            code: i.code,
            jt: i.jt,
            jf: i.jf,
            k: i.k,
        })
        .collect();
    let fprog = libc::sock_fprog {
        len: prog.len() as u16,
        filter: prog.as_mut_ptr(),
    };
    let rc = unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_ATTACH_FILTER,
            std::ptr::addr_of!(fprog).cast::<libc::c_void>(),
            std::mem::size_of::<libc::sock_fprog>() as libc::socklen_t,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// The TCP size-pair probe never runs here (`TCP_SIZE_PAIR_SUPPORTED` gates it
/// in `probe`); this stub only keeps `run` compiling on non-Linux targets.
#[cfg(not(target_os = "linux"))]
fn attach_tcp_probe_filter(
    _socket: &Socket,
    _target_ip: Ipv4Addr,
    _dest_port: u16,
    _source_port: u16,
) -> io::Result<()> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn set_dont_fragment(socket: &Socket) -> io::Result<()> {
    // IP_MTU_DISCOVER = IP_PMTUDISC_DO sets DF and disables fragmentation.
    let value: libc::c_int = libc::IP_PMTUDISC_DO;
    setsockopt_int(socket, libc::IPPROTO_IP, libc::IP_MTU_DISCOVER, value)
}

#[cfg(not(target_os = "linux"))]
fn set_dont_fragment(socket: &Socket) -> io::Result<()> {
    // BSD / macOS use IP_DONTFRAG to force the DF bit.
    setsockopt_int(socket, libc::IPPROTO_IP, libc::IP_DONTFRAG, 1)
}

fn setsockopt_int(
    socket: &Socket,
    level: libc::c_int,
    name: libc::c_int,
    value: libc::c_int,
) -> io::Result<()> {
    let rc = unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            level,
            name,
            std::ptr::addr_of!(value).cast::<libc::c_void>(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn create_raw_socket(protocol: Protocol, label: &str) -> Result<Socket, TracerouteProbeError> {
    let socket =
        Socket::new(Domain::IPV4, Type::RAW, Some(protocol)).map_err(|e| TracerouteProbeError {
            code: if is_permission_error(&e) {
                "permission_denied"
            } else {
                "socket_error"
            },
            detail: format!("failed to create {label} socket: {e}"),
        })?;
    socket
        .set_nonblocking(true)
        .map_err(|e| TracerouteProbeError {
            code: "socket_error",
            detail: format!("set_nonblocking on {label} socket: {e}"),
        })?;
    Ok(socket)
}

/// Mutable per-size accumulator for one traceroute round.
pub(crate) struct SizeState {
    pub(crate) packet_size: u16,
    pub(crate) hops: Vec<HopResult>,
    pub(crate) reached: bool,
    pub(crate) stopped: bool,
    pub(crate) error_code: Option<&'static str>,
    pub(crate) path_mtu: Option<u16>,
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

/// Immutable identity of the round, used for response matching.
pub(crate) struct RoundCtx {
    pub(crate) source_ip: Ipv4Addr,
    pub(crate) target_ip: Ipv4Addr,
    pub(crate) source_port: u16,
    pub(crate) dest_port: u16,
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
    pub(crate) source_ip: Ipv4Addr,
    pub(crate) source_port: u16,
    pub(crate) states: [SizeState; 2],
    pub(crate) total_duration: Duration,
}

pub(crate) async fn probe(
    target: &str,
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

    let target_ip = match resolve_traceroute_ipv4(target, deadline).await {
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
    target_ip: Ipv4Addr,
    dest_port: u16,
    packet_sizes: [u16; 2],
    deadline: tokio::time::Instant,
) -> Result<TcpRunResult, TracerouteProbeError> {
    let source_ip = probe_origin_ip(target_ip)
        .await
        .ok_or_else(|| TracerouteProbeError {
            code: "socket_error",
            detail: "failed to determine source IPv4".to_string(),
        })?;

    // Reserve an ephemeral source port for the whole round. The socket is never
    // connected; it only keeps the kernel from reusing the port.
    let reserved = reserve_source_port(source_ip)?;
    let source_port = reserved_port(&reserved)?;

    let icmp = create_raw_socket(Protocol::ICMPV4, "ICMP")?;
    let icmp_fd = AsyncFd::new(icmp).map_err(|e| TracerouteProbeError {
        code: "socket_error",
        detail: format!("AsyncFd(ICMP): {e}"),
    })?;

    let tcp = create_raw_socket(Protocol::TCP, "TCP")?;
    // Bind the raw socket to the routing-selected source address so the kernel
    // stamps the outgoing IPv4 header with exactly the address used in the TCP
    // pseudo-header checksum. On a multi-homed or policy-routed host the kernel
    // could otherwise pick a different source, which both invalidates the TCP
    // checksum and makes ICMP quotes (matched on inner source IP) unrecognizable
    // — the whole path would then read as timeout. Per raw(7), with IP_HDRINCL
    // off the kernel builds the header and honors the bound local address.
    let source_bind = SockAddr::from(SocketAddr::new(IpAddr::V4(source_ip), 0));
    tcp.bind(&source_bind).map_err(|e| TracerouteProbeError {
        code: "socket_error",
        detail: format!("bind raw TCP socket to source {source_ip}: {e}"),
    })?;
    set_dont_fragment(&tcp).map_err(|e| TracerouteProbeError {
        code: "socket_error",
        detail: format!("enable DF: {e}"),
    })?;
    attach_tcp_probe_filter(&tcp, target_ip, dest_port, source_port).map_err(|e| {
        TracerouteProbeError {
            code: "socket_error",
            detail: format!("attach TCP probe filter: {e}"),
        }
    })?;
    let tcp_fd = AsyncFd::new(tcp).map_err(|e| TracerouteProbeError {
        code: "socket_error",
        detail: format!("AsyncFd(TCP): {e}"),
    })?;

    let ctx = RoundCtx {
        source_ip,
        target_ip,
        source_port,
        dest_port,
    };
    let dest = SockAddr::from(SocketAddr::new(IpAddr::V4(target_ip), 0));
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
        if let Err(e) = tcp_fd.get_ref().set_ttl_v4(ttl as u32) {
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
            let segment = build_tcp_syn(
                source_ip,
                target_ip,
                source_port,
                dest_port,
                seq,
                packet_size,
            );
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
            &ctx,
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
                send_target_reset(&tcp_fd, &ctx, &dest, reset).await;
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
                    &ctx,
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
    ctx: &RoundCtx,
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
                        let msg = strip_ip_header(&icmp_buf[..n]);
                        apply_icmp(msg, from, ctx, ttl, pending, states);
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
                        let segment = strip_ip_header(&tcp_buf[..n]);
                        let target_reset = apply_tcp(segment, from, ctx, ttl, pending, states);
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
    ctx: &RoundCtx,
    dest: &SockAddr,
    reset: TargetReset,
) {
    let segment = build_tcp_reset(
        ctx.source_ip,
        ctx.target_ip,
        ctx.source_port,
        ctx.dest_port,
        reset.seq,
    );
    if let Err(error) = async_send_to(tcp_fd, &segment, dest).await {
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
    ctx: &RoundCtx,
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
        let segment = build_tcp_syn(
            ctx.source_ip,
            ctx.target_ip,
            ctx.source_port,
            ctx.dest_port,
            seq,
            probe.packet_size,
        );
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
        receive_hop(icmp_fd, tcp_fd, ctx, ttl, retry_deadline, pending, states).await
    {
        send_target_reset(tcp_fd, ctx, dest, reset).await;
    }
}

pub(crate) fn apply_icmp(
    msg: &[u8],
    from: IpAddr,
    ctx: &RoundCtx,
    ttl: u8,
    pending: &mut Vec<Pending>,
    states: &mut [SizeState; 2],
) {
    let Some(quote) = parse_icmp_tcp_quote(
        msg,
        ctx.source_ip,
        ctx.target_ip,
        ctx.source_port,
        ctx.dest_port,
    ) else {
        return;
    };

    let Some(pos) = pending
        .iter()
        .position(|p| p.seq == quote.inner_seq && quote.inner_total_length == p.packet_size)
    else {
        return;
    };

    let probe = pending.remove(pos);
    let index = probe.size_index;
    let rtt = probe.sent_at.elapsed();

    if quote.icmp_type == ICMP_DEST_UNREACHABLE && quote.icmp_code == ICMP_CODE_FRAGMENTATION_NEEDED
    {
        // A downstream link is too small for this size: record the reporter as a
        // hop, remember the next-hop MTU, and stop sending this size. The entry
        // is display-only evidence — the reporter answered from an earlier TTL,
        // so `frag_hop_ttl` marks it for exclusion from route comparison.
        states[index].hops.push(HopResult {
            ttl,
            addr: Some(from),
            rtt: Some(rtt),
        });
        states[index].path_mtu = quote.next_hop_mtu;
        states[index].error_code = Some(ERR_PACKET_TOO_LARGE);
        states[index].frag_hop_ttl = Some(ttl);
        states[index].stopped = true;
        return;
    }

    states[index].hops.push(HopResult {
        ttl,
        addr: Some(from),
        rtt: Some(rtt),
    });

    // Time Exceeded is an ordinary intermediate hop — keep probing. Any
    // Destination Unreachable, however, ends this size: from the target it means
    // the host answered (treat as reached, rare for TCP); from an intermediate
    // hop the path is blocked, so stop with the specific reason instead of
    // burning the remaining TTLs re-hitting the same wall and timing out.
    if quote.icmp_type == ICMP_DEST_UNREACHABLE {
        states[index].stopped = true;
        if from == IpAddr::V4(ctx.target_ip) {
            states[index].reached = true;
        } else {
            states[index].error_code = Some(unreachable_error_code(quote.icmp_code));
        }
    }
}

/// Map an ICMP Destination Unreachable code to a concise, stable error reason.
/// (Fragmentation-needed, code 4, is handled separately as `packet_too_large`.)
fn unreachable_error_code(code: u8) -> &'static str {
    match code {
        0 => "net_unreachable",
        1 => "host_unreachable",
        2 => "protocol_unreachable",
        3 => "port_unreachable",
        9 | 10 | 13 => "admin_prohibited",
        _ => "dest_unreachable",
    }
}

fn apply_tcp(
    segment: &[u8],
    from: IpAddr,
    ctx: &RoundCtx,
    ttl: u8,
    pending: &mut Vec<Pending>,
    states: &mut [SizeState; 2],
) -> Option<TargetReset> {
    if from != IpAddr::V4(ctx.target_ip) {
        return None;
    }
    let resp = parse_tcp_segment(segment)?;
    // Reject anything not addressed to this round's source port.
    if resp.src_port != ctx.dest_port || resp.dst_port != ctx.source_port {
        return None;
    }

    if let Some(pos) = pending.iter().position(|p| {
        tcp_response_matches_probe(&resp, ctx.dest_port, ctx.source_port, p.seq, p.packet_size)
    }) {
        let probe = pending.remove(pos);
        let observed_rtt = probe.sent_at.elapsed();
        let target_reset =
            (resp.flags & (TCP_SYN | TCP_ACK) == (TCP_SYN | TCP_ACK)).then_some(TargetReset {
                seq: resp.ack,
                observed_rtt,
            });
        mark_reached(states, probe, ctx.target_ip, ttl, observed_rtt);
        return target_reset;
    }

    None
}

fn mark_reached(
    states: &mut [SizeState; 2],
    probe: Pending,
    target_ip: Ipv4Addr,
    ttl: u8,
    rtt: Duration,
) {
    let index = probe.size_index;
    states[index].hops.push(HopResult {
        ttl,
        addr: Some(IpAddr::V4(target_ip)),
        rtt: Some(rtt),
    });
    states[index].reached = true;
    states[index].stopped = true;
}

fn reserve_source_port(source_ip: Ipv4Addr) -> Result<Socket, TracerouteProbeError> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP)).map_err(|e| {
        TracerouteProbeError {
            code: "socket_error",
            detail: format!("failed to create port-reservation socket: {e}"),
        }
    })?;
    let bind_addr = SockAddr::from(SocketAddr::new(IpAddr::V4(source_ip), 0));
    if socket.bind(&bind_addr).is_err() {
        // Fall back to the unspecified address if the derived source cannot bind.
        let any = SockAddr::from(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0));
        socket.bind(&any).map_err(|e| TracerouteProbeError {
            code: "socket_error",
            detail: format!("bind port-reservation socket: {e}"),
        })?;
    }
    Ok(socket)
}

fn reserved_port(socket: &Socket) -> Result<u16, TracerouteProbeError> {
    socket
        .local_addr()
        .ok()
        .and_then(|addr| addr.as_socket_ipv4().map(|v4| v4.port()))
        .filter(|port| *port != 0)
        .ok_or_else(|| TracerouteProbeError {
            code: "socket_error",
            detail: "failed to read reserved source port".to_string(),
        })
}

async fn assemble_outcome(
    target: &str,
    target_ip: Ipv4Addr,
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
    target_ip: Ipv4Addr,
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
    target_ip: Ipv4Addr,
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
