use std::{io, net::SocketAddr, time::Duration};

use serde_json::Value;
use socket2::Socket;
use tokio::io::unix::AsyncFd;

use super::{
    clamp_error,
    family::{FamilyPolicy, IpFamily, resolve_first},
    outcome::ProbeOutcome,
    raw_socket::{async_recv_from, async_send_to, probe_origin_addr, transport_payload},
    remaining_until,
    sampling::{SAMPLE_INTERVAL, compute_stats, sample_count},
    tcp::classify_tcp_io_error,
    tcp_raw::{
        ProbeFlow, QuoteKind, TCP_RST, Unreachable, is_message_too_long, open_icmp_error_socket,
        open_tcp_socket, parse_tcp_segment, reserve_source_port, set_hop_limit,
    },
};

pub(crate) const TCP_PACKET_SIZE_SUPPORTED: bool = cfg!(target_os = "linux");

const SYN_HOP_LIMIT: u8 = 64;

/// Sends a series of raw SYNs of exactly `packet_size` bytes to the first `family` address of
/// `host` and reports SYN-ACK latency, loss and jitter.
pub(crate) async fn probe(
    host: &str,
    port: u16,
    family: IpFamily,
    packet_size: u16,
    deadline: tokio::time::Instant,
) -> ProbeOutcome {
    let mut extra = serde_json::json!({
        "kind": "tcp",
        "family": family.label(),
        "packet_size_bytes": packet_size,
    });
    if !TCP_PACKET_SIZE_SUPPORTED {
        return ProbeOutcome::failure("unsupported_platform").with_extra(extra);
    }

    let target_ip = match resolve_first(host, FamilyPolicy::Only(family), deadline).await {
        Ok(ip) => ip,
        Err(err) => {
            add_failure_context(&mut extra, host, port, err.code, &err.detail);
            return ProbeOutcome::failure(err.code).with_extra(extra);
        }
    };
    let addr = SocketAddr::new(target_ip, port);
    extra["addr"] = Value::String(addr.to_string());

    let samples = run_series(addr, packet_size, deadline).await;
    summarize(&samples, host, port, extra)
}

/// Why a SYN sample got no SYN-ACK.
#[derive(Debug)]
enum SynError {
    /// The target answered with RST: the path works, the port does not accept.
    Refused,
    /// The packet exceeds the path MTU, from an ICMP report or the kernel's cached path MTU.
    PacketTooBig {
        path_mtu: Option<u32>,
    },
    Unreachable(Unreachable),
    TimeExceeded,
    Timeout,
    Local(io::Error),
}

impl SynError {
    fn code(&self) -> &'static str {
        match self {
            Self::Refused => "connection_refused",
            Self::PacketTooBig { .. } => "packet_too_large",
            Self::Unreachable(reason) => reason.code(),
            Self::TimeExceeded => "dest_unreachable",
            Self::Timeout => "timeout",
            Self::Local(err) => classify_tcp_io_error(err),
        }
    }

    fn message(&self) -> String {
        match self {
            Self::Refused => "connection refused".to_string(),
            Self::PacketTooBig {
                path_mtu: Some(mtu),
            } => format!("packet too big for path MTU {mtu}"),
            Self::PacketTooBig { path_mtu: None } => "packet too big for path MTU".to_string(),
            Self::Unreachable(reason) => format!("ICMP {}", reason.code()),
            Self::TimeExceeded => "ICMP time exceeded".to_string(),
            Self::Timeout => "timeout".to_string(),
            Self::Local(err) => err.to_string(),
        }
    }

    /// Precedence when one error has to explain a series without any SYN-ACK.
    fn rank(&self) -> u8 {
        match self {
            Self::PacketTooBig { .. } => 4,
            Self::Refused => 3,
            Self::Unreachable(_) | Self::TimeExceeded => 2,
            Self::Local(_) => 1,
            Self::Timeout => 0,
        }
    }
}

impl From<io::Error> for SynError {
    fn from(err: io::Error) -> Self {
        if is_message_too_long(&err) {
            Self::PacketTooBig { path_mtu: None }
        } else {
            Self::Local(err)
        }
    }
}

impl From<QuoteKind> for SynError {
    fn from(kind: QuoteKind) -> Self {
        match kind {
            QuoteKind::TimeExceeded => Self::TimeExceeded,
            QuoteKind::PacketTooBig { mtu } => Self::PacketTooBig { path_mtu: mtu },
            QuoteKind::Unreachable(reason) => Self::Unreachable(reason),
        }
    }
}

#[derive(Debug)]
enum Sample {
    SynAck(Duration),
    /// The SYN left the host and got no SYN-ACK.
    Sent(SynError),
    /// The SYN never left the host.
    NotSent(SynError),
}

async fn run_series(
    addr: SocketAddr,
    packet_size: u16,
    deadline: tokio::time::Instant,
) -> Vec<Sample> {
    let count = sample_count(remaining_until(deadline));
    let per_sample = remaining_until(deadline) / u32::from(count);
    let mut samples = Vec::with_capacity(usize::from(count));

    for index in 0..count {
        let remaining = remaining_until(deadline);
        if remaining.is_zero() {
            break;
        }
        let sample_deadline = tokio::time::Instant::now() + per_sample.min(remaining);
        let sample = probe_once(addr, packet_size, sample_deadline).await;
        // A SYN that never left the host fails the same way every time.
        let stop = matches!(sample, Sample::NotSent(_));
        samples.push(sample);
        if stop {
            break;
        }

        if index + 1 < count {
            let pause = SAMPLE_INTERVAL.min(remaining_until(deadline));
            if !pause.is_zero() {
                tokio::time::sleep(pause).await;
            }
        }
    }

    samples
}

/// One SYN from a freshly reserved source port. Reusing a port across samples would hit the
/// target's SYN-RECEIVED state from the previous SYN and read as a refusal.
async fn probe_once(addr: SocketAddr, packet_size: u16, deadline: tokio::time::Instant) -> Sample {
    let Some(source_ip) = probe_origin_addr(addr.ip()).await else {
        return Sample::NotSent(SynError::Local(io::Error::new(
            io::ErrorKind::NetworkUnreachable,
            "no route to target",
        )));
    };
    // Keep the reservation alive until this sample completes or is cancelled.
    let (_reserved, source_port) = match reserve_source_port(source_ip) {
        Ok(reservation) => reservation,
        Err(err) => return Sample::NotSent(err.into()),
    };
    let Some(flow) = ProbeFlow::new(source_ip, addr.ip(), source_port, addr.port()) else {
        return Sample::NotSent(SynError::Local(io::Error::other(
            "source address family differs from the target's",
        )));
    };
    let (icmp, tcp) = match open_sockets(&flow) {
        Ok(sockets) => sockets,
        Err(err) => return Sample::NotSent(err.into()),
    };
    exchange(&flow, &icmp, &tcp, packet_size, deadline).await
}

fn open_sockets(flow: &ProbeFlow) -> io::Result<(AsyncFd<Socket>, AsyncFd<Socket>)> {
    let icmp = AsyncFd::new(open_icmp_error_socket(flow.family())?)?;
    let tcp = open_tcp_socket(flow)?;
    set_hop_limit(&tcp, flow.family(), SYN_HOP_LIMIT)?;
    Ok((icmp, AsyncFd::new(tcp)?))
}

async fn exchange(
    flow: &ProbeFlow,
    icmp: &AsyncFd<Socket>,
    tcp: &AsyncFd<Socket>,
    packet_size: u16,
    deadline: tokio::time::Instant,
) -> Sample {
    let family = flow.family();
    let dest = flow.target_sockaddr();
    let seq = fastrand::u32(..);
    let sent_at = std::time::Instant::now();
    if let Err(err) = async_send_to(tcp, &flow.syn(seq, packet_size), &dest).await {
        return Sample::NotSent(err.into());
    }

    let mut tcp_buf = [0u8; 2048];
    let mut icmp_buf = [0u8; 2048];
    loop {
        tokio::select! {
            received = async_recv_from(tcp, &mut tcp_buf) => {
                let (len, from) = match received {
                    Ok(received) => received,
                    Err(err) => return Sample::Sent(SynError::Local(err)),
                };
                if from != flow.target_ip() { continue; }
                let Some(response) = parse_tcp_segment(transport_payload(family, &tcp_buf[..len])) else { continue; };
                if !flow.matches_response(&response, seq, packet_size) { continue; }
                let rtt = sent_at.elapsed();
                if response.flags & TCP_RST != 0 {
                    return Sample::Sent(SynError::Refused);
                }
                // Cleanup is best effort and must not delay or change the measured result.
                let _ = tcp.get_ref().send_to(&flow.reset(response.ack), &dest);
                return Sample::SynAck(rtt);
            }
            received = async_recv_from(icmp, &mut icmp_buf) => {
                let (len, _) = match received {
                    Ok(received) => received,
                    Err(err) => return Sample::Sent(SynError::Local(err)),
                };
                let Some(quote) = flow.match_icmp_quote(transport_payload(family, &icmp_buf[..len])) else { continue; };
                if quote.inner_seq != seq || quote.inner_total_length != packet_size { continue; }
                return Sample::Sent(quote.kind.into());
            }
            () = tokio::time::sleep_until(deadline) => return Sample::Sent(SynError::Timeout),
        }
    }
}

/// Success when any SYN-ACK arrived. Loss counts sent SYNs the target never answered; an RST is
/// an answer, so it is not loss, but only SYN-ACKs measure latency and jitter.
fn summarize(samples: &[Sample], host: &str, port: u16, mut extra: Value) -> ProbeOutcome {
    let mut rtts = Vec::with_capacity(samples.len());
    let mut sent = 0u8;
    let mut received = 0u8;
    let mut worst: Option<&SynError> = None;
    let mut path_mtu = None;

    for sample in samples {
        let error = match sample {
            Sample::SynAck(rtt) => {
                sent += 1;
                received += 1;
                rtts.push(*rtt);
                continue;
            }
            Sample::Sent(error) => {
                sent += 1;
                if matches!(error, SynError::Refused) {
                    received += 1;
                }
                error
            }
            Sample::NotSent(error) => error,
        };
        if let SynError::PacketTooBig {
            path_mtu: Some(mtu),
        } = error
        {
            path_mtu = Some(*mtu);
        }
        if worst.is_none_or(|current| error.rank() > current.rank()) {
            worst = Some(error);
        }
    }

    extra["sent"] = Value::from(sent);
    extra["received"] = Value::from(received);
    if let Some(mtu) = path_mtu {
        extra["path_mtu_bytes"] = Value::from(mtu);
    }

    let stats = (sent > 0).then(|| compute_stats(sent, received, &rtts));
    let mut outcome = if rtts.is_empty() {
        let (code, message) = worst.map_or(("timeout", "timeout".to_string()), |error| {
            (error.code(), error.message())
        });
        add_failure_context(&mut extra, host, port, code, &message);
        ProbeOutcome::failure(code).with_extra(extra)
    } else {
        let avg_rtt_ms = stats.as_ref().map_or(0, |stats| stats.avg_rtt_ms);
        ProbeOutcome::success(avg_rtt_ms).with_extra(extra)
    };

    if let Some(stats) = stats {
        outcome = outcome.with_loss_pct(stats.loss_pct);
        if let Some(jitter) = stats.jitter_ms {
            outcome = outcome.with_jitter_ms(jitter);
        }
    }
    outcome
}

fn add_failure_context(extra: &mut Value, host: &str, port: u16, code: &str, message: &str) {
    extra["host"] = Value::String(host.to_string());
    extra["port"] = Value::from(port);
    extra["last_error"] = serde_json::json!({
        "kind": code,
        "message": clamp_error(message),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(samples: &[Sample]) -> crate::protocol::ProbeResultBody {
        let extra =
            serde_json::json!({ "kind": "tcp", "family": "ipv6", "packet_size_bytes": 1400 });
        summarize(samples, "example.com", 443, extra).into_result_body("task".to_string(), 0)
    }

    #[test]
    fn series_reports_latency_loss_and_jitter_from_syn_acks() {
        let result = summary(&[
            Sample::SynAck(Duration::from_millis(10)),
            Sample::Sent(SynError::Timeout),
            Sample::SynAck(Duration::from_millis(20)),
            Sample::Sent(SynError::Refused),
            Sample::SynAck(Duration::from_millis(30)),
        ]);

        assert!(result.ok);
        assert_eq!(result.latency_ms, Some(20));
        // The RST is an answer: only the timed-out SYN is lost.
        assert!((result.loss_pct.unwrap() - 20.0).abs() < 1e-9);
        assert!((result.jitter_ms.unwrap() - 10.0).abs() < 1e-9);
        let extra = result.extra.unwrap();
        assert_eq!(extra["sent"], 5);
        assert_eq!(extra["received"], 4);
        assert!(extra.get("last_error").is_none());
    }

    #[test]
    fn refused_series_is_a_failure_without_loss() {
        let result = summary(&[
            Sample::Sent(SynError::Refused),
            Sample::Sent(SynError::Timeout),
            Sample::Sent(SynError::Refused),
        ]);

        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some("connection_refused"));
        assert!((result.loss_pct.unwrap() - 100.0 / 3.0).abs() < 1e-9);
        let extra = result.extra.unwrap();
        assert_eq!(extra["last_error"]["kind"], "connection_refused");
        assert_eq!(extra["host"], "example.com");
    }

    #[test]
    fn packet_too_big_explains_the_series_and_keeps_the_path_mtu() {
        let result = summary(&[
            Sample::Sent(SynError::PacketTooBig {
                path_mtu: Some(1280),
            }),
            Sample::NotSent(SynError::PacketTooBig { path_mtu: None }),
        ]);

        assert!(!result.ok);
        assert_eq!(result.error.as_deref(), Some("packet_too_large"));
        assert!((result.loss_pct.unwrap() - 100.0).abs() < 1e-9);
        let extra = result.extra.unwrap();
        assert_eq!(extra["path_mtu_bytes"], 1280);
        assert_eq!(extra["sent"], 1);
    }

    #[test]
    fn local_failures_report_no_loss() {
        let denied = io::Error::from(io::ErrorKind::PermissionDenied);
        let result = summary(&[Sample::NotSent(denied.into())]);
        assert_eq!(result.error.as_deref(), Some("permission_denied"));
        assert!(result.loss_pct.is_none());

        let result = summary(&[]);
        assert_eq!(result.error.as_deref(), Some("timeout"));
        assert!(result.loss_pct.is_none());
    }

    #[test]
    fn icmp_reports_map_to_specific_errors() {
        let too_big = SynError::from(QuoteKind::PacketTooBig { mtu: Some(1400) });
        assert_eq!(too_big.code(), "packet_too_large");
        assert_eq!(
            SynError::from(io::Error::from_raw_os_error(libc::EMSGSIZE)).code(),
            "packet_too_large"
        );
        assert_eq!(
            SynError::from(QuoteKind::Unreachable(Unreachable::AdminProhibited)).code(),
            "admin_prohibited"
        );
        assert_eq!(
            SynError::from(QuoteKind::TimeExceeded).code(),
            "dest_unreachable"
        );
    }
}
