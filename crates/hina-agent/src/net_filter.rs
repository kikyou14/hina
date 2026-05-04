const VIRTUAL_INTERFACE_PREFIXES: &[&str] = &[
    "br", "cni", "docker", "flannel", "podman", "veth", "virbr", "vmbr",
];

pub fn is_loopback_interface(name: &str) -> bool {
    name == "lo" || name == "lo0"
}

pub fn is_virtual_interface(name: &str) -> bool {
    VIRTUAL_INTERFACE_PREFIXES
        .iter()
        .any(|prefix| name.starts_with(prefix))
}

pub fn should_exclude_interface(name: &str) -> bool {
    is_loopback_interface(name) || is_virtual_interface(name)
}

#[cfg(test)]
mod tests {
    use super::{is_loopback_interface, is_virtual_interface, should_exclude_interface};

    #[test]
    fn loopback_matches_exact_names_only() {
        assert!(is_loopback_interface("lo"));
        assert!(is_loopback_interface("lo0"));

        // Names starting with "lo" that are not loopback must not be matched.
        assert!(!is_loopback_interface("loongarch0"));
        assert!(!is_loopback_interface("local0"));
        assert!(!is_loopback_interface("lo1"));
    }

    #[test]
    fn virtual_prefixes_match_common_synthetic_interfaces() {
        for name in [
            "br0",
            "br-13c934baf05b",
            "cni0",
            "docker0",
            "flannel.1",
            "podman1",
            "veth1234",
            "virbr0",
            "vmbr0",
        ] {
            assert!(is_virtual_interface(name), "expected {name} to be virtual");
        }
    }

    #[test]
    fn loopback_is_not_classified_as_virtual() {
        assert!(!is_virtual_interface("lo"));
        assert!(!is_virtual_interface("lo0"));
    }

    #[test]
    fn physical_interfaces_are_not_excluded() {
        for name in [
            "eth0",
            "eth1",
            "ens3",
            "enp0s3",
            "en0",
            "en1",
            "wlan0",
            "wlp3s0",
            "bond0",
            "tun0",
            "tap0",
            "wg0",
            "loongarch0",
        ] {
            assert!(
                !should_exclude_interface(name),
                "expected {name} to be kept"
            );
        }
    }

    #[test]
    fn should_exclude_combines_loopback_and_virtual() {
        assert!(should_exclude_interface("lo"));
        assert!(should_exclude_interface("lo0"));
        assert!(should_exclude_interface("docker0"));
        assert!(should_exclude_interface("br-13c934baf05b"));
        assert!(should_exclude_interface("veth1234"));
        assert!(!should_exclude_interface("eth0"));
    }
}
