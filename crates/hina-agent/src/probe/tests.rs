use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::Duration,
};

use serde_json::Value;

use super::{
    classify_probe_error,
    icmp::compute_stats as compute_icmp_stats,
    task::{NormalizeTaskIssue, ProbeTarget, TracerouteMode, normalize_tasks, parse_task},
    tcp::{classify_tcp_io_error, resolve_tcp_addrs},
    traceroute::{
        HopResult, RawTracerouteResult, build_hop_entries, rdns_best_effort, round_ms,
        traceroute_extra_v1,
    },
    traceroute_tcp,
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

// ---- TCP size-pair traceroute ---------------------------------------------

fn traceroute_mode(target: Value) -> anyhow::Result<TracerouteMode> {
    let task = base_task(ProbeTaskKind::Traceroute, target);
    match parse_task(&task)?.target {
        ProbeTarget::Traceroute { mode, .. } => Ok(mode),
        other => panic!("expected traceroute target, got {other:?}"),
    }
}

#[test]
fn traceroute_without_protocol_is_icmp() {
    let mode = traceroute_mode(serde_json::json!({ "host": "example.com" })).unwrap();
    assert_eq!(mode, TracerouteMode::Icmp);
}

#[test]
fn traceroute_explicit_icmp_protocol_is_icmp() {
    let mode =
        traceroute_mode(serde_json::json!({ "host": "example.com", "protocol": "icmp" })).unwrap();
    assert_eq!(mode, TracerouteMode::Icmp);
}

#[test]
fn traceroute_tcp_parses_and_sorts_sizes() {
    let mode = traceroute_mode(serde_json::json!({
        "host": "example.com",
        "protocol": "tcp",
        "port": 443,
        "packetSizes": [1400, 64],
    }))
    .unwrap();
    assert_eq!(
        mode,
        TracerouteMode::TcpSizePair {
            port: 443,
            packet_sizes: [64, 1400],
        }
    );
}

#[test]
fn traceroute_tcp_rejects_missing_port() {
    let err = traceroute_mode(serde_json::json!({
        "host": "example.com",
        "protocol": "tcp",
        "packetSizes": [64, 1400],
    }))
    .unwrap_err();
    assert!(err.to_string().contains("missing target.port"));
}

#[test]
fn traceroute_tcp_rejects_wrong_size_count() {
    let err = traceroute_mode(serde_json::json!({
        "host": "example.com",
        "protocol": "tcp",
        "port": 443,
        "packetSizes": [64, 1400, 500],
    }))
    .unwrap_err();
    assert!(err.to_string().contains("exactly two"));
}

#[test]
fn traceroute_tcp_rejects_duplicate_sizes() {
    let err = traceroute_mode(serde_json::json!({
        "host": "example.com",
        "protocol": "tcp",
        "port": 443,
        "packetSizes": [64, 64],
    }))
    .unwrap_err();
    assert!(err.to_string().contains("must differ"));
}

#[test]
fn traceroute_tcp_rejects_out_of_range_size() {
    let err = traceroute_mode(serde_json::json!({
        "host": "example.com",
        "protocol": "tcp",
        "port": 443,
        "packetSizes": [39, 1400],
    }))
    .unwrap_err();
    assert!(err.to_string().contains("out of range"));

    let err = traceroute_mode(serde_json::json!({
        "host": "example.com",
        "protocol": "tcp",
        "port": 443,
        "packetSizes": [64, 1501],
    }))
    .unwrap_err();
    assert!(err.to_string().contains("out of range"));
}

#[test]
fn traceroute_tcp_rejects_unknown_protocol() {
    let err = traceroute_mode(serde_json::json!({
        "host": "example.com",
        "protocol": "udp",
        "port": 443,
        "packetSizes": [64, 1400],
    }))
    .unwrap_err();
    assert!(err.to_string().contains("unsupported traceroute protocol"));
}

#[test]
fn tcp_syn_matches_configured_total_length() {
    let source = Ipv4Addr::new(192, 0, 2, 10);
    let dest = Ipv4Addr::new(203, 0, 113, 10);
    for packet_size in [40u16, 64, 1400, 1500] {
        let segment =
            traceroute_tcp::build_tcp_syn(source, dest, 40000, 443, 0x11223344, packet_size);
        // Kernel prepends a 20-byte IPv4 header, so segment == packet_size - 20.
        assert_eq!(segment.len(), packet_size as usize - 20);
        assert_eq!(
            segment.len(),
            20 + traceroute_tcp::payload_len_for(packet_size)
        );
    }
}

#[test]
fn tcp_syn_checksum_is_valid_for_even_and_odd_payloads() {
    let source = Ipv4Addr::new(192, 0, 2, 10);
    let dest = Ipv4Addr::new(203, 0, 113, 10);
    // 64 -> payload 24 (even); 41 -> payload 1 (odd).
    for packet_size in [41u16, 64] {
        let segment =
            traceroute_tcp::build_tcp_syn(source, dest, 40000, 443, 0xdead_beef, packet_size);
        // Recomputing the checksum over a segment that already carries its
        // checksum must yield zero (ones-complement sum is all ones).
        assert_eq!(traceroute_tcp::tcp_checksum(source, dest, &segment), 0);
    }
}

#[test]
fn tcp_reset_uses_syn_ack_acknowledgment_as_sequence() {
    let source = Ipv4Addr::new(192, 0, 2, 10);
    let dest = Ipv4Addr::new(203, 0, 113, 10);
    let reset_seq = 0x1234_5678;
    let segment = traceroute_tcp::build_tcp_reset(source, dest, 40000, 443, reset_seq);

    assert_eq!(segment.len(), 20);
    assert_eq!(segment[13], 0x04);
    assert_eq!(
        u32::from_be_bytes(segment[4..8].try_into().unwrap()),
        reset_seq
    );
    assert_eq!(traceroute_tcp::tcp_checksum(source, dest, &segment), 0);
}

struct QuoteSpec {
    icmp_type: u8,
    icmp_code: u8,
    next_hop_mtu: u16,
    source: Ipv4Addr,
    dest: Ipv4Addr,
    source_port: u16,
    dest_port: u16,
    seq: u32,
    total_length: u16,
}

fn synth_icmp_quote(spec: &QuoteSpec) -> Vec<u8> {
    let mut msg = vec![0u8; 8 + 20 + 8];
    msg[0] = spec.icmp_type;
    msg[1] = spec.icmp_code;
    // checksum [2..4] left zero; next-hop MTU lives in [6..8] for frag-needed.
    msg[6..8].copy_from_slice(&spec.next_hop_mtu.to_be_bytes());

    let ip = &mut msg[8..8 + 20];
    ip[0] = 0x45; // version 4, IHL 5
    ip[2..4].copy_from_slice(&spec.total_length.to_be_bytes());
    ip[9] = 6; // TCP
    ip[12..16].copy_from_slice(&spec.source.octets());
    ip[16..20].copy_from_slice(&spec.dest.octets());

    let tcp = &mut msg[8 + 20..];
    tcp[0..2].copy_from_slice(&spec.source_port.to_be_bytes());
    tcp[2..4].copy_from_slice(&spec.dest_port.to_be_bytes());
    tcp[4..8].copy_from_slice(&spec.seq.to_be_bytes());
    msg
}

#[test]
fn icmp_quote_matches_tuple_seq_and_total_length() {
    let source = Ipv4Addr::new(192, 0, 2, 10);
    let dest = Ipv4Addr::new(203, 0, 113, 10);
    let msg = synth_icmp_quote(&QuoteSpec {
        icmp_type: 11,
        icmp_code: 0,
        next_hop_mtu: 0,
        source,
        dest,
        source_port: 40000,
        dest_port: 443,
        seq: 0x1234,
        total_length: 64,
    });

    let matched = traceroute_tcp::parse_icmp_tcp_quote(&msg, source, dest, 40000, 443)
        .expect("quote must match");
    assert_eq!(matched.inner_seq, 0x1234);
    assert_eq!(matched.inner_total_length, 64);
    assert_eq!(matched.icmp_type, 11);
}

#[test]
fn icmp_quote_rejects_wrong_identity() {
    let source = Ipv4Addr::new(192, 0, 2, 10);
    let dest = Ipv4Addr::new(203, 0, 113, 10);
    let msg = synth_icmp_quote(&QuoteSpec {
        icmp_type: 11,
        icmp_code: 0,
        next_hop_mtu: 0,
        source,
        dest,
        source_port: 40000,
        dest_port: 443,
        seq: 0x1234,
        total_length: 64,
    });

    // Wrong destination IP.
    assert!(
        traceroute_tcp::parse_icmp_tcp_quote(
            &msg,
            source,
            Ipv4Addr::new(198, 51, 100, 1),
            40000,
            443
        )
        .is_none()
    );
    // Wrong source port.
    assert!(traceroute_tcp::parse_icmp_tcp_quote(&msg, source, dest, 40001, 443).is_none());
    // Wrong destination port.
    assert!(traceroute_tcp::parse_icmp_tcp_quote(&msg, source, dest, 40000, 80).is_none());
}

#[test]
fn icmp_fragmentation_needed_reports_next_hop_mtu() {
    let source = Ipv4Addr::new(192, 0, 2, 10);
    let dest = Ipv4Addr::new(203, 0, 113, 10);
    let msg = synth_icmp_quote(&QuoteSpec {
        icmp_type: 3,
        icmp_code: 4,
        next_hop_mtu: 1400,
        source,
        dest,
        source_port: 40000,
        dest_port: 443,
        seq: 0x5678,
        total_length: 1500,
    });

    let matched = traceroute_tcp::parse_icmp_tcp_quote(&msg, source, dest, 40000, 443)
        .expect("quote must match");
    assert_eq!(matched.icmp_type, 3);
    assert_eq!(matched.icmp_code, 4);
    assert_eq!(matched.next_hop_mtu, Some(1400));
    assert_eq!(matched.inner_total_length, 1500);
}

fn synth_tcp_response(src_port: u16, dst_port: u16, ack: u32, flags: u8) -> Vec<u8> {
    let mut seg = vec![0u8; 20];
    seg[0..2].copy_from_slice(&src_port.to_be_bytes());
    seg[2..4].copy_from_slice(&dst_port.to_be_bytes());
    seg[8..12].copy_from_slice(&ack.to_be_bytes());
    seg[13] = flags;
    seg
}

#[test]
fn tcp_syn_ack_matches_ack_of_syn_and_syn_plus_payload() {
    let seq = 1000u32;
    let packet_size = 64u16; // payload 24
    // SYN-ACK acknowledging just the SYN.
    let resp = traceroute_tcp::parse_tcp_segment(&synth_tcp_response(443, 40000, seq + 1, 0x12))
        .expect("parse");
    assert!(traceroute_tcp::tcp_response_matches_probe(
        &resp,
        443,
        40000,
        seq,
        packet_size
    ));

    // SYN-ACK acknowledging SYN + payload.
    let payload = traceroute_tcp::payload_len_for(packet_size) as u32;
    let resp =
        traceroute_tcp::parse_tcp_segment(&synth_tcp_response(443, 40000, seq + 1 + payload, 0x12))
            .expect("parse");
    assert!(traceroute_tcp::tcp_response_matches_probe(
        &resp,
        443,
        40000,
        seq,
        packet_size
    ));
}

#[test]
fn tcp_syn_ack_matches_partial_payload_ack() {
    let seq = 1000u32;
    let packet_size = 64u16;
    let partial_payload = traceroute_tcp::payload_len_for(packet_size) as u32 / 2;
    let ack = seq.wrapping_add(1 + partial_payload);
    let resp = traceroute_tcp::parse_tcp_segment(&synth_tcp_response(443, 40000, ack, 0x12))
        .expect("parse");

    assert!(traceroute_tcp::tcp_response_matches_probe(
        &resp,
        443,
        40000,
        seq,
        packet_size
    ));
}

#[test]
fn tcp_syn_ack_matches_partial_payload_ack_across_sequence_wrap() {
    let seq = u32::MAX - 5;
    let packet_size = 64u16;
    let ack = seq.wrapping_add(13);
    let resp = traceroute_tcp::parse_tcp_segment(&synth_tcp_response(443, 40000, ack, 0x12))
        .expect("parse");

    assert!(traceroute_tcp::tcp_response_matches_probe(
        &resp,
        443,
        40000,
        seq,
        packet_size
    ));
}

#[test]
fn tcp_rst_ack_matches_when_ack_covers_syn() {
    let seq = 2000u32;
    // RST+ACK from a closed port acknowledging our SYN (flags = RST|ACK = 0x14).
    let resp = traceroute_tcp::parse_tcp_segment(&synth_tcp_response(443, 40000, seq + 1, 0x14))
        .expect("parse");
    assert!(traceroute_tcp::tcp_response_matches_probe(
        &resp, 443, 40000, seq, 64
    ));
}

#[test]
fn tcp_bare_rst_is_not_attributable() {
    let resp =
        traceroute_tcp::parse_tcp_segment(&synth_tcp_response(443, 40000, 0, 0x04)).expect("parse");
    // A bare RST (no ACK) carries no sequence link, so it must not be attributed
    // to any size — otherwise a size that never arrived could be marked reached,
    // hiding a genuine size-based route divergence.
    assert!(!traceroute_tcp::tcp_response_matches_probe(
        &resp, 443, 40000, 999, 64
    ));
}

#[test]
fn tcp_response_rejects_wrong_ports_and_wrong_ack() {
    // Wrong ports.
    let resp = traceroute_tcp::parse_tcp_segment(&synth_tcp_response(80, 40000, 1001, 0x12))
        .expect("parse");
    assert!(!traceroute_tcp::tcp_response_matches_probe(
        &resp, 443, 40000, 1000, 64
    ));

    // SYN-ACK with an unrelated ACK number.
    let resp =
        traceroute_tcp::parse_tcp_segment(&synth_tcp_response(443, 40000, 5, 0x12)).expect("parse");
    assert!(!traceroute_tcp::tcp_response_matches_probe(
        &resp, 443, 40000, 1000, 64
    ));
}

#[test]
fn emsgsize_is_recognized_as_packet_too_large() {
    let too_large = std::io::Error::from_raw_os_error(libc::EMSGSIZE);
    assert!(traceroute_tcp::is_message_too_long(&too_large));
    let other = std::io::Error::from_raw_os_error(libc::ECONNREFUSED);
    assert!(!traceroute_tcp::is_message_too_long(&other));
}

#[test]
fn tcp_ack_does_not_collide_across_sizes() {
    // The reported collision case: sizes [41, 1400]. With adjacent sequence
    // numbers, size 41's `seq+1+payload` (payload 1 → S+2) equaled size 1400's
    // `seq+1`. The stride in derive_sequence must keep the ranges disjoint.
    let nonce = 0x3000_0000u32;
    let ttl = 4u8;
    let small = 41u16;
    let large = 1400u16;
    let seq_small = traceroute_tcp::derive_sequence(nonce, ttl, 0);
    let seq_large = traceroute_tcp::derive_sequence(nonce, ttl, 1);

    // The small size's "SYN + payload" ACK must match the small size only.
    let ack_small = seq_small.wrapping_add(1 + traceroute_tcp::payload_len_for(small) as u32);
    let resp = traceroute_tcp::parse_tcp_segment(&synth_tcp_response(443, 40000, ack_small, 0x12))
        .expect("parse");
    assert!(traceroute_tcp::tcp_response_matches_probe(
        &resp, 443, 40000, seq_small, small
    ));
    assert!(!traceroute_tcp::tcp_response_matches_probe(
        &resp, 443, 40000, seq_large, large
    ));

    // The large size's SYN ACK must match the large size only.
    let ack_large = seq_large.wrapping_add(1);
    let resp2 = traceroute_tcp::parse_tcp_segment(&synth_tcp_response(443, 40000, ack_large, 0x12))
        .expect("parse");
    assert!(traceroute_tcp::tcp_response_matches_probe(
        &resp2, 443, 40000, seq_large, large
    ));
    assert!(!traceroute_tcp::tcp_response_matches_probe(
        &resp2, 443, 40000, seq_small, small
    ));
}

#[test]
fn tcp_target_retry_ack_does_not_match_paired_probes() {
    let nonce = 0x3000_0000u32;
    let ttl = 4u8;
    let packet_size = 1400u16;
    let paired_small = traceroute_tcp::derive_sequence(nonce, ttl, 0);
    let paired_large = traceroute_tcp::derive_sequence(nonce, ttl, 1);
    let retry_large = traceroute_tcp::derive_retry_sequence(nonce, ttl, 1);
    let retry_ack = retry_large.wrapping_add(700);
    let resp = traceroute_tcp::parse_tcp_segment(&synth_tcp_response(443, 40000, retry_ack, 0x12))
        .expect("parse");

    assert!(traceroute_tcp::tcp_response_matches_probe(
        &resp,
        443,
        40000,
        retry_large,
        packet_size
    ));
    assert!(!traceroute_tcp::tcp_response_matches_probe(
        &resp,
        443,
        40000,
        paired_small,
        64
    ));
    assert!(!traceroute_tcp::tcp_response_matches_probe(
        &resp,
        443,
        40000,
        paired_large,
        packet_size
    ));
}

fn round_ctx() -> traceroute_tcp::RoundCtx {
    traceroute_tcp::RoundCtx {
        source_ip: Ipv4Addr::new(192, 0, 2, 10),
        target_ip: Ipv4Addr::new(203, 0, 113, 10),
        source_port: 40000,
        dest_port: 443,
    }
}

#[test]
fn intermediate_dest_unreachable_stops_size_with_reason() {
    let ctx = round_ctx();
    let seq = traceroute_tcp::derive_sequence(0x2000_0000, 5, 0);
    // Host-unreachable (type 3, code 1) from an intermediate router, quoting the
    // 64-byte probe.
    let msg = synth_icmp_quote(&QuoteSpec {
        icmp_type: 3,
        icmp_code: 1,
        next_hop_mtu: 0,
        source: ctx.source_ip,
        dest: ctx.target_ip,
        source_port: ctx.source_port,
        dest_port: ctx.dest_port,
        seq,
        total_length: 64,
    });
    let from = IpAddr::V4(Ipv4Addr::new(198, 51, 100, 7));
    let mut pending = vec![traceroute_tcp::Pending {
        size_index: 0,
        seq,
        packet_size: 64,
        sent_at: std::time::Instant::now(),
    }];
    let mut states = [
        traceroute_tcp::SizeState::new(64),
        traceroute_tcp::SizeState::new(1400),
    ];

    traceroute_tcp::apply_icmp(&msg, from, &ctx, 5, &mut pending, &mut states);

    assert!(pending.is_empty(), "probe must be resolved");
    assert!(
        states[0].stopped,
        "size must stop on intermediate unreachable"
    );
    assert!(
        !states[0].reached,
        "intermediate unreachable is not a reach"
    );
    assert_eq!(states[0].error_code, Some("host_unreachable"));
    assert!(!states[1].stopped, "the other size must be unaffected");
}

#[test]
fn time_exceeded_records_hop_without_stopping() {
    let ctx = round_ctx();
    let seq = traceroute_tcp::derive_sequence(0x2100_0000, 3, 0);
    let msg = synth_icmp_quote(&QuoteSpec {
        icmp_type: 11, // Time Exceeded
        icmp_code: 0,
        next_hop_mtu: 0,
        source: ctx.source_ip,
        dest: ctx.target_ip,
        source_port: ctx.source_port,
        dest_port: ctx.dest_port,
        seq,
        total_length: 64,
    });
    let from = IpAddr::V4(Ipv4Addr::new(198, 51, 100, 3));
    let mut pending = vec![traceroute_tcp::Pending {
        size_index: 0,
        seq,
        packet_size: 64,
        sent_at: std::time::Instant::now(),
    }];
    let mut states = [
        traceroute_tcp::SizeState::new(64),
        traceroute_tcp::SizeState::new(1400),
    ];

    traceroute_tcp::apply_icmp(&msg, from, &ctx, 3, &mut pending, &mut states);

    assert!(pending.is_empty());
    assert!(
        !states[0].stopped,
        "Time Exceeded is an ordinary hop, not a stop"
    );
    assert!(states[0].error_code.is_none());
    assert_eq!(states[0].hops.len(), 1);
}

#[test]
fn frag_needed_records_reporter_and_marks_frag_hop() {
    let ctx = round_ctx();
    let seq = traceroute_tcp::derive_sequence(0x3300_0000, 4, 1);
    let msg = synth_icmp_quote(&QuoteSpec {
        icmp_type: 3,
        icmp_code: 4,
        next_hop_mtu: 1400,
        source: ctx.source_ip,
        dest: ctx.target_ip,
        source_port: ctx.source_port,
        dest_port: ctx.dest_port,
        seq,
        total_length: 1500,
    });
    let from = IpAddr::V4(Ipv4Addr::new(198, 51, 100, 3));
    let mut pending = vec![traceroute_tcp::Pending {
        size_index: 1,
        seq,
        packet_size: 1500,
        sent_at: std::time::Instant::now(),
    }];
    let mut states = [
        traceroute_tcp::SizeState::new(64),
        traceroute_tcp::SizeState::new(1500),
    ];

    traceroute_tcp::apply_icmp(&msg, from, &ctx, 4, &mut pending, &mut states);

    assert!(pending.is_empty(), "probe must be resolved");
    assert!(states[1].stopped);
    assert!(!states[1].reached);
    assert_eq!(states[1].error_code, Some("packet_too_large"));
    assert_eq!(states[1].path_mtu, Some(1400));
    assert_eq!(states[1].frag_hop_ttl, Some(4));
    assert_eq!(states[1].hops.len(), 1);
    assert_eq!(states[1].hops[0].ttl, 4);
    assert_eq!(states[1].hops[0].addr, Some(from));
    assert!(
        states[0].hops.is_empty(),
        "the other size must be unaffected"
    );
}

#[test]
fn build_hop_entries_empty_input_returns_empty() {
    // A size abandoned on the first send (EMSGSIZE) has no hops; it must not
    // render a phantom TTL-1 timeout alongside its packet_too_large error.
    let rdns = HashMap::<IpAddr, String>::new();
    assert!(build_hop_entries(&[], &rdns).is_empty());
}

// On platforms without a raw TCP receive backend, the probe must refuse to run
// rather than silently returning `not_reached` for reachable targets. This runs
// wherever `TCP_SIZE_PAIR_SUPPORTED` is false (currently every non-Linux target).
#[tokio::test]
#[cfg(not(target_os = "linux"))]
async fn tcp_probe_refuses_on_unsupported_platform() {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    let outcome = traceroute_tcp::probe("example.com", 443, [64, 1400], deadline).await;
    let body = outcome.into_result_body("task".to_string(), 0);
    assert_eq!(body.error.as_deref(), Some("unsupported_platform"));
    assert!(!body.ok);
}

// Run with:
// cargo test -p hina-agent tcp_size_pair_reaches_open_linux_listener_at_same_ttl -- --ignored
#[tokio::test]
#[cfg(target_os = "linux")]
#[ignore = "requires CAP_NET_RAW or root"]
async fn tcp_size_pair_reaches_open_linux_listener_at_same_ttl() {
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);

    let outcome = traceroute_tcp::probe("127.0.0.1", port, [64, 1400], deadline).await;
    let body = outcome.into_result_body("task".to_string(), 0);
    assert!(body.ok, "probe failed: {:?}", body.error);

    let traces = body.extra.as_ref().unwrap()["traces"].as_array().unwrap();
    let terminal_ttls = traces
        .iter()
        .map(|trace| {
            assert_eq!(trace["destination_reached"], Value::Bool(true));
            trace["hops"].as_array().unwrap().last().unwrap()["ttl"]
                .as_u64()
                .unwrap()
        })
        .collect::<Vec<_>>();

    assert_eq!(terminal_ttls, vec![1, 1]);
}

fn hop_at(ttl: u8, octets: [u8; 4]) -> HopResult {
    HopResult {
        ttl,
        addr: Some(IpAddr::V4(Ipv4Addr::from(octets))),
        rtt: None,
    }
}

fn hop_timeout(ttl: u8) -> HopResult {
    HopResult {
        ttl,
        addr: None,
        rtt: None,
    }
}

fn size_state_with_hops(packet_size: u16, hops: Vec<HopResult>) -> traceroute_tcp::SizeState {
    let mut state = traceroute_tcp::SizeState::new(packet_size);
    state.hops = hops;
    state
}

#[test]
fn comparison_flags_first_diverging_ttl() {
    let small = size_state_with_hops(64, vec![hop_at(1, [10, 0, 0, 1]), hop_at(2, [10, 0, 0, 2])]);
    let large = size_state_with_hops(
        1400,
        vec![hop_at(1, [10, 0, 0, 1]), hop_at(2, [10, 9, 9, 9])],
    );
    let comparison = traceroute_tcp::compute_comparison(&small, &large);
    assert_eq!(comparison["comparable"], Value::Bool(true));
    assert_eq!(comparison["route_diverged"], Value::Bool(true));
    assert_eq!(comparison["first_diverging_ttl"], serde_json::json!(2));
}

#[test]
fn comparison_ignores_timeouts_as_divergence() {
    let small = size_state_with_hops(64, vec![hop_at(1, [10, 0, 0, 1]), hop_timeout(2)]);
    let large = size_state_with_hops(
        1400,
        vec![hop_at(1, [10, 0, 0, 1]), hop_at(2, [10, 9, 9, 9])],
    );
    let comparison = traceroute_tcp::compute_comparison(&small, &large);
    // Only TTL 1 is comparable and it agrees; the TTL-2 timeout is not divergence.
    assert_eq!(comparison["comparable"], Value::Bool(true));
    assert_eq!(comparison["route_diverged"], Value::Bool(false));
    assert_eq!(comparison["first_diverging_ttl"], Value::Null);
}

#[test]
fn comparison_not_comparable_without_shared_concrete_ttl() {
    let small = size_state_with_hops(64, vec![hop_at(1, [10, 0, 0, 1])]);
    let large = size_state_with_hops(1400, vec![hop_timeout(1)]);
    let comparison = traceroute_tcp::compute_comparison(&small, &large);
    assert_eq!(comparison["comparable"], Value::Bool(false));
    assert_eq!(comparison["route_diverged"], Value::Bool(false));
}

#[test]
fn comparison_excludes_frag_needed_hop_from_divergence() {
    // Low-MTU link behind the TTL-3 router: the TTL-4 large probe outlives that
    // router, gets forwarded into the too-small link, and the TTL-3 router
    // answers Fragmentation Needed — recorded at TTL 4. The small probe's
    // genuine TTL-4 hop differs, but the path is identical; no divergence.
    let small = size_state_with_hops(
        64,
        vec![
            hop_at(1, [10, 0, 0, 1]),
            hop_at(2, [10, 0, 0, 2]),
            hop_at(3, [10, 0, 0, 3]),
            hop_at(4, [10, 0, 0, 4]),
        ],
    );
    let mut large = size_state_with_hops(
        1400,
        vec![
            hop_at(1, [10, 0, 0, 1]),
            hop_at(2, [10, 0, 0, 2]),
            hop_at(3, [10, 0, 0, 3]),
            hop_at(4, [10, 0, 0, 3]),
        ],
    );
    large.frag_hop_ttl = Some(4);
    large.error_code = Some("packet_too_large");
    large.path_mtu = Some(1400);

    let comparison = traceroute_tcp::compute_comparison(&small, &large);
    assert_eq!(comparison["comparable"], Value::Bool(true));
    assert_eq!(comparison["route_diverged"], Value::Bool(false));
    assert_eq!(comparison["first_diverging_ttl"], Value::Null);
}

#[test]
fn comparison_still_flags_divergence_before_frag_needed_hop() {
    let small = size_state_with_hops(
        64,
        vec![
            hop_at(1, [10, 0, 0, 1]),
            hop_at(2, [10, 0, 0, 2]),
            hop_at(3, [10, 0, 0, 3]),
        ],
    );
    let mut large = size_state_with_hops(
        1400,
        vec![
            hop_at(1, [10, 0, 0, 1]),
            hop_at(2, [10, 9, 9, 9]),
            hop_at(3, [10, 9, 9, 2]),
        ],
    );
    large.frag_hop_ttl = Some(3);

    let comparison = traceroute_tcp::compute_comparison(&small, &large);
    assert_eq!(comparison["comparable"], Value::Bool(true));
    assert_eq!(comparison["route_diverged"], Value::Bool(true));
    assert_eq!(comparison["first_diverging_ttl"], serde_json::json!(2));
}

#[test]
fn v2_extra_matches_schema() {
    let target_ip = Ipv4Addr::new(203, 0, 113, 10);
    let mut small = traceroute_tcp::SizeState::new(64);
    small.hops.push(HopResult {
        ttl: 1,
        addr: Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))),
        rtt: Some(Duration::from_millis(1)),
    });
    small.reached = true;
    let mut large = traceroute_tcp::SizeState::new(1400);
    large.hops.push(HopResult {
        ttl: 1,
        addr: Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))),
        rtt: Some(Duration::from_millis(2)),
    });
    large.error_code = Some("packet_too_large");
    large.path_mtu = Some(1400);
    large.frag_hop_ttl = Some(1);

    let run = traceroute_tcp::TcpRunResult {
        source_ip: Ipv4Addr::new(192, 0, 2, 10),
        source_port: 40000,
        states: [small, large],
        total_duration: Duration::from_millis(123),
    };

    let extra =
        traceroute_tcp::build_v2_extra("example.com", target_ip, 443, &run, &HashMap::new());

    assert_eq!(extra["kind"], "traceroute");
    assert_eq!(extra["v"], serde_json::json!(2));
    assert_eq!(extra["protocol_used"], "tcp");
    assert_eq!(extra["probe_style"], "tcp_syn_payload");
    assert_eq!(extra["port"], serde_json::json!(443));
    assert_eq!(extra["origin_ip"], "192.0.2.10");

    let traces = extra["traces"].as_array().expect("traces array");
    assert_eq!(traces.len(), 2);
    assert_eq!(traces[0]["packet_size_bytes"], serde_json::json!(64));
    assert_eq!(traces[0]["destination_reached"], Value::Bool(true));
    assert_eq!(traces[1]["packet_size_bytes"], serde_json::json!(1400));
    assert_eq!(traces[1]["error_code"], "packet_too_large");
    assert_eq!(traces[1]["path_mtu_bytes"], serde_json::json!(1400));
    assert!(traces[0]["frag_hop_ttl"].is_null());
    assert_eq!(traces[1]["frag_hop_ttl"], serde_json::json!(1));

    // The only shared concrete TTL is the large size's frag-needed hop, which
    // is excluded from comparison — nothing comparable remains.
    assert_eq!(extra["comparison"]["comparable"], Value::Bool(false));
    assert_eq!(extra["comparison"]["route_diverged"], Value::Bool(false));
}

/// Minimal cBPF interpreter covering exactly the opcodes used by
/// `tcp_probe_filter`, so the filter's accept/drop behavior is testable off
/// Linux. Return semantics match the kernel: 0 drops, non-zero accepts.
fn run_cbpf(prog: &[traceroute_tcp::FilterInsn], pkt: &[u8]) -> u32 {
    let be16 = |off: usize| u16::from_be_bytes([pkt[off], pkt[off + 1]]) as u32;
    let mut a: u32 = 0;
    let mut x: u32 = 0;
    let mut pc = 0usize;
    loop {
        let insn = prog[pc];
        pc += 1;
        match insn.code {
            0x20 => {
                let off = insn.k as usize;
                a = u32::from_be_bytes([pkt[off], pkt[off + 1], pkt[off + 2], pkt[off + 3]]);
            }
            0x28 => a = be16(insn.k as usize),
            0x48 => a = be16(x as usize + insn.k as usize),
            0xb1 => x = 4 * (pkt[insn.k as usize] & 0x0f) as u32,
            0x15 => pc += usize::from(if a == insn.k { insn.jt } else { insn.jf }),
            0x45 => pc += usize::from(if a & insn.k != 0 { insn.jt } else { insn.jf }),
            0x06 => return insn.k,
            other => panic!("unsupported cBPF opcode {other:#04x}"),
        }
    }
}

fn synth_ipv4_tcp(
    src: Ipv4Addr,
    dst: Ipv4Addr,
    ihl_words: u8,
    flags_frag: u16,
    src_port: u16,
    dst_port: u16,
) -> Vec<u8> {
    let ihl = ihl_words as usize * 4;
    let mut pkt = vec![0u8; ihl + 20];
    pkt[0] = 0x40 | ihl_words;
    pkt[6..8].copy_from_slice(&flags_frag.to_be_bytes());
    pkt[9] = 6; // TCP
    pkt[12..16].copy_from_slice(&src.octets());
    pkt[16..20].copy_from_slice(&dst.octets());
    pkt[ihl..ihl + 2].copy_from_slice(&src_port.to_be_bytes());
    pkt[ihl + 2..ihl + 4].copy_from_slice(&dst_port.to_be_bytes());
    pkt
}

#[test]
fn tcp_probe_filter_accepts_only_the_probe_tuple() {
    let target = Ipv4Addr::new(203, 0, 113, 10);
    let local = Ipv4Addr::new(192, 0, 2, 10);
    let prog = traceroute_tcp::tcp_probe_filter(target, 443, 40000);

    // The target's SYN-ACK to this round's tuple.
    assert!(run_cbpf(&prog, &synth_ipv4_tcp(target, local, 5, 0, 443, 40000)) > 0);
    // DF set on the reply must not matter (only the fragment offset does).
    assert!(run_cbpf(&prog, &synth_ipv4_tcp(target, local, 5, 0x4000, 443, 40000)) > 0);
    // IPv4 options (IHL > 5): the port loads must follow the actual header length.
    assert!(run_cbpf(&prog, &synth_ipv4_tcp(target, local, 6, 0, 443, 40000)) > 0);

    // Unrelated inbound TCP (e.g. the agent's own WebSocket peer).
    let other_src = Ipv4Addr::new(198, 51, 100, 9);
    assert_eq!(
        run_cbpf(&prog, &synth_ipv4_tcp(other_src, local, 5, 0, 443, 40000)),
        0
    );
    // Right host, wrong source port.
    assert_eq!(
        run_cbpf(&prog, &synth_ipv4_tcp(target, local, 5, 0, 8443, 40000)),
        0
    );
    // Right service, addressed to a different local port.
    assert_eq!(
        run_cbpf(&prog, &synth_ipv4_tcp(target, local, 5, 0, 443, 40001)),
        0
    );
    // Non-first fragment: the "ports" would be payload bytes, drop outright.
    assert_eq!(
        run_cbpf(&prog, &synth_ipv4_tcp(target, local, 5, 0x00b9, 443, 40000)),
        0
    );
}

#[test]
fn tcp_probe_filter_jumps_stay_in_bounds() {
    let prog = traceroute_tcp::tcp_probe_filter(Ipv4Addr::new(1, 2, 3, 4), 1, 2);
    for (i, insn) in prog.iter().enumerate() {
        // 0x15 = JEQ, 0x45 = JSET; the other opcodes here ignore jt/jf.
        if insn.code != 0x15 && insn.code != 0x45 {
            continue;
        }
        for jump in [insn.jt, insn.jf] {
            let dest = i + 1 + jump as usize;
            assert!(
                dest < prog.len(),
                "jump from {i} lands at {dest}, out of bounds"
            );
        }
    }
}
