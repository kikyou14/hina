use std::{
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    os::fd::AsRawFd,
};

use socket2::{Protocol, SockAddr, Socket, Type};

use super::family::IpFamily;

// TCP header layout (no options): fixed 20-byte header.
const TCP_HEADER_LEN: usize = 20;
const TCP_WINDOW: u16 = 65535;

/// Largest probe packet: a standard Ethernet MTU.
pub(crate) const MAX_PACKET_SIZE: u16 = 1500;

// TCP flag bits.
pub(crate) const TCP_SYN: u8 = 0x02;
pub(crate) const TCP_RST: u8 = 0x04;
pub(crate) const TCP_ACK: u8 = 0x10;

const IP_PROTO_TCP: u8 = 6;
const IPV4_MIN_HEADER_LEN: usize = 20;
const IPV6_HEADER_LEN: usize = 40;
const ICMP_HEADER_LEN: usize = 8;

// ICMP message types / codes relevant to TCP quotes.
const ICMP_DEST_UNREACHABLE: u8 = 3;
const ICMP_TIME_EXCEEDED: u8 = 11;
const ICMP_CODE_FRAGMENTATION_NEEDED: u8 = 4;

// ICMPv6 message types relevant to TCP quotes (RFC 4443).
const ICMPV6_DEST_UNREACHABLE: u8 = 1;
const ICMPV6_PACKET_TOO_BIG: u8 = 2;
const ICMPV6_TIME_EXCEEDED: u8 = 3;

/// Smallest probe packet for `family`: the IP header plus a bare TCP header.
pub(crate) fn min_packet_size(family: IpFamily) -> u16 {
    family.ip_header_len() + TCP_HEADER_LEN as u16
}

fn fill_payload(buf: &mut [u8]) {
    for (i, byte) in buf.iter_mut().enumerate() {
        *byte = (i & 0xff) as u8;
    }
}

/// Ones-complement sum of big-endian 16-bit words; an odd trailing byte is the high byte.
fn word_sum(bytes: &[u8]) -> u32 {
    let mut words = bytes.chunks_exact(2);
    let mut sum: u32 = words
        .by_ref()
        .map(|word| u32::from(u16::from_be_bytes([word[0], word[1]])))
        .sum();
    if let [last] = words.remainder() {
        sum += u32::from(*last) << 8;
    }
    sum
}

fn fold_checksum(mut sum: u32) -> u16 {
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlowAddrs {
    V4 { source: Ipv4Addr, target: Ipv4Addr },
    V6 { source: Ipv6Addr, target: Ipv6Addr },
}

/// The tuple one raw TCP probe sends on. Source and target always share a family: the source is
/// the address the kernel routes the target from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProbeFlow {
    addrs: FlowAddrs,
    pub(crate) source_port: u16,
    pub(crate) dest_port: u16,
}

impl ProbeFlow {
    /// `None` when `source_ip` and `target_ip` belong to different families.
    pub(crate) fn new(
        source_ip: IpAddr,
        target_ip: IpAddr,
        source_port: u16,
        dest_port: u16,
    ) -> Option<Self> {
        let addrs = match (source_ip, target_ip) {
            (IpAddr::V4(source), IpAddr::V4(target)) => FlowAddrs::V4 { source, target },
            (IpAddr::V6(source), IpAddr::V6(target)) => FlowAddrs::V6 { source, target },
            _ => return None,
        };
        Some(Self {
            addrs,
            source_port,
            dest_port,
        })
    }

    pub(crate) fn family(&self) -> IpFamily {
        match self.addrs {
            FlowAddrs::V4 { .. } => IpFamily::V4,
            FlowAddrs::V6 { .. } => IpFamily::V6,
        }
    }

    pub(crate) fn source_ip(&self) -> IpAddr {
        match self.addrs {
            FlowAddrs::V4 { source, .. } => IpAddr::V4(source),
            FlowAddrs::V6 { source, .. } => IpAddr::V6(source),
        }
    }

    pub(crate) fn target_ip(&self) -> IpAddr {
        match self.addrs {
            FlowAddrs::V4 { target, .. } => IpAddr::V4(target),
            FlowAddrs::V6 { target, .. } => IpAddr::V6(target),
        }
    }

    /// Destination for `send_to`; raw sockets take the port from the TCP header.
    pub(crate) fn target_sockaddr(&self) -> SockAddr {
        SockAddr::from(SocketAddr::new(self.target_ip(), 0))
    }

    /// Payload after the TCP header so the kernel-built packet totals `packet_size` bytes. Sizes
    /// are validated against `min_packet_size`; a smaller one sends a bare header.
    pub(crate) fn payload_len(&self, packet_size: u16) -> usize {
        usize::from(packet_size.saturating_sub(min_packet_size(self.family())))
    }

    /// Internet checksum over the TCP pseudo-header and `segment`. Zero for a segment that already
    /// carries a valid checksum.
    pub(crate) fn checksum(&self, segment: &[u8]) -> u16 {
        let len = segment.len() as u32;
        let pseudo_header = match self.addrs {
            FlowAddrs::V4 { source, target } => {
                word_sum(&source.octets())
                    + word_sum(&target.octets())
                    + u32::from(IP_PROTO_TCP)
                    + len
            }
            // RFC 8200 section 8.1: a 32-bit upper-layer length, then the next header.
            FlowAddrs::V6 { source, target } => {
                word_sum(&source.octets())
                    + word_sum(&target.octets())
                    + (len >> 16)
                    + (len & 0xffff)
                    + u32::from(IP_PROTO_TCP)
            }
        };
        fold_checksum(pseudo_header + word_sum(segment))
    }

    fn segment(&self, seq: u32, payload_len: usize, flags: u8, window: u16) -> Vec<u8> {
        let mut segment = vec![0u8; TCP_HEADER_LEN + payload_len];

        segment[0..2].copy_from_slice(&self.source_port.to_be_bytes());
        segment[2..4].copy_from_slice(&self.dest_port.to_be_bytes());
        segment[4..8].copy_from_slice(&seq.to_be_bytes());
        // acknowledgment [8..12] = 0
        segment[12] = 5u8 << 4; // data offset = 5 words, reserved = 0
        segment[13] = flags;
        segment[14..16].copy_from_slice(&window.to_be_bytes());
        // checksum [16..18] filled below; urgent pointer [18..20] = 0
        fill_payload(&mut segment[TCP_HEADER_LEN..]);

        let checksum = self.checksum(&segment);
        segment[16..18].copy_from_slice(&checksum.to_be_bytes());
        segment
    }

    /// TCP SYN with a deterministic payload and a valid checksum; the kernel prepends the IP
    /// header, so the packet on the wire is `packet_size` bytes.
    pub(crate) fn syn(&self, seq: u32, packet_size: u16) -> Vec<u8> {
        self.segment(seq, self.payload_len(packet_size), TCP_SYN, TCP_WINDOW)
    }

    /// Reset sent in response to a SYN-ACK. The sequence is the ACK from the target, which is the
    /// acceptable reset sequence for its SYN-RECEIVED TCB. A minimal segment is preferable here:
    /// cleanup must not depend on the larger experimental packet size being routable.
    pub(crate) fn reset(&self, seq: u32) -> Vec<u8> {
        self.segment(seq, 0, TCP_RST, 0)
    }

    /// Whether `resp` answers the SYN sent with `probe_seq` at `packet_size`: a SYN-ACK or RST-ACK
    /// from the target port acknowledging the SYN and any prefix of its payload.
    pub(crate) fn matches_response(
        &self,
        resp: &TcpResponse,
        probe_seq: u32,
        packet_size: u16,
    ) -> bool {
        if resp.src_port != self.dest_port || resp.dst_port != self.source_port {
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
        acknowledged_payload <= self.payload_len(packet_size) as u32
    }

    /// Matches an ICMP (IPv4) or ICMPv6 error, starting at its header, that quotes a probe of this
    /// flow.
    pub(crate) fn match_icmp_quote(&self, msg: &[u8]) -> Option<IcmpQuote> {
        if msg.len() < ICMP_HEADER_LEN {
            return None;
        }
        let quoted = &msg[ICMP_HEADER_LEN..];
        let (kind, inner_total_length, tcp) = match self.addrs {
            FlowAddrs::V4 { source, target } => {
                let kind = classify_icmpv4(msg)?;
                let (total_length, tcp) = quoted_ipv4_tcp(quoted, source, target)?;
                (kind, total_length, tcp)
            }
            FlowAddrs::V6 { source, target } => {
                let kind = classify_icmpv6(msg)?;
                let (total_length, tcp) = quoted_ipv6_tcp(quoted, source, target)?;
                (kind, total_length, tcp)
            }
        };

        // ICMP errors quote at least the first 8 bytes of the TCP header: ports and sequence.
        if tcp.len() < 8 {
            return None;
        }
        let tcp_src = u16::from_be_bytes([tcp[0], tcp[1]]);
        let tcp_dst = u16::from_be_bytes([tcp[2], tcp[3]]);
        if tcp_src != self.source_port || tcp_dst != self.dest_port {
            return None;
        }

        Some(IcmpQuote {
            kind,
            inner_seq: u32::from_be_bytes([tcp[4], tcp[5], tcp[6], tcp[7]]),
            inner_total_length,
        })
    }
}

/// What an ICMP or ICMPv6 error says about a probe, in one vocabulary for both families.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum QuoteKind {
    TimeExceeded,
    /// IPv4 Fragmentation Needed or IPv6 Packet Too Big, with the reported next-hop MTU.
    PacketTooBig {
        mtu: Option<u32>,
    },
    Unreachable(Unreachable),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Unreachable {
    Net,
    Host,
    Protocol,
    Port,
    AdminProhibited,
    Other,
}

impl Unreachable {
    /// Stable error reason reported for this kind of unreachable.
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Net => "net_unreachable",
            Self::Host => "host_unreachable",
            Self::Protocol => "protocol_unreachable",
            Self::Port => "port_unreachable",
            Self::AdminProhibited => "admin_prohibited",
            Self::Other => "dest_unreachable",
        }
    }
}

/// A matched ICMP error quoting one of our TCP probes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct IcmpQuote {
    pub(crate) kind: QuoteKind,
    pub(crate) inner_seq: u32,
    /// Total length of the quoted IP packet, comparable with the probe's packet size.
    pub(crate) inner_total_length: u16,
}

fn classify_icmpv4(msg: &[u8]) -> Option<QuoteKind> {
    let (icmp_type, code) = (msg[0], msg[1]);
    match icmp_type {
        ICMP_TIME_EXCEEDED => Some(QuoteKind::TimeExceeded),
        ICMP_DEST_UNREACHABLE if code == ICMP_CODE_FRAGMENTATION_NEEDED => {
            let mtu = u16::from_be_bytes([msg[6], msg[7]]);
            Some(QuoteKind::PacketTooBig {
                mtu: (mtu != 0).then_some(u32::from(mtu)),
            })
        }
        ICMP_DEST_UNREACHABLE => Some(QuoteKind::Unreachable(match code {
            0 => Unreachable::Net,
            1 => Unreachable::Host,
            2 => Unreachable::Protocol,
            3 => Unreachable::Port,
            9 | 10 | 13 => Unreachable::AdminProhibited,
            _ => Unreachable::Other,
        })),
        _ => None,
    }
}

fn classify_icmpv6(msg: &[u8]) -> Option<QuoteKind> {
    let (icmp_type, code) = (msg[0], msg[1]);
    match icmp_type {
        ICMPV6_TIME_EXCEEDED => Some(QuoteKind::TimeExceeded),
        ICMPV6_PACKET_TOO_BIG => {
            let mtu = u32::from_be_bytes([msg[4], msg[5], msg[6], msg[7]]);
            Some(QuoteKind::PacketTooBig {
                mtu: (mtu != 0).then_some(mtu),
            })
        }
        ICMPV6_DEST_UNREACHABLE => Some(QuoteKind::Unreachable(match code {
            0 => Unreachable::Net,
            // 1: administratively prohibited, 5: source address failed policy, 6: reject route.
            1 | 5 | 6 => Unreachable::AdminProhibited,
            3 => Unreachable::Host,
            4 => Unreachable::Port,
            _ => Unreachable::Other,
        })),
        _ => None,
    }
}

/// The quoted packet's total length and its TCP header, when it is an IPv4 packet of the flow.
fn quoted_ipv4_tcp(inner: &[u8], source: Ipv4Addr, target: Ipv4Addr) -> Option<(u16, &[u8])> {
    if inner.len() < IPV4_MIN_HEADER_LEN || inner[0] >> 4 != 4 {
        return None;
    }
    let ihl = usize::from(inner[0] & 0x0f) * 4;
    if ihl < IPV4_MIN_HEADER_LEN || inner.len() < ihl || inner[9] != IP_PROTO_TCP {
        return None;
    }
    let inner_src = Ipv4Addr::new(inner[12], inner[13], inner[14], inner[15]);
    let inner_dst = Ipv4Addr::new(inner[16], inner[17], inner[18], inner[19]);
    if inner_src != source || inner_dst != target {
        return None;
    }
    Some((u16::from_be_bytes([inner[2], inner[3]]), &inner[ihl..]))
}

/// The quoted packet's total length and its TCP header, when it is an IPv6 packet of the flow.
fn quoted_ipv6_tcp(inner: &[u8], source: Ipv6Addr, target: Ipv6Addr) -> Option<(u16, &[u8])> {
    if inner.len() < IPV6_HEADER_LEN || inner[0] >> 4 != 6 {
        return None;
    }
    // Probes carry no extension headers, so TCP follows the fixed header.
    if inner[6] != IP_PROTO_TCP {
        return None;
    }
    let inner_src = Ipv6Addr::from(<[u8; 16]>::try_from(&inner[8..24]).ok()?);
    let inner_dst = Ipv6Addr::from(<[u8; 16]>::try_from(&inner[24..40]).ok()?);
    if inner_src != source || inner_dst != target {
        return None;
    }
    // The IPv6 payload length excludes the fixed header; add it back so the result compares with
    // the configured packet size the same way IPv4's total length does.
    let payload_len = u16::from_be_bytes([inner[4], inner[5]]);
    let total_length = payload_len.checked_add(IPV6_HEADER_LEN as u16)?;
    Some((total_length, &inner[IPV6_HEADER_LEN..]))
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

/// Classic BPF program that accepts only the flow's replies: TCP from the target port to the
/// source port (and, for IPv4, from the target address).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn tcp_probe_filter(flow: &ProbeFlow) -> Vec<FilterInsn> {
    // Classic BPF opcodes (linux/bpf_common.h), spelled out because the libc crate only exposes
    // them on Linux.
    const LD_W_ABS: u16 = 0x20; // A = be32 at [k]
    const LD_H_ABS: u16 = 0x28; // A = be16 at [k]
    const LD_H_IND: u16 = 0x48; // A = be16 at [X + k]
    const LDX_B_MSH: u16 = 0xb1; // X = 4 * (pkt[k] & 0x0f), the IPv4 IHL idiom
    const JEQ_K: u16 = 0x15; // pc += (A == k) ? jt : jf
    const JSET_K: u16 = 0x45; // pc += (A & k) != 0 ? jt : jf
    const RET_K: u16 = 0x06; // accept k bytes (0 = drop)

    let insn = |code: u16, jt: u8, jf: u8, k: u32| FilterInsn { code, jt, jf, k };
    let dest_port = u32::from(flow.dest_port);
    let source_port = u32::from(flow.source_port);
    match flow.addrs {
        // IPv4 raw sockets hand the filter the whole packet, IP header included.
        FlowAddrs::V4 { target, .. } => vec![
            // Non-first fragments carry no TCP header, so the port loads below would read
            // payload bytes; drop them outright.
            insn(LD_H_ABS, 0, 0, 6),    // A = IPv4 flags + fragment offset
            insn(JSET_K, 8, 0, 0x1fff), // fragment offset != 0 -> drop
            insn(LD_W_ABS, 0, 0, 12),   // A = source address
            insn(JEQ_K, 0, 6, u32::from(target)),
            insn(LDX_B_MSH, 0, 0, 0), // X = IPv4 header length
            insn(LD_H_IND, 0, 0, 0),  // A = TCP source port
            insn(JEQ_K, 0, 3, dest_port),
            insn(LD_H_IND, 0, 0, 2), // A = TCP destination port
            insn(JEQ_K, 0, 1, source_port),
            insn(RET_K, 0, 0, u32::MAX), // accept
            insn(RET_K, 0, 0, 0),        // drop
        ],
        // IPv6 raw sockets hand the filter the segment from the TCP header on, after the kernel
        // has consumed the IPv6 header and reassembled fragments; the socket only sees packets to
        // its bound source, and callers check the sender address.
        FlowAddrs::V6 { .. } => vec![
            insn(LD_H_ABS, 0, 0, 0), // A = TCP source port
            insn(JEQ_K, 0, 3, dest_port),
            insn(LD_H_ABS, 0, 0, 2), // A = TCP destination port
            insn(JEQ_K, 0, 1, source_port),
            insn(RET_K, 0, 0, u32::MAX), // accept
            insn(RET_K, 0, 0, 0),        // drop
        ],
    }
}

#[cfg(target_os = "linux")]
fn attach_tcp_probe_filter(socket: &Socket, flow: &ProbeFlow) -> io::Result<()> {
    let mut prog: Vec<libc::sock_filter> = tcp_probe_filter(flow)
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
    setsockopt(socket, libc::SOL_SOCKET, libc::SO_ATTACH_FILTER, &fprog)
}

/// Callers reject unsupported platforms before creating raw TCP probes.
#[cfg(not(target_os = "linux"))]
fn attach_tcp_probe_filter(_socket: &Socket, _flow: &ProbeFlow) -> io::Result<()> {
    Ok(())
}

#[cfg(target_os = "linux")]
fn set_dont_fragment(socket: &Socket, family: IpFamily) -> io::Result<()> {
    match family {
        // IP_PMTUDISC_DO sets DF and disables fragmentation.
        IpFamily::V4 => setsockopt(
            socket,
            libc::IPPROTO_IP,
            libc::IP_MTU_DISCOVER,
            &libc::IP_PMTUDISC_DO,
        ),
        // IPv6 routers never fragment; this also stops the kernel from fragmenting locally, so a
        // size above the known path MTU fails with EMSGSIZE instead.
        IpFamily::V6 => setsockopt(
            socket,
            libc::IPPROTO_IPV6,
            libc::IPV6_MTU_DISCOVER,
            &libc::IPV6_PMTUDISC_DO,
        ),
    }
}

#[cfg(not(target_os = "linux"))]
fn set_dont_fragment(socket: &Socket, family: IpFamily) -> io::Result<()> {
    match family {
        // BSD / macOS use IP_DONTFRAG to force the DF bit.
        IpFamily::V4 => setsockopt(socket, libc::IPPROTO_IP, libc::IP_DONTFRAG, &1),
        IpFamily::V6 => Err(io::ErrorKind::Unsupported.into()),
    }
}

/// Pass only the ICMPv6 errors that can quote a TCP probe; otherwise every probe would also wake
/// for the host's neighbor discovery and multicast listener traffic.
#[cfg(target_os = "linux")]
fn set_icmpv6_error_filter(socket: &Socket) -> io::Result<()> {
    // linux/icmpv6.h; libc does not export it. A set bit blocks that message type.
    const ICMPV6_FILTER: libc::c_int = 1;
    let mut blocked = [u32::MAX; 8];
    for icmp_type in [
        ICMPV6_DEST_UNREACHABLE,
        ICMPV6_PACKET_TOO_BIG,
        ICMPV6_TIME_EXCEEDED,
    ] {
        blocked[usize::from(icmp_type >> 5)] &= !(1u32 << (icmp_type & 31));
    }
    setsockopt(socket, libc::SOL_ICMPV6, ICMPV6_FILTER, &blocked)
}

#[cfg(not(target_os = "linux"))]
fn set_icmpv6_error_filter(_socket: &Socket) -> io::Result<()> {
    Ok(())
}

fn setsockopt<T>(
    socket: &Socket,
    level: libc::c_int,
    name: libc::c_int,
    value: &T,
) -> io::Result<()> {
    let rc = unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            level,
            name,
            std::ptr::from_ref(value).cast::<libc::c_void>(),
            std::mem::size_of::<T>() as libc::socklen_t,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn create_raw_socket(family: IpFamily, protocol: Protocol) -> io::Result<Socket> {
    let socket = Socket::new(family.domain(), Type::RAW, Some(protocol))?;
    socket.set_nonblocking(true)?;
    Ok(socket)
}

pub(crate) fn set_hop_limit(socket: &Socket, family: IpFamily, hops: u8) -> io::Result<()> {
    match family {
        IpFamily::V4 => socket.set_ttl_v4(u32::from(hops)),
        IpFamily::V6 => socket.set_unicast_hops_v6(u32::from(hops)),
    }
}

/// Raw socket for the ICMP errors that may quote a probe of `family`.
pub(crate) fn open_icmp_error_socket(family: IpFamily) -> io::Result<Socket> {
    let socket = create_raw_socket(family, family.icmp_protocol())?;
    if family == IpFamily::V6 {
        set_icmpv6_error_filter(&socket)?;
    }
    Ok(socket)
}

/// Raw TCP socket that sends from the flow's source without fragmenting and only wakes for the
/// flow's replies.
pub(crate) fn open_tcp_socket(flow: &ProbeFlow) -> io::Result<Socket> {
    let socket = create_raw_socket(flow.family(), Protocol::TCP)?;
    // The kernel must stamp the same source address the TCP pseudo-header checksum used; on a
    // multi-homed or policy-routed host it could otherwise pick another one, which invalidates the
    // checksum and makes ICMP quotes (matched on the inner source) unrecognizable. Per raw(7), with
    // IP_HDRINCL off the kernel builds the header and honors the bound local address.
    socket.bind(&SockAddr::from(SocketAddr::new(flow.source_ip(), 0)))?;
    set_dont_fragment(&socket, flow.family())?;
    attach_tcp_probe_filter(&socket, flow)?;
    Ok(socket)
}

/// Binds an unconnected stream socket to an ephemeral port on `source_ip` so the kernel hands that
/// port to nobody else while a probe uses it. Keep the socket alive for the probe's duration.
pub(crate) fn reserve_source_port(source_ip: IpAddr) -> io::Result<(Socket, u16)> {
    let local = SocketAddr::new(source_ip, 0);
    let socket = Socket::new(
        IpFamily::of(source_ip).domain(),
        Type::STREAM,
        Some(Protocol::TCP),
    )?;
    socket.bind(&SockAddr::from(local))?;
    let port = socket
        .local_addr()?
        .as_socket()
        .map(|addr| addr.port())
        .filter(|port| *port != 0)
        .ok_or_else(|| io::Error::other("failed to read reserved source port"))?;
    Ok((socket, port))
}
