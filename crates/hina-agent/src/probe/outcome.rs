use serde_json::Value;

use crate::protocol::ProbeResultBody;

#[derive(Debug, Clone)]
pub(crate) struct ProbeOutcome {
    ok: bool,
    latency_ms: Option<u64>,
    code: Option<u64>,
    error: Option<String>,
    extra: Option<Value>,
    loss_pct: Option<f64>,
    jitter_ms: Option<f64>,
}

impl ProbeOutcome {
    pub(crate) fn success(latency_ms: u64) -> Self {
        Self {
            ok: true,
            latency_ms: Some(latency_ms),
            code: None,
            error: None,
            extra: None,
            loss_pct: None,
            jitter_ms: None,
        }
    }

    pub(crate) fn failure(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            latency_ms: None,
            code: None,
            error: Some(error.into()),
            extra: None,
            loss_pct: None,
            jitter_ms: None,
        }
    }

    pub(crate) fn with_ok(mut self, ok: bool) -> Self {
        self.ok = ok;
        self
    }

    pub(crate) fn with_code(mut self, code: u64) -> Self {
        self.code = Some(code);
        self
    }

    pub(crate) fn with_latency(mut self, latency_ms: Option<u64>) -> Self {
        self.latency_ms = latency_ms;
        self
    }

    pub(crate) fn with_extra(mut self, extra: Value) -> Self {
        self.extra = Some(extra);
        self
    }

    pub(crate) fn with_loss_pct(mut self, loss_pct: f64) -> Self {
        self.loss_pct = Some(loss_pct);
        self
    }

    pub(crate) fn with_jitter_ms(mut self, jitter_ms: f64) -> Self {
        self.jitter_ms = Some(jitter_ms);
        self
    }

    pub(crate) fn into_result_body(self, task_id: String, ts_ms: i64) -> ProbeResultBody {
        let mut body = match self.error {
            Some(error) => ProbeResultBody::failure(task_id, ts_ms, error),
            None => ProbeResultBody::success(task_id, ts_ms, self.latency_ms.unwrap_or(0)),
        };

        body = body.with_ok(self.ok).with_latency(self.latency_ms);
        if let Some(code) = self.code {
            body = body.with_code(code);
        }
        if let Some(extra) = self.extra {
            body = body.with_extra(extra);
        }
        if let Some(loss_pct) = self.loss_pct {
            body = body.with_loss_pct(loss_pct);
        }
        if let Some(jitter_ms) = self.jitter_ms {
            body = body.with_jitter_ms(jitter_ms);
        }

        body
    }
}
