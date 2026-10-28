use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::{Instant, timeout};
use tokio_tungstenite::tungstenite::Error as WsError;
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::{Connector, MaybeTlsStream, WebSocketStream};
use url::{Host, Url};

use crate::collector::TelemetryCollector;
use crate::config::{AgentConfig, parse_mount_points};
use crate::probe::{ApplyConfigResult, ProbeRunner};
use crate::protocol::{
    ErrorBody, HelloBody, IpUpdateBody, MessageType, ProbeConfigBody, TelemetryBody, WelcomeBody,
    WelcomeCfg, decode_envelope, encode_envelope,
};

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
type WsSink = SplitSink<WsStream, Message>;

const MIN_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
// A session that stayed authenticated this long ended for a new reason (outage, server restart),
// so the next attempt starts from MIN_BACKOFF. Shorter sessions keep backing off even when the
// server closed them cleanly, so two agents sharing a token settle at MAX_BACKOFF instead of
// replacing each other every second; that relies on MAX_BACKOFF staying below this value.
const STABLE_SESSION: Duration = Duration::from_secs(60);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUTS: ConnectTimeouts = ConnectTimeouts {
    dns: Duration::from_secs(10),
    tcp: Duration::from_secs(5),
    handshake: Duration::from_secs(10),
};

#[derive(Clone, Copy)]
struct ConnectTimeouts {
    dns: Duration,
    tcp: Duration,
    handshake: Duration,
}

pub async fn run_agent(
    config: AgentConfig,
    update_rx: &mut mpsc::Receiver<PathBuf>,
) -> anyhow::Result<Option<PathBuf>> {
    let connector = if config.insecure {
        tracing::warn!(
            "TLS certificate verification is disabled for server connection (--insecure)"
        );
        Some(crate::tls::insecure_connector())
    } else {
        None
    };

    let mut backoff = MIN_BACKOFF;

    loop {
        if let Ok(path) = update_rx.try_recv() {
            return Ok(Some(path));
        }

        let mut authed_at = None;
        let result = run_session(&config, connector.clone(), update_rx, &mut authed_at).await;
        if config.once {
            return result;
        }

        match result {
            update @ Ok(Some(_)) => return update,
            Ok(None) => {}
            Err(err) => {
                tracing::warn!(error = %format_args!("{err:#}"), "ws session ended with error");
            }
        }
        backoff = next_backoff(backoff, authed_at.map(|at| at.elapsed()));

        let jitter_ms = fastrand::u64(0..=250);
        tokio::time::sleep(backoff + Duration::from_millis(jitter_ms)).await;
    }
}

fn next_backoff(prev: Duration, authed_for: Option<Duration>) -> Duration {
    if authed_for.is_some_and(|elapsed| elapsed >= STABLE_SESSION) {
        MIN_BACKOFF
    } else {
        (prev * 2).min(MAX_BACKOFF)
    }
}

async fn run_session(
    config: &AgentConfig,
    connector: Option<Connector>,
    update_rx: &mut mpsc::Receiver<PathBuf>,
    authed_at: &mut Option<Instant>,
) -> anyhow::Result<Option<PathBuf>> {
    let server_url = Url::parse(&config.server_url).context("invalid server_url")?;
    tracing::info!(server_url = %config.server_url, "connecting");

    let interface = config.interface.clone();
    let mut ip_task =
        tokio::spawn(async move { crate::ip_resolve::resolve_ips(interface.as_deref()).await });

    let ws_stream = match connect_ws(&server_url, connector, CONNECT_TIMEOUTS).await {
        Ok(ws_stream) => ws_stream,
        Err(err) => {
            ip_task.abort();
            return Err(err.context("connect failed"));
        }
    };
    let (mut ws_write, mut ws_read) = ws_stream.split();

    let mount_points = config.mount_points.as_deref().map(parse_mount_points);
    let mut collector = TelemetryCollector::new(mount_points);
    let inventory = Some(collector.collect_inventory().value);

    let resolved = tokio::select! {
        result = &mut ip_task => match result {
            Ok(ips) => ips,
            Err(_) => crate::ip_resolve::ResolvedIps { v4: None, v6: None },
        },
        _ = tokio::time::sleep(Duration::from_secs(8)) => {
            ip_task.abort();
            tracing::warn!("IP resolution not ready in time, sending HELLO without IPs");
            crate::ip_resolve::ResolvedIps { v4: None, v6: None }
        }
    };
    tracing::info!(ipv4 = ?resolved.v4, ipv6 = ?resolved.v6, "resolved IPs");

    let hello = HelloBody {
        token: config.token.clone(),
        agent_id: None,
        agent_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        host: sysinfo::System::host_name(),
        os: build_os_string(),
        arch: Some(std::env::consts::ARCH.to_string()),
        inventory,
        capabilities: Some(default_capabilities()),
        extra: None,
        ipv4: resolved.v4,
        ipv6: resolved.v6,
    };

    let hello_bytes = encode_envelope(MessageType::Hello, &hello)?;
    send_with_timeout(&mut ws_write, Message::Binary(hello_bytes.into()))
        .await
        .context("send HELLO failed")?;

    let welcome = recv_welcome(&mut ws_read, Duration::from_secs(5)).await?;
    *authed_at = Some(Instant::now());
    tracing::info!(
        agent_id = %welcome.agent_id,
        t_ms = welcome.cfg.telemetry_interval_ms,
        j_ms = welcome.cfg.telemetry_jitter_ms,
        "authenticated",
    );
    let interval_ms = welcome.cfg.telemetry_interval_ms.max(1000);
    let jitter_ms = welcome.cfg.telemetry_jitter_ms.min(60_000);

    let (out_tx, mut out_rx) = mpsc::channel::<Message>(256);
    let mut probe_runner = ProbeRunner::new(out_tx);

    let mut seq: u64 = 0;
    let mut current_interval_ms = interval_ms;
    let mut current_jitter_ms = jitter_ms;
    let next_send = tokio::time::sleep(Duration::from_millis(0));
    tokio::pin!(next_send);

    const IP_REFRESH_INTERVAL: Duration = Duration::from_secs(10 * 60);
    const IP_RETRY_MIN: Duration = Duration::from_secs(30);
    const PING_INTERVAL: Duration = Duration::from_secs(30);
    const READ_TIMEOUT: Duration = Duration::from_secs(90);
    let hello_ips_incomplete = hello.ipv4.is_none() || hello.ipv6.is_none();
    let mut ip_retry_backoff = IP_RETRY_MIN;
    let initial_ip_delay = if hello_ips_incomplete {
        IP_RETRY_MIN
    } else {
        IP_REFRESH_INTERVAL
    };
    let ip_refresh_sleep = tokio::time::sleep(initial_ip_delay);
    tokio::pin!(ip_refresh_sleep);
    let interface_for_refresh = config.interface.clone();
    let mut pending_ip_task: Option<AbortOnDrop> = None;
    let mut last_sent_ips = crate::ip_resolve::ResolvedIps {
        v4: hello.ipv4.clone(),
        v6: hello.ipv6.clone(),
    };
    let mut update_listening = true;

    let ping_timer = tokio::time::sleep(PING_INTERVAL);
    tokio::pin!(ping_timer);
    let read_deadline = tokio::time::sleep(READ_TIMEOUT);
    tokio::pin!(read_deadline);

    loop {
        tokio::select! {
            _ = &mut next_send => {
                let snap = collector.collect_telemetry();
                let body = TelemetryBody {
                    agent_id: None,
                    seq,
                    uptime_seconds: snap.uptime_seconds,
                    rx_bytes_total: snap.rx_bytes_total,
                    tx_bytes_total: snap.tx_bytes_total,
                    metrics: snap.metrics,
                    extra: None,
                };

                let bytes = encode_envelope(MessageType::Telemetry, &body)?;
                send_with_timeout(&mut ws_write, Message::Binary(bytes.into()))
                    .await
                    .context("send TELEMETRY failed")?;

                seq = seq.wrapping_add(1);

                #[cfg(unix)]
                if seq == 1 {
                    crate::updater::confirm_update();
                }

                if config.once {
                    send_with_timeout(&mut ws_write, Message::Close(None)).await.ok();
                    return Ok(None);
                }

                let sleep_ms = current_interval_ms + fastrand::u64(0..=current_jitter_ms);
                next_send.as_mut().reset(Instant::now() + Duration::from_millis(sleep_ms));
            }

            _ = &mut ping_timer => {
                send_with_timeout(&mut ws_write, Message::Ping(vec![].into()))
                    .await
                    .context("send PING failed")?;
                ping_timer.as_mut().reset(Instant::now() + PING_INTERVAL);
            }

            _ = &mut ip_refresh_sleep, if pending_ip_task.is_none() => {
                let iface = interface_for_refresh.clone();
                pending_ip_task = Some(AbortOnDrop(tokio::spawn(async move {
                    crate::ip_resolve::resolve_ips(iface.as_deref()).await
                })));
            }

            result = async { (&mut pending_ip_task.as_mut().unwrap().0).await }, if pending_ip_task.is_some() => {
                pending_ip_task = None;
                let resolved = match result {
                    Ok(ips) => ips,
                    Err(e) => {
                        tracing::warn!(error = %e, "IP refresh task failed");
                        ip_refresh_sleep.as_mut().reset(Instant::now() + ip_retry_backoff);
                        ip_retry_backoff = (ip_retry_backoff * 2).min(IP_REFRESH_INTERVAL);
                        continue;
                    }
                };
                let next_delay = if resolved.v4.is_some() && resolved.v6.is_some() {
                    ip_retry_backoff = IP_RETRY_MIN;
                    IP_REFRESH_INTERVAL
                } else {
                    let delay = ip_retry_backoff;
                    ip_retry_backoff = (ip_retry_backoff * 2).min(IP_REFRESH_INTERVAL);
                    delay
                };
                ip_refresh_sleep.as_mut().reset(Instant::now() + next_delay);
                if resolved != last_sent_ips {
                    tracing::info!(ipv4 = ?resolved.v4, ipv6 = ?resolved.v6, "IPs changed, sending update");
                    let body = IpUpdateBody {
                        ipv4: resolved.v4.clone(),
                        ipv6: resolved.v6.clone(),
                    };
                    last_sent_ips = resolved;
                    let bytes = encode_envelope(MessageType::IpUpdate, &body)?;
                    send_with_timeout(&mut ws_write, Message::Binary(bytes.into()))
                        .await
                        .context("send IP_UPDATE failed")?;
                } else {
                    tracing::debug!("IPs unchanged, skipping update");
                }
            }

            outbound = out_rx.recv() => {
                let Some(msg) = outbound else {
                    return Ok(None);
                };
                send_with_timeout(&mut ws_write, msg).await.context("ws write failed")?;
            }

            msg = ws_read.next() => {
                let Some(result) = msg else {
                    probe_runner.shutdown();
                    return Ok(None);
                };
                let message = result.context("ws read error")?;
                read_deadline.as_mut().reset(Instant::now() + READ_TIMEOUT);
                let next_runtime = handle_incoming(&mut probe_runner, message)?;
                if !next_runtime.keep_running {
                    probe_runner.shutdown();
                    return Ok(None);
                }
                if let Some(cfg) = next_runtime.runtime_cfg {
                    current_interval_ms = cfg.telemetry_interval_ms.max(1000);
                    current_jitter_ms = cfg.telemetry_jitter_ms.min(60_000);
                    next_send.as_mut().reset(
                        Instant::now() + Duration::from_millis(current_interval_ms + fastrand::u64(0..=current_jitter_ms)),
                    );
                }
            }

            _ = &mut read_deadline => {
                anyhow::bail!("no data from server in {READ_TIMEOUT:?}, assuming dead connection");
            }

            path = update_rx.recv(), if update_listening => {
                match path {
                    Some(path) => {
                        tracing::info!("update ready, shutting down gracefully");
                        send_with_timeout(&mut ws_write, Message::Close(None)).await.ok();
                        probe_runner.shutdown();
                        return Ok(Some(path));
                    }
                    None => {
                        update_listening = false;
                    }
                }
            }
        }
    }
}

async fn connect_ws(
    server_url: &Url,
    connector: Option<Connector>,
    timeouts: ConnectTimeouts,
) -> anyhow::Result<WsStream> {
    let addrs = resolve_server_addrs(server_url, timeouts.dns).await?;
    connect_any(server_url, &addrs, connector, timeouts).await
}

async fn resolve_server_addrs(
    server_url: &Url,
    dns_timeout: Duration,
) -> anyhow::Result<Vec<SocketAddr>> {
    let port = server_url
        .port_or_known_default()
        .context("server_url has no port")?;
    let addrs = match server_url.host().context("server_url has no host")? {
        Host::Ipv4(ip) => vec![SocketAddr::from((ip, port))],
        Host::Ipv6(ip) => vec![SocketAddr::from((ip, port))],
        Host::Domain(domain) => {
            match timeout(dns_timeout, tokio::net::lookup_host((domain, port))).await {
                Ok(result) => result
                    .with_context(|| format!("DNS lookup for {domain} failed"))?
                    .collect(),
                Err(_) => anyhow::bail!("DNS lookup for {domain} timed out after {dns_timeout:?}"),
            }
        }
    };
    Ok(interleave_families(addrs))
}

// Alternates address families (keeping the resolver's order within each family) so that a
// broken path for one family costs a single connect timeout before the other one is tried.
fn interleave_families(addrs: Vec<SocketAddr>) -> Vec<SocketAddr> {
    let first_is_v6 = addrs.first().is_some_and(SocketAddr::is_ipv6);
    let (primary, secondary): (Vec<_>, Vec<_>) = addrs
        .into_iter()
        .partition(|addr| addr.is_ipv6() == first_is_v6);
    let mut interleaved = Vec::with_capacity(primary.len() + secondary.len());
    let mut secondary = secondary.into_iter();
    for addr in primary {
        interleaved.push(addr);
        interleaved.extend(secondary.next());
    }
    interleaved.extend(secondary);
    interleaved
}

// Every step has its own deadline: otherwise a black-holed SYN, an unacknowledged handshake or a
// half-open connection leaves the reconnect loop waiting on kernel timeouts, possibly forever.
async fn connect_any(
    server_url: &Url,
    addrs: &[SocketAddr],
    connector: Option<Connector>,
    timeouts: ConnectTimeouts,
) -> anyhow::Result<WsStream> {
    let mut last_err = None;
    for &addr in addrs {
        match connect_addr(server_url, addr, connector.clone(), timeouts).await {
            Ok(ws_stream) => {
                tracing::info!(%addr, "connected");
                return Ok(ws_stream);
            }
            // The server answered and refused the upgrade (e.g. 429); all addresses lead to it.
            Err(err) if is_upgrade_rejection(&err) => return Err(err),
            Err(err) => {
                tracing::warn!(%addr, error = %format_args!("{err:#}"), "connect attempt failed");
                last_err = Some(err);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("server_url resolved to no address")))
}

async fn connect_addr(
    server_url: &Url,
    addr: SocketAddr,
    connector: Option<Connector>,
    timeouts: ConnectTimeouts,
) -> anyhow::Result<WsStream> {
    let tcp = match timeout(timeouts.tcp, TcpStream::connect(addr)).await {
        Ok(result) => result.with_context(|| format!("TCP connect to {addr} failed"))?,
        Err(_) => anyhow::bail!("TCP connect to {addr} timed out after {:?}", timeouts.tcp),
    };
    let handshake =
        tokio_tungstenite::client_async_tls_with_config(server_url.as_str(), tcp, None, connector);
    match timeout(timeouts.handshake, handshake).await {
        Ok(result) => {
            let (ws_stream, _) = result.with_context(|| format!("handshake with {addr} failed"))?;
            Ok(ws_stream)
        }
        Err(_) => anyhow::bail!(
            "handshake with {addr} timed out after {:?}",
            timeouts.handshake
        ),
    }
}

fn is_upgrade_rejection(err: &anyhow::Error) -> bool {
    matches!(err.downcast_ref::<WsError>(), Some(WsError::Http(_)))
}

async fn send_with_timeout(ws_write: &mut WsSink, msg: Message) -> anyhow::Result<()> {
    match timeout(WRITE_TIMEOUT, ws_write.send(msg)).await {
        Ok(result) => Ok(result?),
        Err(_) => anyhow::bail!("write timed out after {WRITE_TIMEOUT:?}"),
    }
}

async fn recv_welcome(
    ws_read: &mut (impl StreamExt<Item = Result<Message, WsError>> + Unpin),
    wait: Duration,
) -> anyhow::Result<WelcomeBody> {
    let fut = async {
        loop {
            let Some(msg) = ws_read.next().await else {
                anyhow::bail!("ws closed before WELCOME");
            };
            let msg = msg?;
            match msg {
                Message::Binary(bytes) => {
                    let env = decode_envelope(&bytes)?;
                    match env.message_type {
                        t if t == MessageType::Welcome as u8 => {
                            let body: WelcomeBody = serde_json::from_value(env.body)?;
                            return Ok(body);
                        }
                        t if t == MessageType::Error as u8 => {
                            let body: ErrorBody = serde_json::from_value(env.body)?;
                            anyhow::bail!("server error {}: {}", body.code, body.message);
                        }
                        _ => {}
                    }
                }
                Message::Close(Some(frame)) => anyhow::bail!(
                    "ws closed before WELCOME: code={} reason={:?}",
                    u16::from(frame.code),
                    frame.reason.as_str()
                ),
                Message::Close(None) => anyhow::bail!("ws closed before WELCOME"),
                _ => {}
            }
        }
    };

    timeout(wait, fut).await.context("WELCOME timeout")?
}

struct IncomingAction {
    keep_running: bool,
    runtime_cfg: Option<WelcomeCfg>,
}

fn handle_incoming(probe_runner: &mut ProbeRunner, msg: Message) -> anyhow::Result<IncomingAction> {
    match msg {
        Message::Binary(bytes) => {
            let env = decode_envelope(&bytes)?;
            if env.message_type == MessageType::ProbeConfig as u8 {
                if let Ok(body) = serde_json::from_value::<ProbeConfigBody>(env.body) {
                    tracing::info!(
                        rev = body.rev,
                        tasks = body.tasks.len(),
                        "probe config received"
                    );
                    match probe_runner.apply_config(body) {
                        ApplyConfigResult::Ignored { rev, current_rev } => {
                            tracing::info!(
                                rev = rev,
                                current_rev = current_rev,
                                "probe config ignored"
                            );
                        }
                        ApplyConfigResult::Applied {
                            rev,
                            kept,
                            started,
                            restarted,
                            stopped,
                        } => {
                            tracing::info!(
                                rev = rev,
                                kept = kept,
                                started = started,
                                restarted = restarted,
                                stopped = stopped,
                                "probe config applied"
                            );
                        }
                    }
                }
            } else if env.message_type == MessageType::Welcome as u8 {
                if let Ok(body) = serde_json::from_value::<WelcomeBody>(env.body) {
                    tracing::info!(
                        t_ms = body.cfg.telemetry_interval_ms,
                        j_ms = body.cfg.telemetry_jitter_ms,
                        "runtime config updated"
                    );
                    return Ok(IncomingAction {
                        keep_running: true,
                        runtime_cfg: Some(body.cfg),
                    });
                }
            } else if env.message_type == MessageType::Error as u8
                && let Ok(body) = serde_json::from_value::<ErrorBody>(env.body)
            {
                tracing::warn!(code = %body.code, message = %body.message, "server error");
            }
        }
        Message::Close(frame) => {
            match frame {
                Some(frame) => tracing::info!(
                    code = u16::from(frame.code),
                    reason = frame.reason.as_str(),
                    "server closed the session"
                ),
                None => tracing::info!("server closed the session"),
            }
            return Ok(IncomingAction {
                keep_running: false,
                runtime_cfg: None,
            });
        }
        // tungstenite queues Pong replies itself; replying through the out queue here would block
        // the session loop forever once that queue is full.
        _ => {}
    }
    Ok(IncomingAction {
        keep_running: true,
        runtime_cfg: None,
    })
}

struct AbortOnDrop(tokio::task::JoinHandle<crate::ip_resolve::ResolvedIps>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

fn default_capabilities() -> Value {
    let traceroute = if crate::probe::TCP_SIZE_PAIR_SUPPORTED {
        serde_json::json!({
            "protocols": ["icmp", "tcp"],
            "tcpSizePair": true,
            "resultVersions": [1, 2]
        })
    } else {
        serde_json::json!({
            "protocols": ["icmp"],
            "tcpSizePair": false,
            "resultVersions": [1]
        })
    };

    serde_json::json!({
        "telemetry": {
            "metrics": [
                "cpu.usage_pct",
                "mem.total_bytes",
                "mem.used_bytes",
                "mem.used_pct",
                "swap.total_bytes",
                "swap.used_bytes",
                "swap.used_pct",
                "disk.total_bytes",
                "disk.used_bytes",
                "disk.used_pct",
                "conn.tcp.count",
                "conn.udp.count",
                "conn.total.count",
                "load.1",
                "load.5",
                "load.15",
                "proc.count",
                "temp.max_c",
                "net.rx_rate",
                "net.tx_rate"
            ],
            "traffic": {
                "rx_tx": "sysinfo_network_totals"
            }
        },
        "probes": {
            "traceroute": traceroute,
            "tcp": { "packetSize": crate::probe::TCP_PACKET_SIZE_SUPPORTED }
        }
    })
}

fn build_os_string() -> Option<String> {
    match (sysinfo::System::name(), sysinfo::System::os_version()) {
        (Some(name), Some(ver)) => Some(format!("{name} {ver}")),
        (Some(name), None) => Some(name),
        (None, Some(ver)) => Some(ver),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};

    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;

    use super::*;

    const FAST: ConnectTimeouts = ConnectTimeouts {
        dns: Duration::from_secs(1),
        tcp: Duration::from_secs(1),
        handshake: Duration::from_millis(300),
    };

    fn v4(last: u8) -> SocketAddr {
        SocketAddr::from((Ipv4Addr::new(192, 0, 2, last), 443))
    }

    fn v6(last: u16) -> SocketAddr {
        SocketAddr::from((Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, last), 443))
    }

    fn ws_url(addr: SocketAddr) -> Url {
        Url::parse(&format!("ws://{addr}/ws")).unwrap()
    }

    async fn spawn_ws_server() -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    if let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await {
                        while ws.next().await.is_some() {}
                    }
                });
            }
        });
        addr
    }

    #[test]
    fn interleave_families_alternates_starting_with_first_family() {
        assert_eq!(
            interleave_families(vec![v6(1), v6(2), v4(1), v4(2)]),
            vec![v6(1), v4(1), v6(2), v4(2)]
        );
        assert_eq!(
            interleave_families(vec![v4(1), v4(2), v4(3), v6(1)]),
            vec![v4(1), v6(1), v4(2), v4(3)]
        );
        assert_eq!(interleave_families(vec![v4(1), v4(2)]), vec![v4(1), v4(2)]);
        assert!(interleave_families(Vec::new()).is_empty());
    }

    #[test]
    fn backoff_resets_only_after_stable_session() {
        assert_eq!(next_backoff(MIN_BACKOFF, None), Duration::from_secs(2));
        assert_eq!(next_backoff(Duration::from_secs(16), None), MAX_BACKOFF);
        assert_eq!(
            next_backoff(MAX_BACKOFF, Some(Duration::from_secs(10))),
            MAX_BACKOFF
        );
        assert_eq!(next_backoff(MAX_BACKOFF, Some(STABLE_SESSION)), MIN_BACKOFF);
    }

    #[tokio::test]
    async fn recv_welcome_reports_close_code() {
        let close = Message::Close(Some(CloseFrame {
            code: 4001u16.into(),
            reason: "hello_timeout".into(),
        }));
        let mut ws_read = futures_util::stream::iter([Ok::<_, WsError>(close)]);

        let Err(err) = recv_welcome(&mut ws_read, Duration::from_secs(1)).await else {
            panic!("recv_welcome should fail on close");
        };

        assert!(err.to_string().contains("code=4001"), "{err:#}");
    }

    #[tokio::test]
    async fn connect_times_out_when_handshake_gets_no_response() {
        // Never accepted: the kernel completes the TCP handshake, but the upgrade gets no reply.
        let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = silent.local_addr().unwrap();

        let Err(err) = connect_any(&ws_url(addr), &[addr], None, FAST).await else {
            panic!("connect should fail");
        };

        assert!(format!("{err:#}").contains("timed out"), "{err:#}");
    }

    #[tokio::test]
    async fn connect_falls_back_to_next_address() {
        let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let refused = TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap()
            .local_addr()
            .unwrap();
        let good = spawn_ws_server().await;
        let addrs = [silent.local_addr().unwrap(), refused, good];

        if let Err(err) = connect_any(&ws_url(good), &addrs, None, FAST).await {
            panic!("connect should fall back to {good}: {err:#}");
        }
    }

    #[tokio::test]
    async fn connect_stops_when_server_rejects_upgrade() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let rejecting = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            stream.writable().await.unwrap();
            stream
                .try_write(b"HTTP/1.1 429 Too Many Requests\r\ncontent-length: 0\r\n\r\n")
                .unwrap();
            // Keep the socket open so the client reads the response rather than a reset.
            std::future::pending::<()>().await;
        });
        let good = spawn_ws_server().await;

        let Err(err) = connect_any(&ws_url(good), &[rejecting, good], None, FAST).await else {
            panic!("connect should not fall back after the server rejected the upgrade");
        };

        assert!(is_upgrade_rejection(&err), "{err:#}");
    }
}
