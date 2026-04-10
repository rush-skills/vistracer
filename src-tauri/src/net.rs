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

#[cfg(test)]
mod tests {
    use super::*;

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
