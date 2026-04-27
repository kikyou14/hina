use std::time::Duration;

use anyhow::Context;
use url::Url;

use super::{clamp_error, outcome::ProbeOutcome};

pub(crate) async fn probe(http: &reqwest::Client, url: Url, timeout: Duration) -> ProbeOutcome {
    let start = std::time::Instant::now();
    let response = http
        .get(url)
        .timeout(timeout)
        .send()
        .await
        .context("http send failed");

    match response {
        Ok(resp) => {
            let status = resp.status().as_u16();
            drop(resp);
            ProbeOutcome::success(start.elapsed().as_millis().min(u64::MAX as u128) as u64)
                .with_ok(status < 400)
                .with_code(status as u64)
        }
        Err(err) => ProbeOutcome::failure(clamp_error(&err.to_string())),
    }
}
