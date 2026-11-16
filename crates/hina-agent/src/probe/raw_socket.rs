use socket2::Socket;
use std::{
    io,
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
};
use tokio::io::unix::AsyncFd;

use super::family::IpFamily;

const IPV4_HEADER_MIN_LEN: usize = 20;

/// The transport header onward of a datagram read from a raw socket of `family`: IPv4 raw sockets
/// deliver the IP header, IPv6 raw sockets never do.
pub(crate) fn transport_payload(family: IpFamily, buf: &[u8]) -> &[u8] {
    match family {
        IpFamily::V4 => strip_ipv4_header(buf),
        IpFamily::V6 => buf,
    }
}

fn strip_ipv4_header(buf: &[u8]) -> &[u8] {
    if buf.len() < IPV4_HEADER_MIN_LEN {
        return &[];
    }
    let ihl = (buf[0] & 0x0F) as usize * 4;
    if buf.len() < ihl {
        return &[];
    }
    &buf[ihl..]
}

pub(crate) async fn async_send_to(
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

pub(crate) async fn async_recv_from(
    fd: &AsyncFd<Socket>,
    buf: &mut [u8],
) -> io::Result<(usize, IpAddr)> {
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

/// Source address the kernel would pick for `target_ip`; `None` when there is no route.
pub(crate) async fn probe_origin_addr(target_ip: IpAddr) -> Option<IpAddr> {
    let bind_ip = match target_ip {
        IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::UNSPECIFIED),
    };
    let socket = tokio::net::UdpSocket::bind((bind_ip, 0)).await.ok()?;
    socket.connect((target_ip, 33434)).await.ok()?;
    socket.local_addr().ok().map(|local| local.ip())
}
