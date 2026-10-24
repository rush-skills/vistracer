use std::net::IpAddr;

/// Check if an IPv4 address is in a private range (RFC1918 + loopback).
pub fn is_private_ipv4(ip: &str) -> bool {
    let parts: Vec<u8> = ip.split('.').filter_map(|s| s.parse().ok()).collect();
    if parts.len() != 4 {
        return false;
    }

    let (a, b) = (parts[0], parts[1]);

    // 10.0.0.0/8
    if a == 10 {
        return true;
    }
    // 172.16.0.0/12
    if a == 172 && (16..=31).contains(&b) {
        return true;
    }
    // 192.168.0.0/16
    if a == 192 && b == 168 {
        return true;
    }
    // 127.0.0.0/8
    if a == 127 {
        return true;
    }

    false
}

/// Check if an address is IPv6 (contains a colon).
pub fn is_ipv6(address: &str) -> bool {
    address.contains(':')
}

/// Check if an IPv6 address is private (link-local, ULA, or loopback).
pub fn is_private_ipv6(ip: &str) -> bool {
    let normalized = ip.to_lowercase();

    // Loopback ::1
    if normalized == "::1" {
        return true;
    }
    // Link-local fe80::/10
    if normalized.starts_with("fe80") {
        return true;
    }
    // Unique local fc00::/7
    if normalized.starts_with("fc") || normalized.starts_with("fd") {
        return true;
    }

    false
}

/// Check if an IP address (v4 or v6) is private.
pub fn is_private_ip(ip: &str) -> bool {
    if is_ipv6(ip) {
        is_private_ipv6(ip)
    } else {
        is_private_ipv4(ip)
    }
}

/// True when an address can appear in public routing tables. External
/// registries have no data for other addresses, so the enrichment
/// pipeline does not send them out.
pub fn is_publicly_routable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            let this_network = a == 0;
            let shared_cgnat = a == 100 && (64..=127).contains(&b);
            let ietf_assignments = a == 192 && b == 0 && c == 0;
            // 198.18.0.0/15 is the benchmarking range; VPN and proxy apps use
            // it for "fake IP" DNS answers.
            let benchmarking = a == 198 && (b == 18 || b == 19);
            let reserved = a >= 240;
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_documentation()
                || v4.is_multicast()
                || this_network
                || shared_cgnat
                || ietf_assignments
                || benchmarking
                || reserved)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_publicly_routable(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            let unique_local = (first & 0xfe00) == 0xfc00;
            let link_local = (first & 0xffc0) == 0xfe80;
            let site_local = (first & 0xffc0) == 0xfec0;
            let documentation = first == 0x2001 && v6.segments()[1] == 0x0db8;
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || unique_local
                || link_local
                || site_local
                || documentation)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_publicly_routable() {
        let routable = |s: &str| is_publicly_routable(s.parse().unwrap());
        assert!(routable("8.8.8.8"));
        assert!(routable("2001:4860:4860::8888"));
        assert!(!routable("10.1.2.3"));
        assert!(!routable("100.64.0.1"));
        assert!(!routable("100.127.255.254"));
        assert!(routable("100.128.0.1"));
        assert!(!routable("169.254.10.1"));
        assert!(!routable("192.0.2.1"));
        assert!(!routable("fe80::1"));
        assert!(!routable("fd12::1"));
        assert!(!routable("2001:db8::1"));
        assert!(!routable("::1"));
        assert!(!routable("0.1.2.3"));
        assert!(!routable("192.0.0.9"));
        assert!(!routable("198.18.0.1"));
        assert!(!routable("198.19.255.1"));
        assert!(routable("198.20.0.1"));
        assert!(!routable("240.0.0.1"));
        assert!(!routable("255.255.255.255"));
        assert!(!routable("::ffff:10.0.0.1"));
        assert!(routable("::ffff:8.8.8.8"));
        assert!(!routable("fec0::1"));
    }

    #[test]
    fn test_private_ipv4() {
        assert!(is_private_ipv4("10.0.0.1"));
        assert!(is_private_ipv4("172.16.0.1"));
        assert!(is_private_ipv4("192.168.1.1"));
        assert!(is_private_ipv4("127.0.0.1"));
        assert!(!is_private_ipv4("8.8.8.8"));
        assert!(!is_private_ipv4("1.1.1.1"));
    }

    #[test]
    fn test_ipv6() {
        assert!(is_ipv6("::1"));
        assert!(is_ipv6("2001:db8::1"));
        assert!(!is_ipv6("8.8.8.8"));
    }

    #[test]
    fn test_private_ipv6() {
        assert!(is_private_ipv6("::1"));
        assert!(is_private_ipv6("fe80::1"));
        assert!(is_private_ipv6("fd00::1"));
        assert!(!is_private_ipv6("2001:db8::1"));
    }

    #[test]
    fn test_private_ip() {
        assert!(is_private_ip("10.0.0.1"));
        assert!(is_private_ip("::1"));
        assert!(!is_private_ip("8.8.8.8"));
        assert!(!is_private_ip("2001:db8::1"));
    }
}
