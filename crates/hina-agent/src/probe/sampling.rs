//! Sample budget and statistics shared by probes that send several packets per run.

use std::time::Duration;

const MAX_SAMPLES: u8 = 5;
pub(crate) const SAMPLE_INTERVAL: Duration = Duration::from_millis(200);
const MIN_SAMPLE_TIMEOUT: Duration = Duration::from_millis(500);

/// How many samples fit in `remaining`; always at least one.
pub(crate) fn sample_count(remaining: Duration) -> u8 {
    let budget_per_sample = MIN_SAMPLE_TIMEOUT + SAMPLE_INTERVAL;
    let fits = (remaining.as_millis() / budget_per_sample.as_millis()).min(u128::from(MAX_SAMPLES));
    fits.max(1) as u8
}

pub(crate) struct SampleStats {
    pub(crate) avg_rtt_ms: u64,
    pub(crate) loss_pct: f64,
    pub(crate) jitter_ms: Option<f64>,
}

/// `sent` and `received` count samples; `rtts` are the round trips that measure latency, which can
/// be fewer than `received` when some replies carry no usable timing. `sent` must be non-zero.
pub(crate) fn compute_stats(sent: u8, received: u8, rtts: &[Duration]) -> SampleStats {
    let loss_pct = f64::from(sent - received) / f64::from(sent) * 100.0;

    let avg_rtt_ms = if rtts.is_empty() {
        0
    } else {
        let sum: Duration = rtts.iter().sum();
        (sum / rtts.len() as u32).as_millis().min(u64::MAX as u128) as u64
    };

    let jitter_ms = (rtts.len() >= 2).then(|| {
        let diff_sum: f64 = rtts
            .windows(2)
            .map(|pair| (pair[1].as_secs_f64() - pair[0].as_secs_f64()).abs())
            .sum();
        diff_sum / (rtts.len() - 1) as f64 * 1000.0
    });

    SampleStats {
        avg_rtt_ms,
        loss_pct,
        jitter_ms,
    }
}
