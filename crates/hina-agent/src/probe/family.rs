use std::{collections::HashSet, net::IpAddr};

use serde_json::Value;
use socket2::{Domain, Protocol};
use tokio::net::lookup_host;

/// IP version of a probe target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum IpFamily {
    V4,
    V6,
}

impl IpFamily {
    pub(crate) fn of(ip: IpAddr) -> Self {
        match ip {
            IpAddr::V4(_) => Self::V4,
            IpAddr::V6(_) => Self::V6,
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::V4 => "ipv4",
            Self::V6 => "ipv6",
        }
    }

    /// Fixed IP header length; probes never carry IPv4 options or IPv6 extension headers.
    pub(crate) fn ip_header_len(self) -> u16 {
        match self {
            Self::V4 => 20,
            Self::V6 => 40,
        }
    }

    pub(crate) fn domain(self) -> Domain {
        match self {
            Self::V4 => Domain::IPV4,
            Self::V6 => Domain::IPV6,
        }
    }

    pub(crate) fn icmp_protocol(self) -> Protocol {
        match self {
            Self::V4 => Protocol::ICMPV4,
            Self::V6 => Protocol::ICMPV6,
        }
    }
}

/// Which address family a probe may use for its target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FamilyPolicy {
    /// Whatever order the probe used before `family` existed.
    Auto,
    Only(IpFamily),
}

impl FamilyPolicy {
    /// Reads `target.family`. An IP literal host pins its own family, and an explicit family that
    /// contradicts it is rejected.
    pub(crate) fn parse(target: &Value, host: &str) -> anyhow::Result<Self> {
        let explicit = match target.get("family") {
            None => None,
            Some(value) => Some(match value.as_str() {
                Some("ipv4") => IpFamily::V4,
                Some("ipv6") => IpFamily::V6,
                _ => anyhow::bail!("target.family must be \"ipv4\" or \"ipv6\""),
            }),
        };
        let literal = host.parse::<IpAddr>().ok().map(IpFamily::of);
        match (explicit, literal) {
            (Some(explicit), Some(literal)) if explicit != literal => {
                anyhow::bail!("target.family does not match target.host")
            }
            (explicit, literal) => Ok(explicit.or(literal).map_or(Self::Auto, Self::Only)),
        }
    }

    /// Raw TCP probes predate `family`: without it a hostname keeps the IPv4 behavior they
    /// shipped with.
    pub(crate) fn raw_tcp_family(self) -> IpFamily {
        match self {
            Self::Only(family) => family,
            Self::Auto => IpFamily::V4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolveError {
    pub(crate) code: &'static str,
    pub(crate) detail: String,
}

impl ResolveError {
    fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

/// Addresses of `host` that `policy` allows, deduplicated, in resolver order; never empty on
/// success. An IP literal skips DNS.
pub(crate) async fn resolve(
    host: &str,
    policy: FamilyPolicy,
    deadline: tokio::time::Instant,
) -> Result<Vec<IpAddr>, ResolveError> {
    let addrs = match host.parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => lookup(host, deadline).await?,
    };
    if addrs.is_empty() {
        return Err(ResolveError::new("dns_no_records", "dns no records"));
    }

    let FamilyPolicy::Only(family) = policy else {
        return Ok(addrs);
    };
    let matching: Vec<IpAddr> = addrs
        .into_iter()
        .filter(|ip| IpFamily::of(*ip) == family)
        .collect();
    if matching.is_empty() {
        return Err(match family {
            IpFamily::V4 => ResolveError::new("dns_no_ipv4", "no IPv4 address found"),
            IpFamily::V6 => ResolveError::new("dns_no_ipv6", "no IPv6 address found"),
        });
    }
    Ok(matching)
}

/// The first address `resolve` returns.
pub(crate) async fn resolve_first(
    host: &str,
    policy: FamilyPolicy,
    deadline: tokio::time::Instant,
) -> Result<IpAddr, ResolveError> {
    let addrs = resolve(host, policy, deadline).await?;
    Ok(addrs[0])
}

async fn lookup(host: &str, deadline: tokio::time::Instant) -> Result<Vec<IpAddr>, ResolveError> {
    let addrs = tokio::time::timeout_at(deadline, lookup_host((host, 0)))
        .await
        .map_err(|_| ResolveError::new("timeout", "dns lookup timeout"))?
        .map_err(|err| ResolveError::new("dns_lookup_failed", err.to_string()))?;

    let mut seen = HashSet::new();
    Ok(addrs
        .map(|addr| addr.ip())
        .filter(|ip| seen.insert(*ip))
        .collect())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn parse(target: Value) -> anyhow::Result<FamilyPolicy> {
        let host = target["host"].as_str().unwrap().to_string();
        FamilyPolicy::parse(&target, &host)
    }

    #[test]
    fn family_is_optional_and_literals_pin_their_own() {
        assert_eq!(
            parse(serde_json::json!({ "host": "example.com" })).unwrap(),
            FamilyPolicy::Auto
        );
        assert_eq!(
            parse(serde_json::json!({ "host": "example.com", "family": "ipv6" })).unwrap(),
            FamilyPolicy::Only(IpFamily::V6)
        );
        assert_eq!(
            parse(serde_json::json!({ "host": "2001:db8::1" })).unwrap(),
            FamilyPolicy::Only(IpFamily::V6)
        );
        assert_eq!(
            parse(serde_json::json!({ "host": "192.0.2.1", "family": "ipv4" })).unwrap(),
            FamilyPolicy::Only(IpFamily::V4)
        );
    }

    #[test]
    fn family_rejects_unknown_values_and_contradicting_literals() {
        for family in [serde_json::json!("v6"), serde_json::json!(6), Value::Null] {
            assert!(parse(serde_json::json!({ "host": "example.com", "family": family })).is_err());
        }
        let err = parse(serde_json::json!({ "host": "192.0.2.1", "family": "ipv6" })).unwrap_err();
        assert!(err.to_string().contains("does not match"));
    }

    #[test]
    fn raw_tcp_modes_default_to_ipv4() {
        assert_eq!(FamilyPolicy::Auto.raw_tcp_family(), IpFamily::V4);
        assert_eq!(
            FamilyPolicy::Only(IpFamily::V6).raw_tcp_family(),
            IpFamily::V6
        );
    }

    #[tokio::test]
    async fn resolve_filters_literals_by_family() {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
        let v6: IpAddr = "2001:db8::1".parse().unwrap();

        assert_eq!(
            resolve("2001:db8::1", FamilyPolicy::Auto, deadline).await,
            Ok(vec![v6])
        );
        assert_eq!(
            resolve_first("2001:db8::1", FamilyPolicy::Only(IpFamily::V6), deadline).await,
            Ok(v6)
        );
        let err = resolve("2001:db8::1", FamilyPolicy::Only(IpFamily::V4), deadline)
            .await
            .unwrap_err();
        assert_eq!(err.code, "dns_no_ipv4");
    }
}
