use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};

use serde_json::Value;

use super::{
    classify_probe_error,
    family::{FamilyPolicy, IpFamily},
    sampling::{SampleStats, compute_stats},
    task::{NormalizeTaskIssue, ProbeTarget, TcpMode, TracerouteMode, normalize_tasks, parse_task},
    tcp::{classify_tcp_io_error, resolve_tcp_addrs},
    tcp_raw::{self, ProbeFlow, QuoteKind, Unreachable},
    traceroute::{
        HopResult, RawTracerouteResult, build_hop_entries, rdns_best_effort, round_ms,
        traceroute_extra_v1,
    },
    traceroute_tcp,
};
use crate::protocol::{ProbeTaskKind, ProbeTaskWire};

const V4_SOURCE: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 10);
const V4_TARGET: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 10);
const V6_SOURCE: Ipv6Addr = Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0x10);
const V6_TARGET: Ipv6Addr = Ipv6Addr::new(0x2001, 0xdb8, 1, 0, 0, 0, 0, 0x10);

fn v4_flow() -> ProbeFlow {
    ProbeFlow::new(V4_SOURCE.into(), V4_TARGET.into(), 40000, 443).unwrap()
}

fn v6_flow() -> ProbeFlow {
    ProbeFlow::new(V6_SOURCE.into(), V6_TARGET.into(), 40000, 443).unwrap()
}

fn compute_icmp_stats(sent: u8, rtts: &[Duration]) -> SampleStats {
    compute_stats(sent, rtts.len() as u8, rtts)
}

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
        ProbeTarget::Tcp {
            host: "example.com".to_string(),
            port: 443,
            mode: TcpMode::Connect {
                family: FamilyPolicy::Auto,
            },
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
    let target_ip = IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1));
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

    let extra = traceroute_extra_v1(&result, Some(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2))), &rdns);

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
    let addrs = resolve_tcp_addrs("127.0.0.1", 4860, FamilyPolicy::Auto, deadline)
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
    assert_eq!(
        mode,
        TracerouteMode::Icmp {
            family: FamilyPolicy::Auto
        }
    );
}

#[test]
fn traceroute_explicit_icmp_protocol_is_icmp() {
    let mode =
        traceroute_mode(serde_json::json!({ "host": "example.com", "protocol": "icmp" })).unwrap();
    assert_eq!(
        mode,
        TracerouteMode::Icmp {
            family: FamilyPolicy::Auto
        }
    );
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
            family: IpFamily::V4,
            port: 443,
            packet_sizes: [64, 1400],
        }
    );
}

#[test]
fn traceroute_honors_family_and_its_minimum_packet_size() {
    let mode = traceroute_mode(serde_json::json!({
        "host": "example.com",
        "family": "ipv6",
        "protocol": "tcp",
        "port": 443,
        "packetSizes": [1500, 60],
    }))
    .unwrap();
    assert_eq!(
        mode,
        TracerouteMode::TcpSizePair {
            family: IpFamily::V6,
            port: 443,
            packet_sizes: [60, 1500],
        }
    );

    // A bare IPv6 SYN is 60 bytes, so 40 cannot be sent over IPv6.
    let err = traceroute_mode(serde_json::json!({
        "host": "2001:db8::1",
        "protocol": "tcp",
        "port": 443,
        "packetSizes": [40, 1400],
    }))
    .unwrap_err();
    assert!(err.to_string().contains("out of range"));

    let mode =
        traceroute_mode(serde_json::json!({ "host": "example.com", "family": "ipv6" })).unwrap();
    assert_eq!(
        mode,
        TracerouteMode::Icmp {
            family: FamilyPolicy::Only(IpFamily::V6)
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
    for (flow, ip_header_len) in [(v4_flow(), 20), (v6_flow(), 40)] {
        for packet_size in [60u16, 64, 1200, 1280, 1400, 1500] {
            let segment = flow.syn(0x11223344, packet_size);
            // The kernel prepends the fixed IP header, so the segment is the rest of the packet.
            assert_eq!(segment.len(), packet_size as usize - ip_header_len);
            assert_eq!(segment.len(), 20 + flow.payload_len(packet_size));
        }
    }
    assert_eq!(v4_flow().syn(1, 40).len(), 20);
}

#[test]
fn tcp_syn_checksum_is_valid_for_even_and_odd_payloads() {
    // Payloads of 0, 1 (odd), 4 and 1140 bytes on IPv6; one more of each on IPv4.
    for flow in [v4_flow(), v6_flow()] {
        for packet_size in [60u16, 61, 64, 1200] {
            let segment = flow.syn(0xdead_beef, packet_size);
            // Recomputing the checksum over a segment that already carries its
            // checksum must yield zero (ones-complement sum is all ones).
            assert_eq!(flow.checksum(&segment), 0);
        }
    }
}

/// RFC 1071 over the concatenated bytes, independent of the production word-sum helpers.
fn reference_checksum(pseudo_header: &[u8], segment: &[u8]) -> u16 {
    let mut bytes = [pseudo_header, segment].concat();
    if bytes.len() % 2 == 1 {
        bytes.push(0);
    }
    let mut sum: u64 = bytes
        .chunks(2)
        .map(|word| u64::from(u16::from_be_bytes([word[0], word[1]])))
        .sum();
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

#[test]
fn tcp_checksum_matches_rfc_pseudo_headers() {
    for flow in [v4_flow(), v6_flow()] {
        for packet_size in [60u16, 61, 1500] {
            let mut segment = flow.syn(0xdead_beef, packet_size);
            segment[16..18].fill(0);
            let len = segment.len();
            let pseudo_header = match (flow.source_ip(), flow.target_ip()) {
                // Source, destination, zero, protocol, 16-bit TCP length (RFC 793).
                (IpAddr::V4(source), IpAddr::V4(target)) => [
                    &source.octets()[..],
                    &target.octets(),
                    &[0, 6],
                    &(len as u16).to_be_bytes(),
                ]
                .concat(),
                // Source, destination, 32-bit length, three zero bytes, next header (RFC 8200).
                (IpAddr::V6(source), IpAddr::V6(target)) => [
                    &source.octets()[..],
                    &target.octets(),
                    &(len as u32).to_be_bytes(),
                    &[0, 0, 0, 6],
                ]
                .concat(),
                _ => unreachable!("flows never mix families"),
            };
            assert_eq!(
                flow.checksum(&segment),
                reference_checksum(&pseudo_header, &segment)
            );
        }
    }
}

#[test]
fn probe_flow_rejects_mixed_families() {
    assert!(ProbeFlow::new(V4_SOURCE.into(), V6_TARGET.into(), 1, 2).is_none());
    assert!(ProbeFlow::new(V6_SOURCE.into(), V4_TARGET.into(), 1, 2).is_none());
    assert_eq!(v6_flow().family(), IpFamily::V6);
}

#[test]
fn tcp_reset_uses_syn_ack_acknowledgment_as_sequence() {
    let reset_seq = 0x1234_5678;
    for flow in [v4_flow(), v6_flow()] {
        let segment = flow.reset(reset_seq);

        assert_eq!(segment.len(), 20);
        assert_eq!(segment[13], 0x04);
        assert_eq!(
            u32::from_be_bytes(segment[4..8].try_into().unwrap()),
            reset_seq
        );
        assert_eq!(flow.checksum(&segment), 0);
    }
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

fn v4_quote(
    icmp_type: u8,
    icmp_code: u8,
    next_hop_mtu: u16,
    seq: u32,
    total_length: u16,
) -> Vec<u8> {
    synth_icmp_quote(&QuoteSpec {
        icmp_type,
        icmp_code,
        next_hop_mtu,
        source: V4_SOURCE,
        dest: V4_TARGET,
        source_port: 40000,
        dest_port: 443,
        seq,
        total_length,
    })
}

/// ICMPv6 error quoting an IPv6 TCP probe of `v6_flow()`; `mtu` fills the Packet Too Big field.
fn v6_quote(
    icmp_type: u8,
    icmp_code: u8,
    mtu: u32,
    next_header: u8,
    seq: u32,
    total_length: u16,
) -> Vec<u8> {
    let mut msg = vec![0u8; 8 + 40 + 8];
    msg[0] = icmp_type;
    msg[1] = icmp_code;
    msg[4..8].copy_from_slice(&mtu.to_be_bytes());

    let ip = &mut msg[8..8 + 40];
    ip[0] = 0x60; // version 6
    ip[4..6].copy_from_slice(&(total_length - 40).to_be_bytes());
    ip[6] = next_header;
    ip[7] = 64; // hop limit
    ip[8..24].copy_from_slice(&V6_SOURCE.octets());
    ip[24..40].copy_from_slice(&V6_TARGET.octets());

    let tcp = &mut msg[8 + 40..];
    tcp[0..2].copy_from_slice(&40000u16.to_be_bytes());
    tcp[2..4].copy_from_slice(&443u16.to_be_bytes());
    tcp[4..8].copy_from_slice(&seq.to_be_bytes());
    msg
}

#[test]
fn icmp_quote_matches_tuple_seq_and_total_length() {
    let msg = v4_quote(11, 0, 0, 0x1234, 64);

    let matched = v4_flow().match_icmp_quote(&msg).expect("quote must match");
    assert_eq!(matched.inner_seq, 0x1234);
    assert_eq!(matched.inner_total_length, 64);
    assert_eq!(matched.kind, QuoteKind::TimeExceeded);
}

#[test]
fn icmp_quote_rejects_wrong_identity() {
    let msg = v4_quote(11, 0, 0, 0x1234, 64);
    let flow = |target: Ipv4Addr, source_port: u16, dest_port: u16| {
        ProbeFlow::new(V4_SOURCE.into(), target.into(), source_port, dest_port).unwrap()
    };

    // Wrong destination IP.
    assert!(
        flow(Ipv4Addr::new(198, 51, 100, 1), 40000, 443)
            .match_icmp_quote(&msg)
            .is_none()
    );
    // Wrong source port.
    assert!(flow(V4_TARGET, 40001, 443).match_icmp_quote(&msg).is_none());
    // Wrong destination port.
    assert!(flow(V4_TARGET, 40000, 80).match_icmp_quote(&msg).is_none());
    // An IPv6 flow never matches an ICMPv4 quote.
    assert!(v6_flow().match_icmp_quote(&msg).is_none());
}

#[test]
fn icmp_fragmentation_needed_reports_next_hop_mtu() {
    let msg = v4_quote(3, 4, 1400, 0x5678, 1500);

    let matched = v4_flow().match_icmp_quote(&msg).expect("quote must match");
    assert_eq!(matched.kind, QuoteKind::PacketTooBig { mtu: Some(1400) });
    assert_eq!(matched.inner_total_length, 1500);
}

#[test]
fn icmpv6_packet_too_big_reports_mtu_and_total_length() {
    let msg = v6_quote(2, 0, 1280, 6, 0x5678, 1500);

    let matched = v6_flow().match_icmp_quote(&msg).expect("quote must match");
    assert_eq!(matched.kind, QuoteKind::PacketTooBig { mtu: Some(1280) });
    assert_eq!(matched.inner_seq, 0x5678);
    // The IPv6 payload length excludes the 40-byte header; the match reports the full size.
    assert_eq!(matched.inner_total_length, 1500);
}

#[test]
fn icmpv6_errors_map_to_the_shared_vocabulary() {
    let kind = |icmp_type: u8, icmp_code: u8| {
        v6_flow()
            .match_icmp_quote(&v6_quote(icmp_type, icmp_code, 0, 6, 7, 60))
            .map(|quote| quote.kind)
    };

    assert_eq!(kind(3, 0), Some(QuoteKind::TimeExceeded));
    assert_eq!(kind(1, 0), Some(QuoteKind::Unreachable(Unreachable::Net)));
    assert_eq!(
        kind(1, 1),
        Some(QuoteKind::Unreachable(Unreachable::AdminProhibited))
    );
    assert_eq!(kind(1, 3), Some(QuoteKind::Unreachable(Unreachable::Host)));
    assert_eq!(kind(1, 4), Some(QuoteKind::Unreachable(Unreachable::Port)));
    // ICMPv4 numbering means something else in ICMPv6, and echo replies are not errors.
    assert_eq!(kind(11, 0), None);
    assert_eq!(kind(129, 0), None);
}

#[test]
fn icmpv6_quote_rejects_other_protocols_and_flows() {
    // UDP instead of TCP after the quoted header.
    assert!(
        v6_flow()
            .match_icmp_quote(&v6_quote(3, 0, 0, 17, 7, 60))
            .is_none()
    );
    let other_target = ProbeFlow::new(
        V6_SOURCE.into(),
        IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 2, 0, 0, 0, 0, 1)),
        40000,
        443,
    )
    .unwrap();
    assert!(
        other_target
            .match_icmp_quote(&v6_quote(3, 0, 0, 6, 7, 60))
            .is_none()
    );
    // An IPv4 flow never matches an ICMPv6 quote.
    assert!(
        v4_flow()
            .match_icmp_quote(&v6_quote(3, 0, 0, 6, 7, 60))
            .is_none()
    );
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
    let resp =
        tcp_raw::parse_tcp_segment(&synth_tcp_response(443, 40000, seq + 1, 0x12)).expect("parse");
    assert!(v4_flow().matches_response(&resp, seq, packet_size));

    // SYN-ACK acknowledging SYN + payload.
    let payload = v4_flow().payload_len(packet_size) as u32;
    let resp = tcp_raw::parse_tcp_segment(&synth_tcp_response(443, 40000, seq + 1 + payload, 0x12))
        .expect("parse");
    assert!(v4_flow().matches_response(&resp, seq, packet_size));
}

#[test]
fn tcp_syn_ack_matches_partial_payload_ack() {
    let seq = 1000u32;
    let packet_size = 64u16;
    let partial_payload = v4_flow().payload_len(packet_size) as u32 / 2;
    let ack = seq.wrapping_add(1 + partial_payload);
    let resp =
        tcp_raw::parse_tcp_segment(&synth_tcp_response(443, 40000, ack, 0x12)).expect("parse");

    assert!(v4_flow().matches_response(&resp, seq, packet_size));
}

#[test]
fn tcp_syn_ack_matches_partial_payload_ack_across_sequence_wrap() {
    let seq = u32::MAX - 5;
    let packet_size = 64u16;
    let ack = seq.wrapping_add(13);
    let resp =
        tcp_raw::parse_tcp_segment(&synth_tcp_response(443, 40000, ack, 0x12)).expect("parse");

    assert!(v4_flow().matches_response(&resp, seq, packet_size));
}

#[test]
fn tcp_rst_ack_matches_when_ack_covers_syn() {
    let seq = 2000u32;
    // RST+ACK from a closed port acknowledging our SYN (flags = RST|ACK = 0x14).
    let resp =
        tcp_raw::parse_tcp_segment(&synth_tcp_response(443, 40000, seq + 1, 0x14)).expect("parse");
    assert!(v4_flow().matches_response(&resp, seq, 64));
}

#[test]
fn tcp_bare_rst_is_not_attributable() {
    let resp = tcp_raw::parse_tcp_segment(&synth_tcp_response(443, 40000, 0, 0x04)).expect("parse");
    // A bare RST (no ACK) carries no sequence link, so it must not be attributed
    // to any size — otherwise a size that never arrived could be marked reached,
    // hiding a genuine size-based route divergence.
    assert!(!v4_flow().matches_response(&resp, 999, 64));
}

#[test]
fn tcp_response_rejects_wrong_ports_and_wrong_ack() {
    // Wrong ports.
    let resp =
        tcp_raw::parse_tcp_segment(&synth_tcp_response(80, 40000, 1001, 0x12)).expect("parse");
    assert!(!v4_flow().matches_response(&resp, 1000, 64));

    // SYN-ACK with an unrelated ACK number.
    let resp = tcp_raw::parse_tcp_segment(&synth_tcp_response(443, 40000, 5, 0x12)).expect("parse");
    assert!(!v4_flow().matches_response(&resp, 1000, 64));
}

#[test]
fn emsgsize_is_recognized_as_packet_too_large() {
    let too_large = std::io::Error::from_raw_os_error(libc::EMSGSIZE);
    assert!(tcp_raw::is_message_too_long(&too_large));
    let other = std::io::Error::from_raw_os_error(libc::ECONNREFUSED);
    assert!(!tcp_raw::is_message_too_long(&other));
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
    let ack_small = seq_small.wrapping_add(1 + v4_flow().payload_len(small) as u32);
    let resp = tcp_raw::parse_tcp_segment(&synth_tcp_response(443, 40000, ack_small, 0x12))
        .expect("parse");
    assert!(v4_flow().matches_response(&resp, seq_small, small));
    assert!(!v4_flow().matches_response(&resp, seq_large, large));

    // The large size's SYN ACK must match the large size only.
    let ack_large = seq_large.wrapping_add(1);
    let resp2 = tcp_raw::parse_tcp_segment(&synth_tcp_response(443, 40000, ack_large, 0x12))
        .expect("parse");
    assert!(v4_flow().matches_response(&resp2, seq_large, large));
    assert!(!v4_flow().matches_response(&resp2, seq_small, small));
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
    let resp = tcp_raw::parse_tcp_segment(&synth_tcp_response(443, 40000, retry_ack, 0x12))
        .expect("parse");

    assert!(v4_flow().matches_response(&resp, retry_large, packet_size));
    assert!(!v4_flow().matches_response(&resp, paired_small, 64));
    assert!(!v4_flow().matches_response(&resp, paired_large, packet_size));
}

#[test]
fn ipv6_ack_range_accounts_for_the_larger_header() {
    let seq = 5000u32;
    // A 1500-byte IPv6 packet carries 1440 payload bytes, 20 fewer than IPv4.
    assert_eq!(v6_flow().payload_len(1500), 1440);
    let full = tcp_raw::parse_tcp_segment(&synth_tcp_response(443, 40000, seq + 1 + 1440, 0x12))
        .expect("parse");
    assert!(v6_flow().matches_response(&full, seq, 1500));
    let beyond = tcp_raw::parse_tcp_segment(&synth_tcp_response(443, 40000, seq + 1 + 1441, 0x12))
        .expect("parse");
    assert!(!v6_flow().matches_response(&beyond, seq, 1500));
}

#[test]
fn intermediate_dest_unreachable_stops_size_with_reason() {
    let flow = v4_flow();
    let seq = traceroute_tcp::derive_sequence(0x2000_0000, 5, 0);
    // Host-unreachable (type 3, code 1) from an intermediate router, quoting the
    // 64-byte probe.
    let msg = v4_quote(3, 1, 0, seq, 64);
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

    traceroute_tcp::apply_icmp(&msg, from, &flow, 5, &mut pending, &mut states);

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
    let flow = v4_flow();
    let seq = traceroute_tcp::derive_sequence(0x2100_0000, 3, 0);
    let msg = v4_quote(11, 0, 0, seq, 64); // Time Exceeded
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

    traceroute_tcp::apply_icmp(&msg, from, &flow, 3, &mut pending, &mut states);

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
    let flow = v4_flow();
    let seq = traceroute_tcp::derive_sequence(0x3300_0000, 4, 1);
    let msg = v4_quote(3, 4, 1400, seq, 1500);
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

    traceroute_tcp::apply_icmp(&msg, from, &flow, 4, &mut pending, &mut states);

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
fn ipv6_packet_too_big_stops_the_large_size_with_its_mtu() {
    let flow = v6_flow();
    let seq = traceroute_tcp::derive_sequence(0x4400_0000, 6, 1);
    let msg = v6_quote(2, 0, 1480, 6, seq, 1500);
    let from = IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 9, 0, 0, 0, 0, 1));
    let mut pending = vec![traceroute_tcp::Pending {
        size_index: 1,
        seq,
        packet_size: 1500,
        sent_at: std::time::Instant::now(),
    }];
    let mut states = [
        traceroute_tcp::SizeState::new(60),
        traceroute_tcp::SizeState::new(1500),
    ];

    traceroute_tcp::apply_icmp(&msg, from, &flow, 6, &mut pending, &mut states);

    assert!(pending.is_empty());
    assert!(states[1].stopped);
    assert_eq!(states[1].error_code, Some("packet_too_large"));
    assert_eq!(states[1].path_mtu, Some(1480));
    assert_eq!(states[1].frag_hop_ttl, Some(6));
    assert!(states[0].hops.is_empty());
}

#[test]
fn ipv6_admin_prohibited_hop_stops_with_reason() {
    let flow = v6_flow();
    let seq = traceroute_tcp::derive_sequence(0x4500_0000, 3, 0);
    let msg = v6_quote(1, 1, 0, 6, seq, 60);
    let from = IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 9, 0, 0, 0, 0, 2));
    let mut pending = vec![traceroute_tcp::Pending {
        size_index: 0,
        seq,
        packet_size: 60,
        sent_at: std::time::Instant::now(),
    }];
    let mut states = [
        traceroute_tcp::SizeState::new(60),
        traceroute_tcp::SizeState::new(1500),
    ];

    traceroute_tcp::apply_icmp(&msg, from, &flow, 3, &mut pending, &mut states);

    assert!(states[0].stopped);
    assert!(!states[0].reached);
    assert_eq!(states[0].error_code, Some("admin_prohibited"));
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
    let outcome =
        traceroute_tcp::probe("example.com", IpFamily::V4, 443, [64, 1400], deadline).await;
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
    for (host, family, sizes) in [
        ("127.0.0.1", IpFamily::V4, [64, 1400]),
        ("::1", IpFamily::V6, [60, 1500]),
    ] {
        let listener = std::net::TcpListener::bind((host, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);

        let outcome = traceroute_tcp::probe(host, family, port, sizes, deadline).await;
        let body = outcome.into_result_body("task".to_string(), 0);
        assert!(body.ok, "{host}: probe failed: {:?}", body.error);

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

        assert_eq!(terminal_ttls, vec![1, 1], "{host}");
    }
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
    let target_ip = IpAddr::V4(V4_TARGET);
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
        source_ip: IpAddr::V4(V4_SOURCE),
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
fn run_cbpf(prog: &[tcp_raw::FilterInsn], pkt: &[u8]) -> u32 {
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
    let target = V4_TARGET;
    let local = V4_SOURCE;
    let prog = tcp_raw::tcp_probe_filter(&v4_flow());

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
fn ipv6_tcp_probe_filter_reads_ports_from_the_tcp_header() {
    // IPv6 raw sockets hand the filter the segment without the IPv6 header.
    let prog = tcp_raw::tcp_probe_filter(&v6_flow());
    let segment = |src_port: u16, dst_port: u16| synth_tcp_response(src_port, dst_port, 1, 0x12);

    assert!(run_cbpf(&prog, &segment(443, 40000)) > 0);
    assert_eq!(run_cbpf(&prog, &segment(8443, 40000)), 0);
    assert_eq!(run_cbpf(&prog, &segment(443, 40001)), 0);
}

#[test]
fn tcp_probe_filter_jumps_stay_in_bounds() {
    for flow in [v4_flow(), v6_flow()] {
        let prog = tcp_raw::tcp_probe_filter(&flow);
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
}

fn tcp_mode(target: Value) -> anyhow::Result<TcpMode> {
    match parse_task(&base_task(ProbeTaskKind::Tcp, target))?.target {
        ProbeTarget::Tcp { mode, .. } => Ok(mode),
        other => panic!("expected tcp target, got {other:?}"),
    }
}

#[test]
fn tcp_packet_size_selects_syn_mode_within_family_bounds() {
    for packet_size in [40u16, 44, 1200, 1500] {
        assert_eq!(
            tcp_mode(serde_json::json!({"host":"example.com","port":443,"packetSize":packet_size}))
                .unwrap(),
            TcpMode::Syn {
                family: IpFamily::V4,
                packet_size,
            }
        );
    }
    for value in [
        serde_json::json!(39),
        serde_json::json!(1501),
        serde_json::json!(0),
        serde_json::json!(1200.5),
        serde_json::json!("40"),
        Value::Null,
    ] {
        assert!(
            tcp_mode(serde_json::json!({"host":"example.com","port":443,"packetSize":value}))
                .is_err()
        );
    }

    // IPv6 needs at least 60 bytes for a bare SYN.
    assert!(tcp_mode(serde_json::json!({"host":"::1","port":443,"packetSize":40})).is_err());
    assert_eq!(
        tcp_mode(serde_json::json!({"host":"::1","port":443,"packetSize":60})).unwrap(),
        TcpMode::Syn {
            family: IpFamily::V6,
            packet_size: 60,
        }
    );
    assert_eq!(
        tcp_mode(serde_json::json!({
            "host": "example.com",
            "family": "ipv6",
            "port": 443,
            "packetSize": 1400,
        }))
        .unwrap(),
        TcpMode::Syn {
            family: IpFamily::V6,
            packet_size: 1400,
        }
    );
}

#[test]
fn tcp_connect_mode_takes_the_family_policy() {
    assert_eq!(
        tcp_mode(serde_json::json!({"host":"example.com","port":443})).unwrap(),
        TcpMode::Connect {
            family: FamilyPolicy::Auto,
        }
    );
    assert_eq!(
        tcp_mode(serde_json::json!({"host":"::1","port":443})).unwrap(),
        TcpMode::Connect {
            family: FamilyPolicy::Only(IpFamily::V6),
        }
    );
    assert_eq!(
        tcp_mode(serde_json::json!({"host":"example.com","family":"ipv6","port":443})).unwrap(),
        TcpMode::Connect {
            family: FamilyPolicy::Only(IpFamily::V6),
        }
    );
    assert!(tcp_mode(serde_json::json!({"host":"192.0.2.1","family":"ipv6","port":443})).is_err());
}

#[tokio::test]
async fn tcp_resolver_honors_the_family_policy() {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    assert!(
        resolve_tcp_addrs("::1", 443, FamilyPolicy::Auto, deadline)
            .await
            .is_ok()
    );
    let err = resolve_tcp_addrs("::1", 443, FamilyPolicy::Only(IpFamily::V4), deadline)
        .await
        .unwrap_err();
    assert_eq!(err.code, "dns_no_ipv4");
}

#[tokio::test]
#[cfg(not(target_os = "linux"))]
async fn tcp_packet_size_does_not_fall_back_on_unsupported_platforms() {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    for family in [IpFamily::V4, IpFamily::V6] {
        let mode = TcpMode::Syn {
            family,
            packet_size: 1400,
        };
        let result = super::tcp::probe("example.com", 443, mode, deadline)
            .await
            .into_result_body("test".into(), 0);
        assert_eq!(result.error.as_deref(), Some("unsupported_platform"));
        assert_eq!(result.extra.unwrap()["family"], family.label());
    }
}

#[tokio::test]
async fn ordinary_tcp_still_connects_to_local_listener() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    let mode = TcpMode::Connect {
        family: FamilyPolicy::Auto,
    };
    let result = super::tcp::probe("127.0.0.1", addr.port(), mode, deadline)
        .await
        .into_result_body("test".into(), 0);
    assert!(result.ok);
    assert_eq!(
        result.extra,
        Some(serde_json::json!({
            "kind": "tcp",
            "family": "ipv4",
            "addr": addr.to_string(),
        }))
    );
}

#[tokio::test]
async fn ordinary_tcp_reports_the_ipv6_address_it_used() {
    // Skip where the host has no IPv6 loopback.
    let Ok(listener) = tokio::net::TcpListener::bind("[::1]:0").await else {
        return;
    };
    let addr = listener.local_addr().unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    let mode = TcpMode::Connect {
        family: FamilyPolicy::Only(IpFamily::V6),
    };
    let result = super::tcp::probe("::1", addr.port(), mode, deadline)
        .await
        .into_result_body("test".into(), 0);
    assert!(result.ok, "connect failed: {:?}", result.error);
    let extra = result.extra.unwrap();
    assert_eq!(extra["family"], "ipv6");
    assert_eq!(extra["addr"], addr.to_string());
}

// Run with:
// cargo test -p hina-agent linux_wire -- --ignored
#[tokio::test]
#[cfg(target_os = "linux")]
#[ignore = "requires Linux and CAP_NET_RAW or root"]
async fn tcp_packet_size_linux_wire_and_endpoint_smoke() {
    use super::raw_socket::{async_recv_from, transport_payload};
    use socket2::Protocol;

    for (host, family, sizes) in [
        ("127.0.0.1", IpFamily::V4, [40u16, 1200]),
        ("::1", IpFamily::V6, [60u16, 1400]),
    ] {
        let listener = tokio::net::TcpListener::bind((host, 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        // Observe the kernel-produced packets, independently of the SYN builder.
        let tap = tokio::io::unix::AsyncFd::new(
            tcp_raw::create_raw_socket(family, Protocol::TCP).unwrap(),
        )
        .unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let syn = |packet_size| TcpMode::Syn {
            family,
            packet_size,
        };
        let (small, large) = tokio::join!(
            super::tcp::probe(host, addr.port(), syn(sizes[0]), deadline),
            super::tcp::probe(host, addr.port(), syn(sizes[1]), deadline),
        );
        for (outcome, size) in [(small, sizes[0]), (large, sizes[1])] {
            let result = outcome.into_result_body("test".into(), 0);
            assert!(
                result.ok,
                "{host}: SYN must reach an open port: {:?}",
                result.error
            );
            assert_eq!(result.loss_pct, Some(0.0), "{host}");
            let extra = result.extra.unwrap();
            assert_eq!(extra["packet_size_bytes"], size);
            assert_eq!(extra["family"], family.label());
            assert_eq!(extra["addr"], addr.to_string());
            assert!(extra["sent"].as_u64().unwrap() >= 1);
            assert_eq!(extra["sent"], extra["received"]);
        }

        // Every SYN seen on the wire is exactly one of the configured sizes with a valid checksum.
        let checker = ProbeFlow::new(addr.ip(), addr.ip(), 0, 0).unwrap();
        let header_len = usize::from(family.ip_header_len());
        let mut seen = std::collections::HashSet::new();
        let mut source_ports = std::collections::HashSet::new();
        let mut buf = [0u8; 2048];
        while seen.len() < 2 {
            let (len, _) = tokio::time::timeout_at(deadline, async_recv_from(&tap, &mut buf))
                .await
                .unwrap()
                .unwrap();
            let segment = transport_payload(family, &buf[..len]);
            if segment.len() < 20
                || u16::from_be_bytes([segment[2], segment[3]]) != addr.port()
                || segment[13] != 0x02
            {
                continue;
            }
            let packet_size = segment.len() + header_len;
            assert!(
                sizes.contains(&(packet_size as u16)),
                "{host}: {packet_size}"
            );
            if family == IpFamily::V4 {
                assert_eq!(u16::from_be_bytes([buf[2], buf[3]]) as usize, packet_size);
                assert_eq!(u16::from_be_bytes([buf[6], buf[7]]) & 0x4000, 0x4000);
            }
            assert_eq!(checker.checksum(segment), 0, "{host}");
            seen.insert(packet_size);
            source_ports.insert(u16::from_be_bytes([segment[0], segment[1]]));
        }
        assert!(
            source_ports.len() >= 2,
            "{host}: every SYN reserves its own source port"
        );

        drop(listener);
        let result = super::tcp::probe(host, addr.port(), syn(sizes[0]), deadline)
            .await
            .into_result_body("test".into(), 0);
        assert_eq!(
            result.error.as_deref(),
            Some("connection_refused"),
            "{host}"
        );
        let extra = result.extra.unwrap();
        assert_eq!(extra["packet_size_bytes"], sizes[0]);
        assert_eq!(extra["last_error"]["kind"], "connection_refused");
        assert!(extra.get("probe_style").is_none());
    }
}

#[tokio::test]
async fn tcp_packet_metadata_covers_early_failures_without_overwriting_diagnostics() {
    for (host, family, deadline) in [
        ("127.0.0.1", IpFamily::V4, tokio::time::Instant::now()),
        (
            "::1",
            IpFamily::V6,
            tokio::time::Instant::now() + Duration::from_secs(1),
        ),
    ] {
        let mode = TcpMode::Syn {
            family,
            packet_size: 1200,
        };
        let result = super::tcp::probe(host, 443, mode, deadline)
            .await
            .into_result_body("test".into(), 0);
        assert!(!result.ok);
        let extra = result.extra.unwrap();
        assert_eq!(extra["packet_size_bytes"], 1200);
        assert_eq!(extra["kind"], "tcp");
        assert_eq!(extra["family"], family.label());
        assert!(extra.get("probe_style").is_none());
        if cfg!(target_os = "linux") {
            assert_eq!(extra["host"], host);
            assert_eq!(
                extra["last_error"]["kind"].as_str(),
                result.error.as_deref()
            );
        } else {
            assert_eq!(result.error.as_deref(), Some("unsupported_platform"));
        }
    }
}
