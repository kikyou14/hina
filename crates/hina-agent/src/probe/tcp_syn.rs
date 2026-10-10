use std::{
    io,
    net::{IpAddr, SocketAddr, SocketAddrV4},
};

use socket2::{Protocol, SockAddr};
use tokio::io::unix::AsyncFd;

use super::{
    raw_socket::{async_recv_from, async_send_to, probe_origin_ip, strip_ip_header},
    tcp_raw::{
        ICMP_CODE_FRAGMENTATION_NEEDED, ICMP_DEST_UNREACHABLE, IcmpQuoteMatch, TCP_RST,
        TcpResponse, attach_tcp_probe_filter, build_tcp_reset, build_tcp_syn, create_raw_socket,
        parse_icmp_tcp_quote, parse_tcp_segment, reserve_source_port, reserved_port,
        set_dont_fragment, tcp_response_matches_probe,
    },
};

pub(crate) const TCP_PACKET_SIZE_SUPPORTED: bool = cfg!(target_os = "linux");

pub(crate) async fn probe_once(
    addr: SocketAddr,
    packet_size: u16,
    deadline: tokio::time::Instant,
) -> io::Result<u64> {
    let SocketAddr::V4(addr) = addr else {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "TCP packet size probes require IPv4",
        ));
    };
    tokio::time::timeout_at(deadline, run(addr, packet_size))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "timeout"))?
}

async fn run(addr: SocketAddrV4, packet_size: u16) -> io::Result<u64> {
    let target_ip = *addr.ip();
    let source_ip = probe_origin_ip(target_ip)
        .await
        .ok_or_else(|| io::Error::other("failed to determine source IPv4"))?;
    // Keep the reservation alive until this attempt completes or is cancelled.
    let reserved = reserve_source_port(source_ip)?;
    let source_port = reserved_port(&reserved)?;
    let icmp = AsyncFd::new(create_raw_socket(Protocol::ICMPV4)?)?;
    let socket = create_raw_socket(Protocol::TCP)?;
    // The kernel must use the same source address as our TCP pseudo-header.
    socket.bind(&SockAddr::from(SocketAddr::new(IpAddr::V4(source_ip), 0)))?;
    socket.set_ttl_v4(64)?;
    set_dont_fragment(&socket)?;
    attach_tcp_probe_filter(&socket, target_ip, addr.port(), source_port)?;
    let tcp = AsyncFd::new(socket)?;
    let dest = SockAddr::from(SocketAddr::new(IpAddr::V4(target_ip), 0));
    let seq = fastrand::u32(..);
    let segment = build_tcp_syn(
        source_ip,
        target_ip,
        source_port,
        addr.port(),
        seq,
        packet_size,
    );
    let sent_at = std::time::Instant::now();
    async_send_to(&tcp, &segment, &dest).await?;

    let mut tcp_buf = [0u8; 2048];
    let mut icmp_buf = [0u8; 2048];
    loop {
        tokio::select! {
            received = async_recv_from(&tcp, &mut tcp_buf) => {
                let (len, from) = received?;
                if from != IpAddr::V4(target_ip) { continue; }
                let Some(response) = parse_tcp_segment(strip_ip_header(&tcp_buf[..len])) else { continue; };
                if !tcp_response_matches_probe(&response, addr.port(), source_port, seq, packet_size) { continue; }
                let latency_ms = sent_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
                tcp_response_result(&response)?;
                let reset = build_tcp_reset(source_ip, target_ip, source_port, addr.port(), response.ack);
                // Cleanup is best effort and must not delay or change the measured result.
                let _ = tcp.get_ref().send_to(&reset, &dest);
                return Ok(latency_ms);
            }
            received = async_recv_from(&icmp, &mut icmp_buf) => {
                let (len, _) = received?;
                let Some(quote) = parse_icmp_tcp_quote(strip_ip_header(&icmp_buf[..len]),
                    source_ip, target_ip, source_port, addr.port()) else { continue; };
                if quote.inner_seq != seq || quote.inner_total_length != packet_size { continue; }
                return Err(icmp_error(&quote));
            }
        }
    }
}

fn tcp_response_result(response: &TcpResponse) -> io::Result<()> {
    if response.flags & TCP_RST != 0 {
        Err(io::ErrorKind::ConnectionRefused.into())
    } else {
        Ok(())
    }
}

fn icmp_error(quote: &IcmpQuoteMatch) -> io::Error {
    if quote.icmp_type == ICMP_DEST_UNREACHABLE && quote.icmp_code == ICMP_CODE_FRAGMENTATION_NEEDED
    {
        return io::Error::from_raw_os_error(libc::EMSGSIZE);
    }
    if quote.icmp_type == ICMP_DEST_UNREACHABLE && matches!(quote.icmp_code, 9 | 10 | 13) {
        return io::Error::new(
            io::ErrorKind::PermissionDenied,
            "probe blocked by network policy",
        );
    }
    io::Error::new(
        io::ErrorKind::HostUnreachable,
        format!(
            "ICMP error type={} code={}",
            quote.icmp_type, quote.icmp_code
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::super::tcp_raw::{TCP_ACK, TCP_SYN};
    use super::*;

    #[test]
    fn reset_is_failure_even_though_traceroute_counts_it_as_reached() {
        let response = TcpResponse {
            src_port: 443,
            dst_port: 40000,
            ack: 1,
            flags: TCP_RST | TCP_ACK,
        };
        assert_eq!(
            tcp_response_result(&response).unwrap_err().kind(),
            io::ErrorKind::ConnectionRefused
        );
        assert!(
            tcp_response_result(&TcpResponse {
                flags: TCP_SYN | TCP_ACK,
                ..response
            })
            .is_ok()
        );
    }

    #[test]
    fn fragmentation_needed_preserves_packet_too_large_error() {
        let quote = IcmpQuoteMatch {
            icmp_type: 3,
            icmp_code: 4,
            inner_seq: 1,
            inner_total_length: 1200,
            next_hop_mtu: Some(1000),
        };
        assert_eq!(
            super::super::tcp::classify_tcp_io_error(&icmp_error(&quote)),
            "packet_too_large"
        );
    }
}
