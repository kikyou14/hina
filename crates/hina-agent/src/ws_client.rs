use std::path::PathBuf;
use std::time::Duration;

use anyhow::Context;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::time::{Instant, timeout};
use tokio_tungstenite::tungstenite::protocol::Message;
use url::Url;

use crate::collector::TelemetryCollector;
use crate::config::{AgentConfig, parse_mount_points};
use crate::probe::{ApplyConfigResult, ProbeRunner};
use crate::protocol::{
    ErrorBody, HelloBody, IpUpdateBody, MessageType, ProbeConfigBody, TelemetryBody, WelcomeBody,
    WelcomeCfg, decode_envelope, encode_envelope,
};

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

    let mut backoff = Duration::from_secs(1);

    loop {
        if let Ok(path) = update_rx.try_recv() {
            return Ok(Some(path));
        }

        let result = run_session(&config, connector.clone(), update_rx).await;
        if config.once {
            return result;
        }

        match result {
            update @ Ok(Some(_)) => return update,
            Ok(None) => {
                backoff = Duration::from_secs(1);
            }
            Err(err) => {
                tracing::warn!(error = %err, "ws session ended with error");
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        }

        let jitter_ms = fastrand::u64(0..=250);
        tokio::time::sleep(backoff + Duration::from_millis(jitter_ms)).await;
    }
}

async fn run_session(
    config: &AgentConfig,
    connector: Option<tokio_tungstenite::Connector>,
    update_rx: &mut mpsc::Receiver<PathBuf>,
) -> anyhow::Result<Option<PathBuf>> {
    Url::parse(&config.server_url).context("invalid server_url")?;
    tracing::info!(server_url = %config.server_url, "connecting");

    let interface = config.interface.clone();
    let mut ip_task =
        tokio::spawn(async move { crate::ip_resolve::resolve_ips(interface.as_deref()).await });

    let (ws_stream, _) = match tokio_tungstenite::connect_async_tls_with_config(
        config.server_url.as_str(),
        None,
        false,
        connector,
    )
    .await
    {
        Ok(v) => v,
        Err(err) => {
            ip_task.abort();
            return Err(err).context("connect_async failed");
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
    ws_write
        .send(Message::Binary(hello_bytes.into()))
        .await
        .context("send HELLO failed")?;

    let welcome = recv_welcome(&mut ws_read, &mut ws_write, Duration::from_secs(5)).await?;
    tracing::info!(
        agent_id = %welcome.agent_id,
        t_ms = welcome.cfg.telemetry_interval_ms,
        j_ms = welcome.cfg.telemetry_jitter_ms,
        "authenticated",
    );
    let interval_ms = welcome.cfg.telemetry_interval_ms.max(1000);
    let jitter_ms = welcome.cfg.telemetry_jitter_ms.min(60_000);

    let (out_tx, mut out_rx) = mpsc::channel::<Message>(256);
    let mut probe_runner = ProbeRunner::new(out_tx.clone());

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
                ws_write.send(Message::Binary(bytes.into())).await.context("send TELEMETRY failed")?;

                seq = seq.wrapping_add(1);

                #[cfg(unix)]
                if seq == 1 {
                    crate::updater::confirm_update();
                }

                if config.once {
                    ws_write.send(Message::Close(None)).await.ok();
                    return Ok(None);
                }

                let sleep_ms = current_interval_ms + fastrand::u64(0..=current_jitter_ms);
                next_send.as_mut().reset(Instant::now() + Duration::from_millis(sleep_ms));
            }

            _ = &mut ping_timer => {
                ws_write.send(Message::Ping(vec![].into())).await.context("send PING failed")?;
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
                    ws_write.send(Message::Binary(bytes.into())).await.context("send IP_UPDATE failed")?;
                } else {
                    tracing::debug!("IPs unchanged, skipping update");
                }
            }

            outbound = out_rx.recv() => {
                let Some(msg) = outbound else {
                    return Ok(None);
                };
                ws_write.send(msg).await.context("ws write failed")?;
            }

            msg = ws_read.next() => {
                let Some(result) = msg else {
                    probe_runner.shutdown();
                    return Ok(None);
                };
                let message = result.context("ws read error")?;
                read_deadline.as_mut().reset(Instant::now() + READ_TIMEOUT);
                let next_runtime = handle_incoming(&out_tx, &mut probe_runner, message).await?;
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
                        ws_write.send(Message::Close(None)).await.ok();
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

async fn recv_welcome(
    ws_read: &mut (
             impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin
         ),
    ws_write: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
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
                Message::Ping(data) => {
                    ws_write.send(Message::Pong(data)).await?;
                }
                Message::Close(_) => anyhow::bail!("ws closed before WELCOME"),
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

async fn handle_incoming(
    out_tx: &mpsc::Sender<Message>,
    probe_runner: &mut ProbeRunner,
    msg: Message,
) -> anyhow::Result<IncomingAction> {
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
        Message::Ping(data) => {
            let _ = out_tx.send(Message::Pong(data)).await;
        }
        Message::Close(_) => {
            return Ok(IncomingAction {
                keep_running: false,
                runtime_cfg: None,
            });
        }
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
