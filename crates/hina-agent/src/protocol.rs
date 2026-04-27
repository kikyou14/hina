use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u8 = 1;

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageType {
    Hello = 1,
    Welcome = 2,
    Telemetry = 3,
    ProbeConfig = 4,
    ProbeResult = 5,
    IpUpdate = 6,
    Error = 9,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope<B> {
    #[serde(rename = "v")]
    pub version: u8,
    #[serde(rename = "t")]
    pub message_type: u8,
    #[serde(rename = "i")]
    pub message_id: i32,
    #[serde(rename = "s")]
    pub sent_at_ms: i64,
    #[serde(rename = "b")]
    pub body: B,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloBody {
    #[serde(rename = "tok")]
    pub token: String,

    #[serde(rename = "aid", skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,

    #[serde(rename = "ver", skip_serializing_if = "Option::is_none")]
    pub agent_version: Option<String>,

    #[serde(rename = "host", skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,

    #[serde(rename = "os", skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,

    #[serde(rename = "arch", skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,

    #[serde(rename = "inv", skip_serializing_if = "Option::is_none")]
    pub inventory: Option<Value>,

    #[serde(rename = "cap", skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Value>,

    #[serde(rename = "x", skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,

    #[serde(rename = "ip4", skip_serializing_if = "Option::is_none")]
    pub ipv4: Option<String>,

    #[serde(rename = "ip6", skip_serializing_if = "Option::is_none")]
    pub ipv6: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WelcomeCfg {
    #[serde(rename = "t_ms")]
    pub telemetry_interval_ms: u64,
    #[serde(rename = "j_ms")]
    pub telemetry_jitter_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WelcomeBody {
    #[serde(rename = "aid")]
    pub agent_id: String,
    #[serde(rename = "stm")]
    pub server_time_ms: i64,
    #[serde(rename = "cfg")]
    pub cfg: WelcomeCfg,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryBody {
    #[serde(rename = "aid", skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,

    #[serde(rename = "seq")]
    pub seq: u64,

    #[serde(rename = "up_s", skip_serializing_if = "Option::is_none")]
    pub uptime_seconds: Option<u64>,

    #[serde(rename = "rx")]
    pub rx_bytes_total: u64,

    #[serde(rename = "tx")]
    pub tx_bytes_total: u64,

    #[serde(rename = "m")]
    pub metrics: serde_json::Map<String, Value>,

    #[serde(rename = "x", skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    #[serde(rename = "code")]
    pub code: String,
    #[serde(rename = "message")]
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeTaskKind {
    Icmp,
    Tcp,
    Http,
    Traceroute,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeTaskWire {
    pub id: String,
    #[serde(rename = "k")]
    pub kind: ProbeTaskKind,
    #[serde(rename = "int_s")]
    pub interval_sec: u64,
    #[serde(rename = "to_ms")]
    pub timeout_ms: u64,
    #[serde(rename = "tar")]
    pub target: Value,
    #[serde(rename = "en", default)]
    pub enabled: Option<bool>,
    #[serde(rename = "name", default)]
    pub name: Option<String>,
    #[serde(rename = "x", default)]
    pub extra: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeConfigBody {
    pub rev: i64,
    pub tasks: Vec<ProbeTaskWire>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeResultBody {
    #[serde(rename = "tid")]
    pub task_id: String,
    #[serde(rename = "ts")]
    pub ts_ms: i64,
    #[serde(rename = "ok")]
    pub ok: bool,
    #[serde(rename = "lat_ms", skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(rename = "code", skip_serializing_if = "Option::is_none")]
    pub code: Option<u64>,
    #[serde(rename = "err", skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "x", skip_serializing_if = "Option::is_none")]
    pub extra: Option<Value>,
    #[serde(rename = "loss", skip_serializing_if = "Option::is_none")]
    pub loss_pct: Option<f64>,
    #[serde(rename = "jit_ms", skip_serializing_if = "Option::is_none")]
    pub jitter_ms: Option<f64>,
}

impl ProbeResultBody {
    pub fn success(task_id: String, ts_ms: i64, latency_ms: u64) -> Self {
        Self {
            task_id,
            ts_ms,
            ok: true,
            latency_ms: Some(latency_ms),
            code: None,
            error: None,
            extra: None,
            loss_pct: None,
            jitter_ms: None,
        }
    }

    pub fn failure(task_id: String, ts_ms: i64, error: String) -> Self {
        Self {
            task_id,
            ts_ms,
            ok: false,
            latency_ms: None,
            code: None,
            error: Some(error),
            extra: None,
            loss_pct: None,
            jitter_ms: None,
        }
    }

    pub fn with_code(mut self, code: u64) -> Self {
        self.code = Some(code);
        self
    }

    pub fn with_ok(mut self, ok: bool) -> Self {
        self.ok = ok;
        self
    }

    pub fn with_latency(mut self, latency_ms: Option<u64>) -> Self {
        self.latency_ms = latency_ms;
        self
    }

    pub fn with_extra(mut self, extra: Value) -> Self {
        self.extra = Some(extra);
        self
    }

    pub fn with_loss_pct(mut self, loss_pct: f64) -> Self {
        self.loss_pct = Some(loss_pct);
        self
    }

    pub fn with_jitter_ms(mut self, jitter_ms: f64) -> Self {
        self.jitter_ms = Some(jitter_ms);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpUpdateBody {
    #[serde(rename = "ip4", skip_serializing_if = "Option::is_none")]
    pub ipv4: Option<String>,

    #[serde(rename = "ip6", skip_serializing_if = "Option::is_none")]
    pub ipv6: Option<String>,
}

pub fn encode_envelope<T: Serialize>(
    message_type: MessageType,
    body: &T,
) -> anyhow::Result<Vec<u8>> {
    let envelope = Envelope {
        version: PROTOCOL_VERSION,
        message_type: message_type as u8,
        message_id: fastrand::i32(0..i32::MAX),
        sent_at_ms: now_unix_ms(),
        body,
    };

    Ok(rmp_serde::to_vec_named(&envelope)?)
}

pub fn decode_envelope(bytes: &[u8]) -> anyhow::Result<Envelope<Value>> {
    Ok(rmp_serde::from_slice(bytes)?)
}

pub fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let Ok(dur) = SystemTime::now().duration_since(UNIX_EPOCH) else {
        return 0;
    };
    dur.as_millis().min(i64::MAX as u128) as i64
}
