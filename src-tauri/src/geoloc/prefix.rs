//! IP prefixes and a lookup table over sorted address ranges.
//!
//! Ranges are sorted by start address. A lookup binary-searches the last
//! range that starts at or before the address, then walks back while an
//! earlier range can still cover it (`max_end`). Disjoint prefixes, the
//! normal case for IX peering LANs, stop after one step; nested prefixes
//! still give the most specific match.

use std::fmt;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpPrefix {
    V4 { network: u32, len: u8 },
    V6 { network: u128, len: u8 },
}

impl IpPrefix {
    /// Parses `a.b.c.d/len` or `x:y::/len`. Host bits are cleared.
    pub fn parse(text: &str) -> Option<Self> {
        let (address, len) = text.trim().split_once('/')?;
        let len: u8 = len.parse().ok()?;
        match address.parse::<IpAddr>().ok()? {
            IpAddr::V4(v4) if len <= 32 => Some(Self::V4 {
                network: u32::from(v4) & mask_u32(len),
                len,
            }),
            IpAddr::V6(v6) if len <= 128 => Some(Self::V6 {
                network: u128::from(v6) & mask_u128(len),
                len,
            }),
            _ => None,
        }
    }
}

impl fmt::Display for IpPrefix {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::V4 { network, len } => write!(f, "{}/{len}", Ipv4Addr::from(*network)),
            Self::V6 { network, len } => write!(f, "{}/{len}", Ipv6Addr::from(*network)),
        }
    }
}

fn mask_u32(len: u8) -> u32 {
    u32::MAX.checked_shl(32 - u32::from(len)).unwrap_or(0)
}

fn mask_u128(len: u8) -> u128 {
    u128::MAX.checked_shl(128 - u32::from(len)).unwrap_or(0)
}

#[derive(Debug, Clone, Copy)]
struct Range<A> {
    start: A,
    end: A,
    len: u8,
    value: usize,
}

#[derive(Debug, Clone)]
struct Ranges<A> {
    ranges: Vec<Range<A>>,
    /// `max_end[i]` is the largest end address among `ranges[..=i]`.
    max_end: Vec<A>,
}

impl<A: Copy + Ord> Ranges<A> {
    fn new(mut ranges: Vec<Range<A>>) -> Self {
        ranges.sort_by_key(|r| (r.start, r.len));
        let mut max_end = Vec::with_capacity(ranges.len());
        for range in &ranges {
            let end = max_end
                .last()
                .map_or(range.end, |previous: &A| (*previous).max(range.end));
            max_end.push(end);
        }
        Self { ranges, max_end }
    }

    fn lookup(&self, address: A) -> Option<&Range<A>> {
        let upper = self.ranges.partition_point(|r| r.start <= address);
        let mut best: Option<&Range<A>> = None;
        for index in (0..upper).rev() {
            if self.max_end[index] < address {
                break;
            }
            let range = &self.ranges[index];
            if range.end >= address && best.is_none_or(|b| range.len > b.len) {
                best = Some(range);
            }
        }
        best
    }
}

/// Maps IPv4 and IPv6 prefixes to values. IPv4-mapped IPv6 addresses are
/// looked up as IPv4.
#[derive(Debug, Clone)]
pub struct PrefixTable<V> {
    v4: Ranges<u32>,
    v6: Ranges<u128>,
    entries: Vec<(IpPrefix, V)>,
}

impl<V> PrefixTable<V> {
    pub fn new(entries: Vec<(IpPrefix, V)>) -> Self {
        let mut v4 = Vec::new();
        let mut v6 = Vec::new();
        for (value, (prefix, _)) in entries.iter().enumerate() {
            match *prefix {
                IpPrefix::V4 { network, len } => v4.push(Range {
                    start: network,
                    end: network | !mask_u32(len),
                    len,
                    value,
                }),
                IpPrefix::V6 { network, len } => v6.push(Range {
                    start: network,
                    end: network | !mask_u128(len),
                    len,
                    value,
                }),
            }
        }
        Self {
            v4: Ranges::new(v4),
            v6: Ranges::new(v6),
            entries,
        }
    }

    /// The most specific prefix that contains `ip`, with its value.
    pub fn lookup(&self, ip: IpAddr) -> Option<(IpPrefix, &V)> {
        let index = match ip {
            IpAddr::V4(v4) => self.v4.lookup(u32::from(v4))?.value,
            IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
                Some(v4) => self.v4.lookup(u32::from(v4))?.value,
                None => self.v6.lookup(u128::from(v6))?.value,
            },
        };
        let (prefix, value) = &self.entries[index];
        Some((*prefix, value))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    fn table(prefixes: &[&str]) -> PrefixTable<&'static str> {
        let leaked: Vec<(IpPrefix, &'static str)> = prefixes
            .iter()
            .map(|p| {
                let name: &'static str = Box::leak(p.to_string().into_boxed_str());
                (IpPrefix::parse(p).unwrap(), name)
            })
            .collect();
        PrefixTable::new(leaked)
    }

    fn hit(table: &PrefixTable<&'static str>, addr: &str) -> Option<&'static str> {
        table.lookup(ip(addr)).map(|(_, v)| *v)
    }

    #[test]
    fn parses_and_normalises_prefixes() {
        assert_eq!(
            IpPrefix::parse("185.1.0.17/24").unwrap().to_string(),
            "185.1.0.0/24"
        );
        assert_eq!(
            IpPrefix::parse("2001:7f8::1/64").unwrap().to_string(),
            "2001:7f8::/64"
        );
        assert_eq!(
            IpPrefix::parse("0.0.0.0/0").unwrap().to_string(),
            "0.0.0.0/0"
        );
        assert_eq!(IpPrefix::parse("10.0.0.0/33"), None);
        assert_eq!(IpPrefix::parse("2001:db8::/129"), None);
        assert_eq!(IpPrefix::parse("10.0.0.0"), None);
        assert_eq!(IpPrefix::parse("not-an-ip/8"), None);
    }

    #[test]
    fn ipv4_edges_are_inclusive() {
        let t = table(&["80.81.192.0/21", "206.223.115.0/24"]);
        assert_eq!(hit(&t, "80.81.192.0"), Some("80.81.192.0/21"));
        assert_eq!(hit(&t, "80.81.199.255"), Some("80.81.192.0/21"));
        assert_eq!(hit(&t, "80.81.200.0"), None);
        assert_eq!(hit(&t, "80.81.191.255"), None);
        assert_eq!(hit(&t, "206.223.115.42"), Some("206.223.115.0/24"));
        assert_eq!(hit(&t, "8.8.8.8"), None);
    }

    #[test]
    fn ipv6_edges_are_inclusive_and_v4_mapped_uses_v4() {
        let t = table(&["2001:7f8::/64", "2001:504:0:2::/64", "80.81.192.0/21"]);
        assert_eq!(hit(&t, "2001:7f8::"), Some("2001:7f8::/64"));
        assert_eq!(
            hit(&t, "2001:7f8::ffff:ffff:ffff:ffff"),
            Some("2001:7f8::/64")
        );
        assert_eq!(hit(&t, "2001:7f8:0:1::"), None);
        assert_eq!(hit(&t, "2001:504:0:2::1"), Some("2001:504:0:2::/64"));
        assert_eq!(hit(&t, "::ffff:80.81.192.9"), Some("80.81.192.0/21"));
        // IPv4 prefixes never match IPv6 addresses with the same bits.
        assert_eq!(hit(&t, "::5051:c009"), None);
    }

    #[test]
    fn nested_prefixes_give_the_most_specific_match() {
        let t = table(&["10.0.0.0/8", "10.1.0.0/16", "10.1.2.0/24", "10.200.0.0/16"]);
        assert_eq!(hit(&t, "10.1.2.3"), Some("10.1.2.0/24"));
        assert_eq!(hit(&t, "10.1.3.3"), Some("10.1.0.0/16"));
        // A later, smaller range that does not contain the address must not
        // hide the covering /8 that starts earlier.
        assert_eq!(hit(&t, "10.100.0.1"), Some("10.0.0.0/8"));
        assert_eq!(hit(&t, "10.200.9.9"), Some("10.200.0.0/16"));
        assert_eq!(hit(&t, "11.0.0.0"), None);

        let full = table(&["0.0.0.0/0", "::/0"]);
        assert_eq!(hit(&full, "255.255.255.255"), Some("0.0.0.0/0"));
        assert_eq!(hit(&full, "ffff::1"), Some("::/0"));
    }

    #[test]
    fn empty_table_matches_nothing() {
        let t: PrefixTable<()> = PrefixTable::new(Vec::new());
        assert!(t.lookup(ip("1.1.1.1")).is_none());
        assert!(t.lookup(ip("::1")).is_none());
        assert_eq!(t.len(), 0);
    }
}
