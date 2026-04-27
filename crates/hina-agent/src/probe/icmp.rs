use std::{net::IpAddr, sync::Arc, time::Duration};

use surge_ping::{PingIdentifier, PingSequence};

use super::{classify_probe_error, outcome::ProbeOutcome, remaining_until, resolve_ip};

#[derive(Clone)]
pub(crate) struct IcmpClients {
    v4: Result<Arc<surge_ping::Client>, Arc<str>>,
    v6: Result<Arc<surge_ping::Client>, Arc<str>>,
}

impl IcmpClients {
    pub(crate) fn new() -> Self {
        let v4 = match surge_ping::Client::new(&surge_ping::Config::default()) {
            Ok(c) => Ok(Arc::new(c)),
            Err(err) => {
                tracing::warn!(error = %err, "failed to create ICMPv4 client");
                Err(Arc::from(err.to_string().as_str()))
            }
        };
        let v6 = match surge_ping::Client::new(
            &surge_ping::Config::builder()
                .kind(surge_ping::ICMP::V6)
                .build(),
        ) {
            Ok(c) => Ok(Arc::new(c)),
            Err(err) => {
                tracing::warn!(error = %err, "failed to create ICMPv6 client");
                Err(Arc::from(err.to_string().as_str()))
            }
        };
        Self { v4, v6 }
    }
}

const ICMP_PROBE_COUNT: u8 = 5;
const ICMP_SEND_INTERVAL: Duration = Duration::from_millis(200);
const ICMP_MIN_PER_PROBE_TIMEOUT: Duration = Duration::from_millis(500);

pub(crate) struct IcmpPingStats {
    pub(crate) avg_rtt_ms: u64,
    pub(crate) loss_pct: f64,
    pub(crate) jitter_ms: Option<f64>,
}

pub(crate) async fn probe(
    icmp: &IcmpClients,
    host: &str,
    deadline: tokio::time::Instant,
) -> ProbeOutcome {
    match surge_icmp_ping(icmp, host, deadline).await {
        Ok(stats) => {
            let mut outcome = ProbeOutcome::success(stats.avg_rtt_ms).with_loss_pct(stats.loss_pct);
            if let Some(jitter) = stats.jitter_ms {
                outcome = outcome.with_jitter_ms(jitter);
            }
            outcome
        }
        Err(err) => classify_probe_error("icmp", &err),
    }
}

pub(crate) fn compute_stats(probe_count: u8, results: &[Duration]) -> IcmpPingStats {
    let sent = probe_count as f64;
    let received = results.len() as f64;
    let loss_pct = (sent - received) / sent * 100.0;

    let avg_rtt_ms = if results.is_empty() {
        0
    } else {
        let sum: Duration = results.iter().sum();
        (sum / results.len() as u32)
            .as_millis()
            .min(u64::MAX as u128) as u64
    };

    let jitter_ms = if results.len() >= 2 {
        let mut diff_sum = 0.0f64;
        for i in 1..results.len() {
            let diff = (results[i].as_secs_f64() - results[i - 1].as_secs_f64()).abs();
            diff_sum += diff;
        }
        Some(diff_sum / (results.len() - 1) as f64 * 1000.0)
    } else {
        None
    };

    IcmpPingStats {
        avg_rtt_ms,
        loss_pct,
        jitter_ms,
    }
}

fn compute_probe_count(remaining: Duration) -> u8 {
    let budget_per_probe = ICMP_MIN_PER_PROBE_TIMEOUT + ICMP_SEND_INTERVAL;
    let max = (remaining.as_millis() / budget_per_probe.as_millis()).min(ICMP_PROBE_COUNT as u128);
    max.max(1) as u8
}

async fn surge_icmp_ping(
    icmp: &IcmpClients,
    host: &str,
    deadline: tokio::time::Instant,
) -> anyhow::Result<IcmpPingStats> {
    let ip = resolve_ip(host, deadline).await?;
    let remaining = remaining_until(deadline);
    if remaining.is_zero() {
        anyhow::bail!("timeout");
    }

    let client = match ip {
        IpAddr::V4(_) => &icmp.v4,
        IpAddr::V6(_) => &icmp.v6,
    }
    .as_ref()
    .map_err(|init_err| anyhow::anyhow!("ICMP socket init failed: {init_err}"))?;

    let probe_count = compute_probe_count(remaining);
    let per_probe_timeout = remaining / probe_count as u32;
    let ident = PingIdentifier(fastrand::u16(..));

    let mut pinger = client.pinger(ip, ident).await;

    let payload = [0u8; 56];
    let mut rtts = Vec::with_capacity(probe_count as usize);

    for seq in 0..probe_count as u16 {
        let remaining = remaining_until(deadline);
        if remaining.is_zero() {
            break;
        }
        pinger.timeout(remaining.min(per_probe_timeout));

        match pinger.ping(PingSequence(seq), &payload).await {
            Ok((_packet, rtt)) => rtts.push(rtt),
            Err(surge_ping::SurgeError::Timeout { .. }) => {}
            Err(err) => {
                return Err(anyhow::Error::new(err).context("icmp ping failed"));
            }
        }

        if seq + 1 < probe_count as u16 {
            let interval = ICMP_SEND_INTERVAL.min(remaining_until(deadline));
            if !interval.is_zero() {
                tokio::time::sleep(interval).await;
            }
        }
    }

    if rtts.is_empty() {
        anyhow::bail!("timeout");
    }

    Ok(compute_stats(probe_count, &rtts))
}
