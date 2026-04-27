use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::Duration,
};

use serde_json::Value;

use super::{
    classify_probe_error,
    icmp::compute_stats as compute_icmp_stats,
    task::{NormalizeTaskIssue, normalize_tasks, parse_task},
    tcp::{classify_tcp_io_error, resolve_tcp_addrs},
    traceroute::{HopResult, RawTracerouteResult, rdns_best_effort, round_ms, traceroute_extra_v1},
};
use crate::protocol::{ProbeTaskKind, ProbeTaskWire};

fn base_task(kind: ProbeTaskKind, target: Value) -> ProbeTaskWire {
    ProbeTaskWire {
        id: "task_1".to_string(),
        kind,
        interval_sec: 1,
        timeout_ms: 1000,
        target,
        enabled: None,
        name: None,
        extra: None,
    }
}

#[test]
fn parse_task_rejects_empty_id() {
    let mut task = base_task(
        ProbeTaskKind::Icmp,
        serde_json::json!({ "host": "1.1.1.1" }),
    );
    task.id = "   ".to_string();
    let err = parse_task(&task).unwrap_err();
    assert!(err.to_string().contains("missing id"));
}

#[test]
fn parse_task_rejects_invalid_http_scheme() {
    let task = base_task(
        ProbeTaskKind::Http,
        serde_json::json!({ "url": "ftp://example.com" }),
    );
    let err = parse_task(&task).unwrap_err();
    assert!(err.to_string().contains("unsupported url.scheme"));
}

#[test]
fn parse_task_rejects_tcp_port_out_of_range() {
    let task = base_task(
        ProbeTaskKind::Tcp,
        serde_json::json!({ "host": "example.com", "port": 70_000u64 }),
    );
    let err = parse_task(&task).unwrap_err();
    assert!(err.to_string().contains("invalid target.port"));
}

#[test]
fn parse_task_rejects_tcp_port_zero() {
    let task = base_task(
        ProbeTaskKind::Tcp,
        serde_json::json!({ "host": "example.com", "port": 0u64 }),
    );
    let err = parse_task(&task).unwrap_err();
    assert!(err.to_string().contains("invalid target.port"));
}

#[test]
fn normalize_tasks_omits_disabled_tasks() {
    let mut task = base_task(
        ProbeTaskKind::Tcp,
        serde_json::json!({ "host": "example.com", "port": 443 }),
    );
    task.enabled = Some(false);

    let normalized = normalize_tasks(&[task]);
    assert!(normalized.desired.is_empty());
    assert!(normalized.issues.is_empty());
}

#[test]
fn normalize_tasks_omits_invalid_tasks() {
    let task = base_task(
        ProbeTaskKind::Tcp,
        serde_json::json!({ "host": "example.com", "port": 0u64 }),
    );

    let normalized = normalize_tasks(&[task]);
    assert!(normalized.desired.is_empty());
    assert_eq!(
        normalized.issues,
        vec![NormalizeTaskIssue::InvalidTask {
            task_id: "task_1".to_string(),
            error: "invalid target.port".to_string(),
        }]
    );
}

#[test]
fn normalize_tasks_keeps_first_valid_duplicate() {
    let first = base_task(
        ProbeTaskKind::Tcp,
        serde_json::json!({ "host": "example.com", "port": 443 }),
    );
    let mut second = base_task(
        ProbeTaskKind::Tcp,
        serde_json::json!({ "host": "example.net", "port": 80 }),
    );
    second.id = "task_1".to_string();

    let normalized = normalize_tasks(&[first, second]);
    assert_eq!(normalized.desired.len(), 1);
    assert_eq!(
        normalized
            .desired
            .get("task_1")
            .expect("task_1 must exist")
            .target,
        super::task::ProbeTarget::Tcp {
            host: "example.com".to_string(),
            port: 443,
        }
    );
    assert_eq!(
        normalized.issues,
        vec![NormalizeTaskIssue::DuplicateTaskId {
            task_id: "task_1".to_string(),
        }]
    );
}

#[test]
fn normalize_tasks_allows_later_valid_duplicate_after_invalid() {
    let invalid = base_task(
        ProbeTaskKind::Tcp,
        serde_json::json!({ "host": "example.com", "port": 0u64 }),
    );
    let valid = base_task(
        ProbeTaskKind::Tcp,
        serde_json::json!({ "host": "example.com", "port": 443 }),
    );

    let normalized = normalize_tasks(&[invalid, valid]);
    assert_eq!(normalized.desired.len(), 1);
    assert!(normalized.desired.contains_key("task_1"));
    assert_eq!(
        normalized.issues,
        vec![NormalizeTaskIssue::InvalidTask {
            task_id: "task_1".to_string(),
            error: "invalid target.port".to_string(),
        }]
    );
}

#[test]
fn permission_denied_is_classified_for_icmp() {
    let err = anyhow::Error::msg("Permission denied (os error 13)");
    let result = classify_probe_error("icmp", &err).into_result_body("task".to_string(), 1);

    assert_eq!(result.error.as_deref(), Some("permission_denied"));

    let extra = result.extra.expect("extra must exist");
    assert_eq!(extra.get("kind").and_then(Value::as_str), Some("icmp"));
    assert!(extra.get("detail").and_then(Value::as_str).is_some());
    assert!(extra.get("hint").and_then(Value::as_str).is_some());
}

#[test]
fn operation_not_permitted_is_classified_for_traceroute() {
    let err = anyhow::Error::msg("Operation not permitted (os error 1)");
    let result = classify_probe_error("traceroute", &err).into_result_body("task".to_string(), 1);
    assert_eq!(result.error.as_deref(), Some("permission_denied"));
}

#[test]
fn traceroute_extra_v1_pads_ttl_gaps_and_formats_hops() {
    let target_ip = Ipv4Addr::new(1, 1, 1, 1);
    // One HopResult per TTL (QUERIES_PER_HOP = 1). TTL 2 is missing → padded as timeout.
    let hops = vec![
        HopResult {
            ttl: 1,
            addr: Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))),
            rtt: Some(Duration::from_micros(1200)),
        },
        // TTL 2 absent — will be padded
        HopResult {
            ttl: 3,
            addr: Some(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1))),
            rtt: Some(Duration::from_millis(10)),
        },
        HopResult {
            ttl: 4,
            addr: None,
            rtt: None,
        },
    ];

    let result = RawTracerouteResult {
        target: "example.com".to_string(),
        target_ip,
        hops,
        destination_reached: false,
        total_duration: Duration::from_millis(1234),
    };

    let mut rdns = HashMap::<IpAddr, String>::new();
    rdns.insert(
        IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)),
        "gateway.local".to_string(),
    );

    let extra = traceroute_extra_v1(&result, Some(Ipv4Addr::new(10, 0, 0, 2)), &rdns);

    // ASN info is always null (enriched server-side)
    assert!(
        extra
            .get("destination_asn_info")
            .is_some_and(Value::is_null)
    );

    assert_eq!(
        extra.get("protocol_used").and_then(Value::as_str),
        Some("icmp")
    );
    assert_eq!(
        extra.get("socket_mode_used").and_then(Value::as_str),
        Some("raw")
    );

    let hops = extra
        .get("hops")
        .and_then(Value::as_array)
        .expect("hops must exist");
    assert_eq!(hops.len(), 4);

    // TTL 1: response with rDNS hostname
    let hop1 = hops[0].as_object().expect("hop1 must be object");
    assert_eq!(hop1.get("ttl").and_then(Value::as_u64), Some(1));
    assert_eq!(hop1.get("timeouts").and_then(Value::as_u64), Some(0));
    let hop1_responses = hop1
        .get("responses")
        .and_then(Value::as_array)
        .expect("hop1 responses must be array");
    assert_eq!(hop1_responses.len(), 1);
    assert_eq!(
        hop1_responses[0].get("ip").and_then(Value::as_str),
        Some("10.0.0.1")
    );
    assert_eq!(
        hop1_responses[0].get("hostname").and_then(Value::as_str),
        Some("gateway.local")
    );
    assert!(
        hop1_responses[0]
            .get("asn_info")
            .is_some_and(Value::is_null)
    );

    // TTL 2: padded gap — no probe result, full timeout
    let hop2 = hops[1].as_object().expect("hop2 must be object");
    assert_eq!(hop2.get("ttl").and_then(Value::as_u64), Some(2));
    assert_eq!(hop2.get("timeouts").and_then(Value::as_u64), Some(1));
    let hop2_responses = hop2
        .get("responses")
        .and_then(Value::as_array)
        .expect("hop2 responses must be array");
    assert_eq!(hop2_responses.len(), 0);

    // TTL 3: response, no timeouts
    let hop3 = hops[2].as_object().expect("hop3 must be object");
    assert_eq!(hop3.get("ttl").and_then(Value::as_u64), Some(3));
    assert_eq!(hop3.get("timeouts").and_then(Value::as_u64), Some(0));
    let hop3_responses = hop3
        .get("responses")
        .and_then(Value::as_array)
        .expect("hop3 responses must be array");
    assert_eq!(hop3_responses.len(), 1);
    assert!(
        hop3_responses[0]
            .get("asn_info")
            .is_some_and(Value::is_null)
    );

    // TTL 4: timeout (addr was None)
    let hop4 = hops[3].as_object().expect("hop4 must be object");
    assert_eq!(hop4.get("ttl").and_then(Value::as_u64), Some(4));
    assert_eq!(hop4.get("timeouts").and_then(Value::as_u64), Some(1));
}

#[test]
fn round_ms_rounds_half_away_from_zero() {
    assert_eq!(round_ms(Some(15.2)), Some(15));
    assert_eq!(round_ms(Some(15.5)), Some(16));
    assert_eq!(round_ms(Some(0.49)), Some(0));
    assert_eq!(round_ms(Some(0.5)), Some(1));
}

#[tokio::test]
async fn rdns_best_effort_respects_zero_budget() {
    let ips = vec![IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))];
    let deadline = tokio::time::Instant::now();
    let out = rdns_best_effort(ips, deadline).await;
    assert!(out.is_empty());
}

#[test]
fn classify_tcp_io_error_maps_kinds() {
    assert_eq!(
        classify_tcp_io_error(&std::io::Error::from(std::io::ErrorKind::TimedOut)),
        "timeout"
    );
    assert_eq!(
        classify_tcp_io_error(&std::io::Error::from(std::io::ErrorKind::ConnectionRefused)),
        "connection_refused"
    );
    assert_eq!(
        classify_tcp_io_error(&std::io::Error::from(std::io::ErrorKind::PermissionDenied)),
        "permission_denied"
    );
}

#[tokio::test]
async fn resolve_tcp_addrs_ip_literal_skips_dns() {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    let addrs = resolve_tcp_addrs("127.0.0.1", 4860, deadline)
        .await
        .expect("resolve must succeed");

    assert_eq!(addrs.len(), 1);
    assert_eq!(
        addrs[0],
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 4860)
    );
}

#[test]
fn icmp_stats_all_received() {
    let rtts = vec![
        Duration::from_millis(10),
        Duration::from_millis(20),
        Duration::from_millis(30),
    ];
    let stats = compute_icmp_stats(3, &rtts);
    assert_eq!(stats.avg_rtt_ms, 20);
    assert!((stats.loss_pct - 0.0).abs() < f64::EPSILON);
    // jitter = mean(|20-10|, |30-20|) = mean(10, 10) = 10.0 ms
    let jitter = stats.jitter_ms.expect("jitter must be Some");
    assert!((jitter - 10.0).abs() < 0.01);
}

#[test]
fn icmp_stats_partial_loss() {
    // 5 sent, 3 received
    let rtts = vec![
        Duration::from_millis(10),
        Duration::from_millis(20),
        Duration::from_millis(30),
    ];
    let stats = compute_icmp_stats(5, &rtts);
    assert_eq!(stats.avg_rtt_ms, 20);
    assert!((stats.loss_pct - 40.0).abs() < f64::EPSILON);
    assert!(stats.jitter_ms.is_some());
}

#[test]
fn icmp_stats_single_reply_no_jitter() {
    let rtts = vec![Duration::from_millis(42)];
    let stats = compute_icmp_stats(5, &rtts);
    assert_eq!(stats.avg_rtt_ms, 42);
    assert!((stats.loss_pct - 80.0).abs() < f64::EPSILON);
    assert!(stats.jitter_ms.is_none());
}

#[test]
fn icmp_stats_total_loss() {
    let rtts: Vec<Duration> = vec![];
    let stats = compute_icmp_stats(5, &rtts);
    assert_eq!(stats.avg_rtt_ms, 0);
    assert!((stats.loss_pct - 100.0).abs() < f64::EPSILON);
    assert!(stats.jitter_ms.is_none());
}

#[test]
fn icmp_stats_jitter_with_varying_rtts() {
    let rtts = vec![
        Duration::from_millis(10),
        Duration::from_millis(30),
        Duration::from_millis(15),
        Duration::from_millis(25),
    ];
    let stats = compute_icmp_stats(4, &rtts);
    // jitter = mean(|30-10|, |15-30|, |25-15|) = mean(20, 15, 10) = 15.0 ms
    let jitter = stats.jitter_ms.expect("jitter must be Some");
    assert!((jitter - 15.0).abs() < 0.01);
}
