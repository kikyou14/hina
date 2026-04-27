use std::cmp::Ordering;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use serde::Deserialize;
use sysinfo::Networks;

const EXCLUDED_INTERFACE_PREFIXES: &[&str] = &[
    "br", "cni", "docker", "podman", "flannel", "lo", "veth", "virbr", "vmbr",
];
const PUBLIC_IP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ResolvedIps {
    pub v4: Option<String>,
    pub v6: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InterfaceAddresses {
    name: String,
    ips: Vec<IpAddr>,
}

impl ResolvedIps {
    fn has_any(&self) -> bool {
        self.v4.is_some() || self.v6.is_some()
    }
}

pub async fn resolve_ips(interface: Option<&str>) -> ResolvedIps {
    let interfaces = collect_interfaces();

    if let Some(name) = interface
        && let Some(resolved) = resolve_from_interface(&interfaces, name)
    {
        return resolved;
    }

    let public_ips = resolve_public_ips().await;
    select_resolved_ips(None, &interfaces, public_ips)
}

fn collect_interfaces() -> Vec<InterfaceAddresses> {
    let networks = Networks::new_with_refreshed_list();
    let mut interfaces = networks
        .iter()
        .map(|(name, data)| {
            let mut ips = data
                .ip_networks()
                .iter()
                .map(|network| network.addr)
                .collect::<Vec<_>>();
            sort_interface_ips(&mut ips);

            InterfaceAddresses {
                name: name.clone(),
                ips,
            }
        })
        .collect::<Vec<_>>();
    interfaces.sort_by(|left, right| left.name.cmp(&right.name));
    interfaces
}

fn select_resolved_ips(
    interface: Option<&str>,
    interfaces: &[InterfaceAddresses],
    public_ips: Option<ResolvedIps>,
) -> ResolvedIps {
    if let Some(name) = interface
        && let Some(resolved) = resolve_from_interface(interfaces, name)
    {
        return resolved;
    }

    let mut resolved = public_ips.unwrap_or_default();

    // Fill missing families from local interfaces.
    if (resolved.v4.is_none() || resolved.v6.is_none())
        && let Some(local) = resolve_from_local_interfaces(interfaces)
    {
        if resolved.v4.is_none() {
            resolved.v4 = local.v4;
        }
        if resolved.v6.is_none() {
            resolved.v6 = local.v6;
        }
    }

    resolved
}

fn is_excluded_interface_name(name: &str) -> bool {
    EXCLUDED_INTERFACE_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

fn sort_interface_ips(ips: &mut [IpAddr]) {
    ips.sort_by(compare_ip_addrs);
}

fn compare_ip_addrs(left: &IpAddr, right: &IpAddr) -> Ordering {
    ip_sort_priority(left)
        .cmp(&ip_sort_priority(right))
        .then_with(|| ip_family_order(left).cmp(&ip_family_order(right)))
        .then_with(|| match (left, right) {
            (IpAddr::V4(left), IpAddr::V4(right)) => left.octets().cmp(&right.octets()),
            (IpAddr::V6(left), IpAddr::V6(right)) => left.octets().cmp(&right.octets()),
            _ => Ordering::Equal,
        })
}

fn ip_sort_priority(ip: &IpAddr) -> u8 {
    if !is_usable_ip(ip) {
        2
    } else if is_link_local_ip(ip) {
        1
    } else {
        0
    }
}

fn ip_family_order(ip: &IpAddr) -> u8 {
    match ip {
        IpAddr::V4(_) => 0,
        IpAddr::V6(_) => 1,
    }
}

fn resolve_from_interface(interfaces: &[InterfaceAddresses], name: &str) -> Option<ResolvedIps> {
    if is_excluded_interface_name(name) {
        tracing::warn!(
            interface = name,
            "configured interface is excluded by prefix, falling back to other IP sources"
        );
        return None;
    }

    let Some(interface) = interfaces.iter().find(|interface| interface.name == name) else {
        tracing::warn!(
            interface = name,
            "configured interface not found, falling back to other IP sources"
        );
        return None;
    };

    let resolved = resolve_from_ip_addrs(&interface.ips);
    if resolved.has_any() {
        Some(resolved)
    } else {
        tracing::warn!(
            interface = name,
            "configured interface has no usable IP addresses, falling back to other IP sources"
        );
        None
    }
}

fn resolve_from_local_interfaces(interfaces: &[InterfaceAddresses]) -> Option<ResolvedIps> {
    let mut resolved = ResolvedIps::default();
    let mut sorted = interfaces.iter().collect::<Vec<_>>();
    sorted.sort_by(|left, right| left.name.cmp(&right.name));

    for interface in &sorted {
        if is_excluded_interface_name(&interface.name) {
            continue;
        }

        for ip in &interface.ips {
            if !is_usable_ip(ip) || is_link_local_ip(ip) {
                continue;
            }

            match ip {
                IpAddr::V4(addr) if resolved.v4.is_none() => {
                    resolved.v4 = Some(addr.to_string());
                }
                IpAddr::V6(addr) if resolved.v6.is_none() => {
                    resolved.v6 = Some(addr.to_string());
                }
                _ => {}
            }

            if resolved.v4.is_some() && resolved.v6.is_some() {
                return Some(resolved);
            }
        }
    }

    for interface in &sorted {
        if is_excluded_interface_name(&interface.name) {
            continue;
        }

        for ip in &interface.ips {
            if !is_usable_ip(ip) || !is_link_local_ip(ip) {
                continue;
            }

            match ip {
                IpAddr::V4(addr) if resolved.v4.is_none() => {
                    resolved.v4 = Some(addr.to_string());
                }
                IpAddr::V6(addr) if resolved.v6.is_none() => {
                    resolved.v6 = Some(addr.to_string());
                }
                _ => {}
            }

            if resolved.v4.is_some() && resolved.v6.is_some() {
                return Some(resolved);
            }
        }
    }

    if resolved.has_any() {
        Some(resolved)
    } else {
        None
    }
}

fn resolve_from_ip_addrs(ips: &[IpAddr]) -> ResolvedIps {
    let mut resolved = ResolvedIps::default();
    for ip in ips {
        if !is_usable_ip(ip) {
            continue;
        }
        match ip {
            IpAddr::V4(addr) if resolved.v4.is_none() => {
                resolved.v4 = Some(addr.to_string());
            }
            IpAddr::V6(addr) if resolved.v6.is_none() => {
                resolved.v6 = Some(addr.to_string());
            }
            _ => {}
        }
        if resolved.v4.is_some() && resolved.v6.is_some() {
            break;
        }
    }
    resolved
}

fn is_usable_ip(ip: &IpAddr) -> bool {
    !ip.is_loopback() && !ip.is_unspecified()
}

fn is_link_local_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(addr) => addr.is_link_local(),
        IpAddr::V6(addr) => addr.is_unicast_link_local(),
    }
}

#[derive(Debug, Clone, Copy)]
enum ResponseFormat {
    Json,
    PlainText,
}

struct IpProvider {
    name: &'static str,
    url: &'static str,
    format: ResponseFormat,
}

const V4_PROVIDERS: &[IpProvider] = &[
    IpProvider {
        name: "ipify",
        url: "https://api.ipify.org?format=json",
        format: ResponseFormat::Json,
    },
    IpProvider {
        name: "ip.sb",
        url: "https://api-ipv4.ip.sb/ip",
        format: ResponseFormat::PlainText,
    },
    IpProvider {
        name: "icanhazip",
        url: "https://ipv4.icanhazip.com",
        format: ResponseFormat::PlainText,
    },
];

const V6_PROVIDERS: &[IpProvider] = &[
    IpProvider {
        name: "ipify",
        url: "https://api6.ipify.org?format=json",
        format: ResponseFormat::Json,
    },
    IpProvider {
        name: "ip.sb",
        url: "https://api-ipv6.ip.sb/ip",
        format: ResponseFormat::PlainText,
    },
    IpProvider {
        name: "icanhazip",
        url: "https://ipv6.icanhazip.com",
        format: ResponseFormat::PlainText,
    },
    IpProvider {
        name: "ident.me",
        url: "https://v6.ident.me",
        format: ResponseFormat::PlainText,
    },
];

#[derive(Deserialize)]
struct JsonIpResponse {
    ip: String,
}

fn parse_ip_response(body: &str, format: ResponseFormat) -> Result<String, String> {
    let ip_str = match format {
        ResponseFormat::Json => serde_json::from_str::<JsonIpResponse>(body)
            .map(|r| r.ip)
            .map_err(|e| format!("invalid JSON: {e}"))?,
        ResponseFormat::PlainText => body.trim().to_string(),
    };

    ip_str
        .parse::<IpAddr>()
        .map_err(|e| format!("invalid IP '{ip_str}': {e}"))?;

    Ok(ip_str)
}

async fn resolve_public_ips() -> Option<ResolvedIps> {
    let resolved = fetch_public_ips().await;
    resolved.has_any().then_some(resolved)
}

async fn fetch_public_ips() -> ResolvedIps {
    let (v4, v6) = tokio::join!(
        fetch_public_ip_family(IpAddr::V4(Ipv4Addr::UNSPECIFIED), V4_PROVIDERS),
        fetch_public_ip_family(IpAddr::V6(Ipv6Addr::UNSPECIFIED), V6_PROVIDERS),
    );
    ResolvedIps { v4, v6 }
}

async fn fetch_public_ip_family(local_addr: IpAddr, providers: &[IpProvider]) -> Option<String> {
    let client = reqwest::Client::builder()
        .local_address(local_addr)
        .timeout(PUBLIC_IP_TIMEOUT)
        .build()
        .ok()?;
    race_resolve_ip(&client, providers).await
}

async fn race_resolve_ip(client: &reqwest::Client, providers: &[IpProvider]) -> Option<String> {
    let mut futures: FuturesUnordered<_> = providers
        .iter()
        .map(|p| try_fetch_provider(client, p))
        .collect();

    let mut errors = Vec::new();
    while let Some((name, result)) = futures.next().await {
        match result {
            Ok(ip) => {
                tracing::debug!(provider = name, %ip, "public IP resolved");
                return Some(ip);
            }
            Err(err) => {
                errors.push((name, err));
            }
        }
    }

    for (name, err) in &errors {
        tracing::warn!(provider = name, error = %err, "public IP provider failed");
    }
    None
}

async fn try_fetch_provider(
    client: &reqwest::Client,
    provider: &IpProvider,
) -> (&'static str, Result<String, String>) {
    let result = async {
        let resp = client
            .get(provider.url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|e| e.to_string())?;

        let body = resp.text().await.map_err(|e| e.to_string())?;
        parse_ip_response(&body, provider.format)
    }
    .await;

    (provider.name, result)
}

#[cfg(test)]
mod tests {
    use std::net::IpAddr;

    use super::{
        InterfaceAddresses, ResolvedIps, ResponseFormat, is_excluded_interface_name,
        parse_ip_response, resolve_from_ip_addrs, select_resolved_ips, sort_interface_ips,
    };

    fn iface(name: &str, ips: &[&str]) -> InterfaceAddresses {
        InterfaceAddresses {
            name: name.to_string(),
            ips: ips.iter().map(|ip| ip.parse().expect("valid IP")).collect(),
        }
    }

    fn resolved_ips(v4: Option<&str>, v6: Option<&str>) -> ResolvedIps {
        ResolvedIps {
            v4: v4.map(str::to_string),
            v6: v6.map(str::to_string),
        }
    }

    fn sort_ips(ips: &[&str]) -> Vec<IpAddr> {
        let mut ips = ips
            .iter()
            .map(|ip| ip.parse().expect("valid IP"))
            .collect::<Vec<_>>();
        sort_interface_ips(&mut ips);
        ips
    }

    fn ip_strings(ips: &[IpAddr]) -> Vec<String> {
        ips.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn excludes_expected_interface_prefixes() {
        for name in [
            "br0",
            "cni0",
            "docker0",
            "podman1",
            "flannel.1",
            "lo",
            "lo0",
            "veth123",
            "virbr0",
            "vmbr0",
        ] {
            assert!(is_excluded_interface_name(name), "{name}");
        }
        assert!(!is_excluded_interface_name("eth0"));
    }

    #[test]
    fn sort_interface_ips_prefers_non_link_local_ipv4() {
        let sorted = sort_ips(&["169.254.10.20", "192.0.2.10"]);
        let reversed = sort_ips(&["192.0.2.10", "169.254.10.20"]);

        assert_eq!(sorted, reversed);
        assert_eq!(ip_strings(&sorted), vec!["192.0.2.10", "169.254.10.20"]);
    }

    #[test]
    fn sort_interface_ips_prefers_non_link_local_ipv6() {
        let sorted = sort_ips(&["fe80::20", "2001:db8::10"]);
        let reversed = sort_ips(&["2001:db8::10", "fe80::20"]);

        assert_eq!(sorted, reversed);
        assert_eq!(ip_strings(&sorted), vec!["2001:db8::10", "fe80::20"]);
    }

    #[test]
    fn sort_interface_ips_is_deterministic_within_same_priority() {
        let sorted = sort_ips(&["2001:db8::2", "192.0.2.20", "2001:db8::1", "192.0.2.10"]);

        assert_eq!(
            ip_strings(&sorted),
            vec!["192.0.2.10", "192.0.2.20", "2001:db8::1", "2001:db8::2"]
        );
    }

    #[test]
    fn configured_interface_exact_match_returns_dual_stack() {
        let interfaces = vec![iface("eth0", &["192.0.2.10", "2001:db8::10"])];

        let actual = select_resolved_ips(Some("eth0"), &interfaces, None);

        assert_eq!(
            actual,
            resolved_ips(Some("192.0.2.10"), Some("2001:db8::10"))
        );
    }

    #[test]
    fn resolve_from_ip_addrs_uses_sorted_preferred_addresses_per_family() {
        let ips = sort_ips(&["169.254.10.20", "2001:db8::10", "192.0.2.10", "fe80::20"]);

        let actual = resolve_from_ip_addrs(&ips);

        assert_eq!(
            actual,
            resolved_ips(Some("192.0.2.10"), Some("2001:db8::10"))
        );
    }

    #[test]
    fn configured_excluded_interface_falls_back_to_local_interfaces() {
        let interfaces = vec![
            iface("docker0", &["172.17.0.1"]),
            iface("eth0", &["192.0.2.20"]),
        ];

        let actual = select_resolved_ips(Some("docker0"), &interfaces, None);

        assert_eq!(actual, resolved_ips(Some("192.0.2.20"), None));
    }

    #[test]
    fn api_candidate_short_circuits_local_candidate() {
        let interfaces = vec![iface("eth0", &["192.0.2.30", "2001:db8::30"])];
        let public = resolved_ips(Some("198.51.100.30"), Some("2001:db8::300"));

        let actual = select_resolved_ips(None, &interfaces, Some(public.clone()));

        assert_eq!(actual, public);
    }

    #[test]
    fn api_failure_uses_local_candidate() {
        let interfaces = vec![iface("eth0", &["192.0.2.40", "2001:db8::40"])];

        let actual = select_resolved_ips(None, &interfaces, None);

        assert_eq!(
            actual,
            resolved_ips(Some("192.0.2.40"), Some("2001:db8::40"))
        );
    }

    #[test]
    fn fills_missing_v4_from_local_when_public_has_only_v6() {
        let interfaces = vec![iface("eth0", &["192.0.2.50"])];
        let public = resolved_ips(None, Some("2001:db8::500"));

        let actual = select_resolved_ips(None, &interfaces, Some(public));

        assert_eq!(
            actual,
            resolved_ips(Some("192.0.2.50"), Some("2001:db8::500"))
        );
    }

    #[test]
    fn fills_missing_v6_from_local_when_public_has_only_v4() {
        let interfaces = vec![iface("eth0", &["192.0.2.50", "2001:db8::50"])];
        let public = resolved_ips(Some("198.51.100.50"), None);

        let actual = select_resolved_ips(None, &interfaces, Some(public));

        assert_eq!(
            actual,
            resolved_ips(Some("198.51.100.50"), Some("2001:db8::50"))
        );
    }

    #[test]
    fn local_candidate_is_deterministic_by_interface_name() {
        let interfaces = vec![
            iface("z0", &["2001:db8::60"]),
            iface("eth0", &["192.0.2.60"]),
            iface("eth1", &["198.51.100.60", "2001:db8::61"]),
        ];

        let actual = select_resolved_ips(None, &interfaces, None);

        assert_eq!(
            actual,
            resolved_ips(Some("192.0.2.60"), Some("2001:db8::61"))
        );
    }

    #[test]
    fn local_candidate_prefers_non_link_local_addresses_across_interfaces() {
        let interfaces = vec![
            iface("awdl0", &["fe80::20"]),
            iface("en0", &["2001:db8::10"]),
            iface("eth0", &["169.254.10.20"]),
            iface("eth1", &["192.0.2.10"]),
        ];

        let actual = select_resolved_ips(None, &interfaces, None);

        assert_eq!(
            actual,
            resolved_ips(Some("192.0.2.10"), Some("2001:db8::10"))
        );
    }

    #[test]
    fn local_candidate_prefers_non_link_local_addresses_on_same_interface() {
        let interfaces = vec![InterfaceAddresses {
            name: "eth0".to_string(),
            ips: sort_ips(&["fe80::20", "2001:db8::10", "169.254.10.20", "192.0.2.10"]),
        }];

        let actual = select_resolved_ips(None, &interfaces, None);

        assert_eq!(
            actual,
            resolved_ips(Some("192.0.2.10"), Some("2001:db8::10"))
        );
    }

    #[test]
    fn returns_empty_when_no_source_provides_ips() {
        let interfaces = vec![
            iface("lo", &["127.0.0.1", "::1"]),
            iface("eth0", &["0.0.0.0", "::"]),
        ];

        let actual = select_resolved_ips(None, &interfaces, None);

        assert_eq!(actual, ResolvedIps::default());
    }

    #[test]
    fn configured_interface_ignores_unusable_addresses_and_falls_back() {
        let interfaces = vec![
            iface("eth9", &["127.0.0.1", "::"]),
            iface("eth0", &["192.0.2.70"]),
        ];

        let actual = select_resolved_ips(Some("eth9"), &interfaces, None);

        assert_eq!(actual, resolved_ips(Some("192.0.2.70"), None));
    }

    #[test]
    fn empty_public_result_falls_back_to_local_candidate() {
        let interfaces = vec![iface("eth0", &["192.0.2.80", "2001:db8::80"])];

        let actual = select_resolved_ips(None, &interfaces, Some(ResolvedIps::default()));

        assert_eq!(
            actual,
            resolved_ips(Some("192.0.2.80"), Some("2001:db8::80"))
        );
    }

    #[test]
    fn parse_json_ip_response() {
        assert_eq!(
            parse_ip_response(r#"{"ip":"1.2.3.4"}"#, ResponseFormat::Json),
            Ok("1.2.3.4".to_string())
        );
    }

    #[test]
    fn parse_plain_text_ip_response_trims_whitespace() {
        assert_eq!(
            parse_ip_response("1.2.3.4\n", ResponseFormat::PlainText),
            Ok("1.2.3.4".to_string())
        );
    }

    #[test]
    fn parse_plain_text_ipv6_response() {
        assert_eq!(
            parse_ip_response("2001:db8::1\n", ResponseFormat::PlainText),
            Ok("2001:db8::1".to_string())
        );
    }

    #[test]
    fn parse_rejects_invalid_ip_in_plain_text() {
        assert!(parse_ip_response("not-an-ip\n", ResponseFormat::PlainText).is_err());
    }

    #[test]
    fn parse_rejects_invalid_json() {
        assert!(parse_ip_response("not json", ResponseFormat::Json).is_err());
    }

    #[test]
    fn parse_rejects_empty_body() {
        assert!(parse_ip_response("", ResponseFormat::PlainText).is_err());
    }
}
