mod family;
mod http;
mod icmp;
mod outcome;
mod raw_socket;
mod runner;
mod sampling;
mod task;
mod tcp;
mod tcp_raw;
mod tcp_syn;
#[cfg(test)]
mod tests;
mod traceroute;
mod traceroute_tcp;

use std::{sync::Arc, time::Duration};

pub(crate) use icmp::IcmpClients;
pub(crate) use runner::ApplyConfigResult;
pub use runner::ProbeRunner;
pub(crate) use tcp_syn::TCP_PACKET_SIZE_SUPPORTED;
pub(crate) use traceroute_tcp::TCP_SIZE_PAIR_SUPPORTED;

use crate::protocol::ProbeResultBody;

use outcome::ProbeOutcome;
use task::{ProbeTarget, ProbeTaskSpec};

pub(crate) const MAX_ERROR_LEN: usize = 512;

pub(crate) async fn execute_probe(
    spec: &ProbeTaskSpec,
    http_client: &reqwest::Client,
    icmp: &IcmpClients,
    trace_serial: &Arc<tokio::sync::Semaphore>,
    ts_ms: i64,
) -> ProbeResultBody {
    let deadline = tokio::time::Instant::now() + spec.timeout;
    let outcome = match &spec.target {
        ProbeTarget::Tcp { host, port, mode } => tcp::probe(host, *port, *mode, deadline).await,
        ProbeTarget::Http { url } => http::probe(http_client, url.clone(), spec.timeout).await,
        ProbeTarget::Icmp { host, family } => icmp::probe(icmp, host, *family, deadline).await,
        ProbeTarget::Traceroute { host, mode } => {
            let _permit = trace_serial.acquire().await;
            let trace_deadline =
                tokio::time::Instant::now() + spec.timeout.max(traceroute::TRACEROUTE_MIN_TIMEOUT);
            traceroute::probe(host, mode, trace_deadline).await
        }
    };

    outcome.into_result_body(spec.id.clone(), ts_ms)
}

pub(crate) fn classify_probe_error(kind: &str, err: &anyhow::Error) -> ProbeOutcome {
    if is_permission_denied_error(err) && matches!(kind, "icmp" | "traceroute") {
        let detail = clamp_error(&err.to_string());
        let extra = serde_json::json!({
            "kind": kind,
            "detail": detail,
            "hint": permission_denied_hint(),
        });
        ProbeOutcome::failure("permission_denied").with_extra(extra)
    } else {
        ProbeOutcome::failure(clamp_error(&err.to_string()))
    }
}

pub(crate) fn is_permission_denied_error(err: &anyhow::Error) -> bool {
    let message = err.to_string().to_ascii_lowercase();
    message.contains("permission denied")
        || message.contains("operation not permitted")
        || message.contains("os error 13")
        || message.contains("os error 1")
        || message.contains("eacces")
        || message.contains("eperm")
}

pub(crate) fn permission_denied_hint() -> &'static str {
    if cfg!(target_os = "linux") {
        "Requires permission to open ICMP sockets (CAP_NET_RAW or root). For unprivileged ping, configure net.ipv4.ping_group_range."
    } else {
        "Requires elevated privileges to open ICMP sockets."
    }
}

pub(crate) fn remaining_until(deadline: tokio::time::Instant) -> Duration {
    deadline.saturating_duration_since(tokio::time::Instant::now())
}

pub(crate) fn clamp_error(input: &str) -> String {
    if input.len() <= MAX_ERROR_LEN {
        return input.to_string();
    }

    input.chars().take(MAX_ERROR_LEN).collect()
}
