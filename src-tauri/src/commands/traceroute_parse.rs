//! Parses traceroute/tracert output lines into hops and responders.
//!
//! Supported shapes:
//! - Unix:    ` 5  host (1.2.3.4)  1.1 ms  1.2 ms  1.3 ms`
//! - Unix -n: ` 5  1.2.3.4  1.1 ms 5.6.7.8  1.4 ms *` (multipath on one line)
//! - macOS:   continuation lines with no hop number for extra responders
//! - Windows: `  5    12 ms    <1 ms     9 ms  host [1.2.3.4]`

use regex::Regex;
use std::net::IpAddr;
use std::sync::LazyLock;

static HOP_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(\d+)\s+(.*)$").expect("valid hop prefix regex"));
static RTT_VALUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(<)?(\d+(?:\.\d+)?)(ms)?$").expect("valid rtt regex"));

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedResponder {
    pub ip: String,
    pub host_name: Option<String>,
    pub rtts: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedHop {
    pub hop_index: u32,
    pub responders: Vec<ParsedResponder>,
    pub raw_lines: Vec<String>,
}

impl ParsedHop {
    pub fn rtts(&self) -> impl Iterator<Item = f64> + '_ {
        self.responders.iter().flat_map(|r| r.rtts.iter().copied())
    }

    /// Adds responders from another line of the same hop. A responder that
    /// is already known keeps its position and gains the new RTT values.
    pub fn merge(&mut self, responders: Vec<ParsedResponder>, raw_line: &str) {
        for incoming in responders {
            match self.responders.iter_mut().find(|r| r.ip == incoming.ip) {
                Some(existing) => {
                    existing.rtts.extend(incoming.rtts);
                    if existing.host_name.is_none() {
                        existing.host_name = incoming.host_name;
                    }
                }
                None => self.responders.push(incoming),
            }
        }
        self.raw_lines.push(raw_line.to_string());
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ParsedLine {
    Hop(ParsedHop),
    /// Extra responders for the previous hop (macOS prints them on
    /// indented lines without a hop number).
    Continuation(Vec<ParsedResponder>, String),
    Ignored,
}

pub fn parse_line(line: &str) -> ParsedLine {
    let line = line.trim_end();
    if line.trim().is_empty() {
        return ParsedLine::Ignored;
    }

    if let Some(caps) = HOP_PREFIX.captures(line) {
        let Ok(hop_index) = caps[1].parse::<u32>() else {
            return ParsedLine::Ignored;
        };
        return ParsedLine::Hop(ParsedHop {
            hop_index,
            responders: parse_responders(&caps[2]),
            raw_lines: vec![line.to_string()],
        });
    }

    if line.starts_with(char::is_whitespace) {
        let responders = parse_responders(line);
        if !responders.is_empty() {
            return ParsedLine::Continuation(responders, line.to_string());
        }
    }

    ParsedLine::Ignored
}

fn parse_ip(token: &str) -> Option<String> {
    let without_zone = token.split('%').next().unwrap_or(token);
    without_zone
        .parse::<IpAddr>()
        .ok()
        .map(|_| without_zone.to_string())
}

/// Matches `(1.2.3.4)` or `[1.2.3.4]` and returns the address.
fn parse_wrapped_ip(token: &str) -> Option<String> {
    let inner = token
        .strip_prefix('(')
        .and_then(|t| t.strip_suffix(')'))
        .or_else(|| token.strip_prefix('[').and_then(|t| t.strip_suffix(']')))?;
    parse_ip(inner)
}

/// Returns the RTT value and whether the token already carries the `ms` unit.
fn parse_rtt(token: &str) -> Option<(f64, bool)> {
    let caps = RTT_VALUE.captures(token)?;
    let value: f64 = caps[2].parse().ok()?;
    Some((value, caps.get(3).is_some()))
}

fn parse_responders(body: &str) -> Vec<ParsedResponder> {
    let tokens: Vec<&str> = body.split_whitespace().collect();
    let mut responders: Vec<ParsedResponder> = Vec::new();
    let mut leading_rtts: Vec<f64> = Vec::new();
    let mut pending_host: Option<&str> = None;
    let next_is_wrapped_ip = |i: usize| {
        tokens
            .get(i + 1)
            .is_some_and(|t| parse_wrapped_ip(t).is_some())
    };

    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i];

        if let Some((value, has_unit)) = parse_rtt(token) {
            let unit_follows = tokens.get(i + 1) == Some(&"ms");
            if has_unit || unit_follows {
                match responders.last_mut() {
                    Some(last) => last.rtts.push(value),
                    None => leading_rtts.push(value),
                }
                i += if unit_follows { 2 } else { 1 };
                continue;
            }
        }

        if let Some(ip) = parse_wrapped_ip(token) {
            let host_name = pending_host
                .take()
                .filter(|host| *host != ip)
                .map(str::to_string);
            responders.push(ParsedResponder {
                ip,
                host_name,
                rtts: Vec::new(),
            });
        } else if next_is_wrapped_ip(i) {
            pending_host = Some(token);
        } else if let Some(ip) = parse_ip(token) {
            responders.push(ParsedResponder {
                ip,
                host_name: None,
                rtts: Vec::new(),
            });
        }
        i += 1;
    }

    // Windows tracert prints the RTT columns before the address.
    if !leading_rtts.is_empty() {
        if let [only] = responders.as_mut_slice() {
            if only.rtts.is_empty() {
                only.rtts = leading_rtts;
            }
        }
    }

    responders
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hop(line: &str) -> ParsedHop {
        match parse_line(line) {
            ParsedLine::Hop(hop) => hop,
            other => panic!("expected a hop for {line:?}, got {other:?}"),
        }
    }

    fn ips(hop: &ParsedHop) -> Vec<&str> {
        hop.responders.iter().map(|r| r.ip.as_str()).collect()
    }

    #[test]
    fn parses_macos_numeric_line() {
        let parsed = hop(" 1  192.168.1.1  2.712 ms  1.503 ms  1.399 ms");
        assert_eq!(parsed.hop_index, 1);
        assert_eq!(ips(&parsed), ["192.168.1.1"]);
        assert_eq!(parsed.responders[0].rtts, [2.712, 1.503, 1.399]);
    }

    #[test]
    fn parses_hostname_with_ip_in_parentheses() {
        let parsed = hop(" 3  ae1.lon.example.net (203.0.113.9)  10.1 ms  10.4 ms  9.9 ms");
        assert_eq!(ips(&parsed), ["203.0.113.9"]);
        assert_eq!(
            parsed.responders[0].host_name.as_deref(),
            Some("ae1.lon.example.net")
        );
        assert_eq!(parsed.rtts().count(), 3);
    }

    #[test]
    fn ignores_hostname_equal_to_ip() {
        let parsed = hop(" 4  8.8.8.8 (8.8.8.8)  10.123 ms");
        assert_eq!(ips(&parsed), ["8.8.8.8"]);
        assert_eq!(parsed.responders[0].host_name, None);
    }

    #[test]
    fn parses_linux_multipath_line_with_hostnames() {
        let parsed = hop(
            " 7  a.example.net (198.51.100.1)  12.1 ms b.example.net (198.51.100.2)  12.5 ms  12.6 ms",
        );
        assert_eq!(ips(&parsed), ["198.51.100.1", "198.51.100.2"]);
        assert_eq!(parsed.responders[0].rtts, [12.1]);
        assert_eq!(parsed.responders[1].rtts, [12.5, 12.6]);
        assert_eq!(
            parsed.responders[1].host_name.as_deref(),
            Some("b.example.net")
        );
    }

    #[test]
    fn parses_linux_numeric_multipath_with_partial_timeout() {
        let parsed = hop(" 8  209.85.252.1  14.0 ms *  72.14.236.2  15.2 ms");
        assert_eq!(ips(&parsed), ["209.85.252.1", "72.14.236.2"]);
        assert_eq!(parsed.rtts().count(), 2);
    }

    #[test]
    fn parses_macos_continuation_lines() {
        let first = hop(" 5  72.14.204.170  11.987 ms");
        assert_eq!(ips(&first), ["72.14.204.170"]);

        match parse_line("    108.170.252.1  12.201 ms") {
            ParsedLine::Continuation(responders, raw) => {
                assert_eq!(responders.len(), 1);
                assert_eq!(responders[0].ip, "108.170.252.1");
                assert_eq!(responders[0].rtts, [12.201]);
                assert_eq!(raw, "    108.170.252.1  12.201 ms");
            }
            other => panic!("expected continuation, got {other:?}"),
        }
    }

    #[test]
    fn merge_appends_new_responders_and_extends_known_ones() {
        let mut parsed = hop(" 5  72.14.204.170  11.987 ms");
        parsed.merge(
            vec![
                ParsedResponder {
                    ip: "108.170.252.1".into(),
                    host_name: None,
                    rtts: vec![12.2],
                },
                ParsedResponder {
                    ip: "72.14.204.170".into(),
                    host_name: Some("edge.example".into()),
                    rtts: vec![12.0],
                },
            ],
            "    108.170.252.1  12.2 ms",
        );
        assert_eq!(ips(&parsed), ["72.14.204.170", "108.170.252.1"]);
        assert_eq!(parsed.responders[0].rtts, [11.987, 12.0]);
        assert_eq!(
            parsed.responders[0].host_name.as_deref(),
            Some("edge.example")
        );
        assert_eq!(parsed.raw_lines.len(), 2);
    }

    #[test]
    fn parses_all_timeouts_as_empty_hop() {
        let parsed = hop(" 2  * * *");
        assert_eq!(parsed.hop_index, 2);
        assert!(parsed.responders.is_empty());
    }

    #[test]
    fn parses_icmp_annotations_after_rtt() {
        let parsed = hop(" 9  198.51.100.9  20.1 ms !H  20.3 ms !H  *");
        assert_eq!(ips(&parsed), ["198.51.100.9"]);
        assert_eq!(parsed.responders[0].rtts, [20.1, 20.3]);
    }

    #[test]
    fn parses_tcp_annotations() {
        let parsed = hop(" 11  93.184.216.34 [open]  90.1 ms  90.4 ms");
        assert_eq!(ips(&parsed), ["93.184.216.34"]);
        assert_eq!(parsed.responders[0].rtts, [90.1, 90.4]);

        let linux_tcp = hop(" 11  93.184.216.34  90.1 ms <syn,ack>  90.4 ms <syn,ack>");
        assert_eq!(linux_tcp.responders[0].rtts, [90.1, 90.4]);
    }

    #[test]
    fn parses_windows_line_with_hostname() {
        let parsed = hop("  3    12 ms     8 ms    10 ms  router.example.com [192.168.1.1]");
        assert_eq!(parsed.hop_index, 3);
        assert_eq!(ips(&parsed), ["192.168.1.1"]);
        assert_eq!(parsed.responders[0].rtts, [12.0, 8.0, 10.0]);
        assert_eq!(
            parsed.responders[0].host_name.as_deref(),
            Some("router.example.com")
        );
    }

    #[test]
    fn parses_windows_sub_millisecond_and_partial_timeout() {
        let parsed = hop("  1    <1 ms     *       2 ms  10.0.0.1");
        assert_eq!(ips(&parsed), ["10.0.0.1"]);
        assert_eq!(parsed.responders[0].rtts, [1.0, 2.0]);
    }

    #[test]
    fn parses_windows_timeout_line() {
        let parsed = hop("  6     *        *        *     Request timed out.");
        assert_eq!(parsed.hop_index, 6);
        assert!(parsed.responders.is_empty());
    }

    #[test]
    fn parses_windows_unreachable_report() {
        let parsed = hop("  4  10.0.0.1  reports: Destination host unreachable.");
        assert_eq!(ips(&parsed), ["10.0.0.1"]);
        assert!(parsed.responders[0].rtts.is_empty());
    }

    #[test]
    fn parses_ipv6_bare_bracketed_and_zoned() {
        let bare = hop(" 5  2001:4860:0:1::89b  12.345 ms  13.456 ms  14.567 ms");
        assert_eq!(ips(&bare), ["2001:4860:0:1::89b"]);
        assert_eq!(bare.rtts().count(), 3);

        let windows = hop("  2     5 ms     4 ms     4 ms  edge.example [2001:db8::2]");
        assert_eq!(ips(&windows), ["2001:db8::2"]);
        assert_eq!(
            windows.responders[0].host_name.as_deref(),
            Some("edge.example")
        );

        let paren = hop(" 1  gw.example (fe80::1%en0)  0.9 ms");
        assert_eq!(ips(&paren), ["fe80::1"]);
    }

    #[test]
    fn parses_rtt_without_space_before_unit() {
        let parsed = hop(" 2  10.0.0.2  0.403ms  0.398ms");
        assert_eq!(parsed.responders[0].rtts, [0.403, 0.398]);
    }

    #[test]
    fn ignores_headers_and_trailers() {
        for line in [
            "traceroute to 8.8.8.8 (8.8.8.8), 30 hops max, 60 byte packets",
            "Tracing route to dns.google [8.8.8.8]",
            "over a maximum of 30 hops:",
            "Trace complete.",
            "",
            "   ",
        ] {
            assert_eq!(parse_line(line), ParsedLine::Ignored, "line {line:?}");
        }
    }
}
