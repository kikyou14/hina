use std::{net::IpAddr, sync::Arc};

use surge_ping::{PingIdentifier, PingSequence};

use super::{
    classify_probe_error,
    family::{FamilyPolicy, resolve_first},
    outcome::ProbeOutcome,
    remaining_until,
    sampling::{SAMPLE_INTERVAL, SampleStats, compute_stats, sample_count},
};

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

pub(crate) async fn probe(
    icmp: &IcmpClients,
    host: &str,
    family: FamilyPolicy,
    deadline: tokio::time::Instant,
) -> ProbeOutcome {
    match surge_icmp_ping(icmp, host, family, deadline).await {
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

async fn surge_icmp_ping(
    icmp: &IcmpClients,
    host: &str,
    family: FamilyPolicy,
    deadline: tokio::time::Instant,
) -> anyhow::Result<SampleStats> {
    let ip = resolve_first(host, family, deadline)
        .await
        .map_err(|err| anyhow::Error::msg(err.code))?;
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

    let probe_count = sample_count(remaining);
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
            let interval = SAMPLE_INTERVAL.min(remaining_until(deadline));
            if !interval.is_zero() {
                tokio::time::sleep(interval).await;
            }
        }
    }

    if rtts.is_empty() {
        anyhow::bail!("timeout");
    }

    Ok(compute_stats(probe_count, rtts.len() as u8, &rtts))
}
