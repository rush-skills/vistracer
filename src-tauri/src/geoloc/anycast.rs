//! Anycast signals.
//!
//! No registry provider (Team Cymru, RDAP, RIPEstat, PeeringDB) flags
//! anycast, so two bundled lists stand in:
//!
//! - Prefixes that their operators document as anycast: public DNS
//!   resolvers and the DNS root servers (root-servers.org). An address in
//!   one of them is anycast whatever the RTT says.
//! - Origin ASNs (from Team Cymru, RIPEstat or GeoLite2) of operators that
//!   announce their address space from many sites. Such an address counts
//!   as anycast only when the RTT also rules out its GeoLite2 location,
//!   because these networks also have unicast router addresses.

use super::prefix::{IpPrefix, PrefixTable};
use std::net::IpAddr;
use std::sync::LazyLock;

const KNOWN_PREFIXES: &[(&str, &str)] = &[
    ("1.1.1.0/24", "Cloudflare DNS"),
    ("1.0.0.0/24", "Cloudflare DNS"),
    ("2606:4700:4700::/48", "Cloudflare DNS"),
    ("8.8.8.0/24", "Google Public DNS"),
    ("8.8.4.0/24", "Google Public DNS"),
    ("2001:4860:4860::/48", "Google Public DNS"),
    ("9.9.9.0/24", "Quad9 DNS"),
    ("149.112.112.0/24", "Quad9 DNS"),
    ("2620:fe::/48", "Quad9 DNS"),
    ("208.67.222.0/24", "OpenDNS"),
    ("208.67.220.0/24", "OpenDNS"),
    ("2620:119:35::/48", "OpenDNS"),
    ("2620:119:53::/48", "OpenDNS"),
    ("198.41.0.0/24", "A root server"),
    ("2001:503:ba3e::/48", "A root server"),
    ("170.247.170.0/24", "B root server"),
    ("2801:1b8:10::/48", "B root server"),
    ("192.33.4.0/24", "C root server"),
    ("2001:500:2::/48", "C root server"),
    ("199.7.91.0/24", "D root server"),
    ("2001:500:2d::/48", "D root server"),
    ("192.203.230.0/24", "E root server"),
    ("2001:500:a8::/48", "E root server"),
    ("192.5.5.0/24", "F root server"),
    ("2001:500:2f::/48", "F root server"),
    ("192.112.36.0/24", "G root server"),
    ("2001:500:12::/48", "G root server"),
    ("198.97.190.0/24", "H root server"),
    ("2001:500:1::/48", "H root server"),
    ("192.36.148.0/24", "I root server"),
    ("2001:7fe::/33", "I root server"),
    ("192.58.128.0/24", "J root server"),
    ("2001:503:c27::/48", "J root server"),
    ("193.0.14.0/24", "K root server"),
    ("2001:7fd::/32", "K root server"),
    ("199.7.83.0/24", "L root server"),
    ("2001:500:9f::/48", "L root server"),
    ("202.12.27.0/24", "M root server"),
    ("2001:dc3::/32", "M root server"),
];

const OPERATOR_ASNS: &[(u32, &str)] = &[
    (13335, "Cloudflare"),
    (209242, "Cloudflare"),
    (54113, "Fastly"),
    (19281, "Quad9"),
    (36692, "OpenDNS"),
    (42, "Packet Clearing House"),
];

static KNOWN: LazyLock<PrefixTable<&'static str>> = LazyLock::new(|| {
    PrefixTable::new(
        KNOWN_PREFIXES
            .iter()
            .filter_map(|(prefix, service)| Some((IpPrefix::parse(prefix)?, *service)))
            .collect(),
    )
});

/// The service name when `ip` is in a documented anycast prefix.
pub fn known_service(ip: IpAddr) -> Option<&'static str> {
    KNOWN.lookup(ip).map(|(_, service)| *service)
}

/// The operator name when `asn` announces its space from many sites.
pub fn anycast_operator(asn: u32) -> Option<&'static str> {
    OPERATOR_ASNS
        .iter()
        .find(|(candidate, _)| *candidate == asn)
        .map(|(_, name)| *name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_bundled_prefix_parses() {
        assert_eq!(KNOWN.len(), KNOWN_PREFIXES.len());
    }

    #[test]
    fn known_services_match_v4_and_v6() {
        let ip = |s: &str| s.parse::<IpAddr>().unwrap();
        assert_eq!(known_service(ip("8.8.8.8")), Some("Google Public DNS"));
        assert_eq!(known_service(ip("1.1.1.1")), Some("Cloudflare DNS"));
        assert_eq!(
            known_service(ip("2620:fe::fe")),
            Some("Quad9 DNS"),
            "Quad9 IPv6"
        );
        assert_eq!(known_service(ip("193.0.14.129")), Some("K root server"));
        assert_eq!(known_service(ip("2001:7fd::1")), Some("K root server"));
        assert_eq!(known_service(ip("::ffff:9.9.9.9")), Some("Quad9 DNS"));
        // Google router addresses next to 8.8.8.8 are unicast.
        assert_eq!(known_service(ip("142.250.169.206")), None);
        assert_eq!(known_service(ip("8.8.9.1")), None);
    }

    #[test]
    fn operator_asns() {
        assert_eq!(anycast_operator(13335), Some("Cloudflare"));
        assert_eq!(anycast_operator(15169), None, "Google is mostly unicast");
    }
}
