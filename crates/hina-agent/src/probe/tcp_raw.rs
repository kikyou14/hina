use std::{
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    os::fd::AsRawFd,
};

use socket2::{Domain, Protocol, SockAddr, Socket, Type};

// TCP header layout (no options): fixed 20-byte header.
const TCP_HEADER_LEN: usize = 20;
const IPV4_HEADER_LEN: u16 = 20;
const TCP_WINDOW: u16 = 65535;

// TCP flag bits.
pub(crate) const TCP_SYN: u8 = 0x02;
pub(crate) const TCP_RST: u8 = 0x04;
pub(crate) const TCP_ACK: u8 = 0x10;

// ICMP message types / codes relevant to TCP quotes.
pub(crate) const ICMP_DEST_UNREACHABLE: u8 = 3;
pub(crate) const ICMP_TIME_EXCEEDED: u8 = 11;
pub(crate) const ICMP_CODE_FRAGMENTATION_NEEDED: u8 = 4;
const IP_PROTO_TCP: u8 = 6;

/// Payload length carried after the 20-byte TCP header for a given IPv4 total
/// length. `packet_size` is validated to be >= 40, so this never underflows.
pub(crate) fn payload_len_for(packet_size: u16) -> usize {
    packet_size as usize - IPV4_HEADER_LEN as usize - TCP_HEADER_LEN
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
pub(crate) fn attach_tcp_probe_filter(
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

/// Callers reject unsupported platforms before creating raw TCP probes.
#[cfg(not(target_os = "linux"))]
pub(crate) fn attach_tcp_probe_filter(
    _socket: &Socket,
    _target_ip: Ipv4Addr,
    _dest_port: u16,
    _source_port: u16,
) -> io::Result<()> {
    Ok(())
}

#[cfg(target_os = "linux")]
pub(crate) fn set_dont_fragment(socket: &Socket) -> io::Result<()> {
    // IP_MTU_DISCOVER = IP_PMTUDISC_DO sets DF and disables fragmentation.
    let value: libc::c_int = libc::IP_PMTUDISC_DO;
    setsockopt_int(socket, libc::IPPROTO_IP, libc::IP_MTU_DISCOVER, value)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn set_dont_fragment(socket: &Socket) -> io::Result<()> {
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

pub(crate) fn create_raw_socket(protocol: Protocol) -> io::Result<Socket> {
    let socket = Socket::new(Domain::IPV4, Type::RAW, Some(protocol))?;
    socket.set_nonblocking(true)?;
    Ok(socket)
}

pub(crate) fn reserve_source_port(source_ip: Ipv4Addr) -> io::Result<Socket> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, Some(Protocol::TCP))?;
    socket.bind(&SockAddr::from(SocketAddr::new(IpAddr::V4(source_ip), 0)))?;
    Ok(socket)
}

pub(crate) fn reserved_port(socket: &Socket) -> io::Result<u16> {
    socket
        .local_addr()?
        .as_socket_ipv4()
        .map(|addr| addr.port())
        .filter(|port| *port != 0)
        .ok_or_else(|| io::Error::other("failed to read reserved source port"))
}
