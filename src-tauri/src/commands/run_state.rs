//! State of one traceroute run: parsed hops plus per-address lookup
//! results. Every emitted `HopResolution` is rendered from this state, so
//! hop lines and lookup results can arrive in any order.

use super::integrations::Enrichment;
use super::lookup::{IpLookup, LookupKind, LookupRequest};
use super::traceroute_parse::{ParsedHop, ParsedLine};
use crate::geoloc::estimate::{locate_hops, HopInput};
use crate::net::{is_private_ip, is_publicly_routable};
use crate::types::{HopLatencyStats, HopResolution, HopResponder, LookupState};
use std::collections::{BTreeMap, HashMap};
use std::net::IpAddr;

pub struct RunState {
    probes_per_hop: u32,
    hops: BTreeMap<u32, ParsedHop>,
    last_hop_index: Option<u32>,
    requested: HashMap<String, LookupKind>,
    completed: HashMap<String, LookupKind>,
    results: HashMap<String, IpLookup>,
    emitted: BTreeMap<u32, HopResolution>,
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

pub fn compute_latency_stats(values: &[f64]) -> HopLatencyStats {
    if values.is_empty() {
        return HopLatencyStats {
            min_rtt_ms: None,
            max_rtt_ms: None,
            avg_rtt_ms: None,
            jitter_ms: None,
        };
    }
    let min = values.iter().copied().fold(f64::INFINITY, f64::min);
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let avg = values.iter().sum::<f64>() / values.len() as f64;
    HopLatencyStats {
        min_rtt_ms: Some(round2(min)),
        max_rtt_ms: Some(round2(max)),
        avg_rtt_ms: Some(round2(avg)),
        jitter_ms: (values.len() > 1).then(|| round2(max - min)),
    }
}

impl RunState {
    pub fn new(probes_per_hop: u32) -> Self {
        Self {
            probes_per_hop,
            hops: BTreeMap::new(),
            last_hop_index: None,
            requested: HashMap::new(),
            completed: HashMap::new(),
            results: HashMap::new(),
            emitted: BTreeMap::new(),
        }
    }

    /// Records a parsed line and returns the lookups it makes necessary.
    pub fn apply_line(&mut self, line: ParsedLine) -> Vec<LookupRequest> {
        let hop_index = match line {
            ParsedLine::Hop(hop) => {
                let index = hop.hop_index;
                match self.hops.get_mut(&index) {
                    Some(existing) => {
                        let raw = hop.raw_lines.join("\n");
                        existing.merge(hop.responders, &raw);
                    }
                    None => {
                        self.hops.insert(index, hop);
                    }
                }
                index
            }
            ParsedLine::Continuation(responders, raw) => {
                let Some(index) = self.last_hop_index else {
                    return Vec::new();
                };
                if let Some(existing) = self.hops.get_mut(&index) {
                    existing.merge(responders, &raw);
                }
                index
            }
            ParsedLine::Ignored => return Vec::new(),
        };
        self.last_hop_index = Some(hop_index);

        let wanted: Vec<LookupRequest> = self.hops[&hop_index]
            .responders
            .iter()
            .enumerate()
            .map(|(position, responder)| LookupRequest {
                ip: responder.ip.clone(),
                kind: if position == 0 {
                    LookupKind::Full
                } else {
                    LookupKind::NameOnly
                },
            })
            .collect();

        wanted
            .into_iter()
            .filter(|request| {
                let already = self.requested.get(&request.ip).copied();
                if already.is_some_and(|kind| kind >= request.kind) {
                    return false;
                }
                self.requested.insert(request.ip.clone(), request.kind);
                true
            })
            .collect()
    }

    pub fn apply_lookup(&mut self, request: &LookupRequest, result: IpLookup) {
        let previous = self.completed.get(&request.ip).copied();
        if previous.is_some_and(|kind| kind > request.kind) {
            return;
        }
        self.completed.insert(request.ip.clone(), request.kind);
        self.results.insert(request.ip.clone(), result);
    }

    /// Marks a lookup as finished without data (task failed or cancelled),
    /// so the hop does not stay "pending" forever.
    pub fn abandon_lookup(&mut self, request: &LookupRequest) {
        if self
            .completed
            .get(&request.ip)
            .is_none_or(|kind| *kind < request.kind)
        {
            self.completed.insert(request.ip.clone(), request.kind);
        }
    }

    fn is_pending(&self, ip: &str) -> bool {
        match (self.requested.get(ip), self.completed.get(ip)) {
            (Some(requested), Some(completed)) => completed < requested,
            (Some(_), None) => true,
            _ => false,
        }
    }

    fn primary_enrichment(&self, hop: &ParsedHop) -> Option<&Enrichment> {
        let primary = hop.responders.first()?;
        self.results.get(&primary.ip)?.enrichment.as_ref()
    }

    /// Renders a hop without its location, which depends on the other hops
    /// (see `hops`).
    fn render_hop(&self, hop: &ParsedHop) -> HopResolution {
        let responders: Vec<HopResponder> = hop
            .responders
            .iter()
            .map(|r| HopResponder {
                ip_address: r.ip.clone(),
                host_name: r
                    .host_name
                    .clone()
                    .or_else(|| self.results.get(&r.ip).and_then(|l| l.host_name.clone())),
                rtts_ms: r.rtts.clone(),
            })
            .collect();
        let rtts: Vec<f64> = hop.rtts().collect();
        let latency = compute_latency_stats(&rtts);
        let lost = self.probes_per_hop.saturating_sub(rtts.len() as u32);
        let loss_percent = (self.probes_per_hop > 0)
            .then(|| round2(lost as f64 / self.probes_per_hop as f64 * 100.0));

        let primary = responders.first();
        let enrichment = self.primary_enrichment(hop);
        let geo = enrichment.and_then(|e| e.geo.clone());

        let lookup_state = if hop.responders.iter().any(|r| self.is_pending(&r.ip)) {
            LookupState::Pending
        } else {
            LookupState::Complete
        };

        HopResolution {
            hop_index: hop.hop_index,
            ip_address: primary.map(|r| r.ip_address.clone()),
            host_name: primary.and_then(|r| r.host_name.clone()),
            is_private: primary.is_some_and(|r| is_private_ip(&r.ip_address)),
            responders,
            loss_percent,
            latency,
            geo,
            asn: enrichment.and_then(|e| e.asn.clone()),
            location: Default::default(),
            raw_line: hop.raw_lines.join("\n"),
            providers: enrichment.map(|e| e.providers.clone()),
            peering_db: enrichment.and_then(|e| e.peering_db.clone()),
            lookup_state,
        }
    }

    fn location_input<'a>(&'a self, hop: &ParsedHop, view: &'a HopResolution) -> HopInput<'a> {
        let enrichment = self.primary_enrichment(hop);
        HopInput {
            hop_index: view.hop_index,
            public_ip: view
                .ip_address
                .as_deref()
                .and_then(|ip| ip.parse::<IpAddr>().ok())
                .filter(|ip| is_publicly_routable(*ip)),
            host_name: view.host_name.as_deref(),
            geolite: enrichment.and_then(|e| e.geo.as_ref()),
            asn: enrichment.and_then(|e| e.asn.as_ref()),
            ixp: enrichment.and_then(|e| e.ixp.as_ref()),
            single_responder: hop.responders.len() == 1,
            // The estimates belong to the primary responder; another
            // responder of a load-balanced hop may be closer.
            min_rtt_ms: compute_latency_stats(
                hop.responders
                    .first()
                    .map_or(&[][..], |primary| primary.rtts.as_slice()),
            )
            .min_rtt_ms,
        }
    }

    /// Every hop, with locations estimated across the whole run: RTT
    /// checks use a reference hop and the RTTs of later hops.
    pub fn hops(&self) -> Vec<HopResolution> {
        let mut rendered: Vec<HopResolution> =
            self.hops.values().map(|hop| self.render_hop(hop)).collect();
        let locations = {
            let inputs: Vec<HopInput> = self
                .hops
                .values()
                .zip(&rendered)
                .map(|(hop, view)| self.location_input(hop, view))
                .collect();
            locate_hops(&inputs)
        };
        for (hop, location) in rendered.iter_mut().zip(locations) {
            hop.location = location;
        }
        rendered
    }

    /// Returns the hops whose rendered value changed since the last call.
    pub fn take_changed(&mut self) -> Vec<HopResolution> {
        let rendered = self.hops();
        let changed: Vec<HopResolution> = rendered
            .into_iter()
            .filter(|hop| self.emitted.get(&hop.hop_index) != Some(hop))
            .collect();
        for hop in &changed {
            self.emitted.insert(hop.hop_index, hop.clone());
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::traceroute_parse::parse_line;
    use crate::types::{
        AnycastEvidence, AsnDetails, GeoDetails, LocationSource, ProviderId, ProviderState,
        ProviderStatus, RttVerdict,
    };

    fn feed(state: &mut RunState, line: &str) -> Vec<LookupRequest> {
        state.apply_line(parse_line(line))
    }

    fn full(ip: &str) -> LookupRequest {
        LookupRequest {
            ip: ip.into(),
            kind: LookupKind::Full,
        }
    }

    fn enriched(asn: u32) -> IpLookup {
        IpLookup {
            host_name: Some(format!("as{asn}.example")),
            enrichment: Some(Enrichment {
                geo: None,
                asn: Some(AsnDetails {
                    asn: Some(asn),
                    ..AsnDetails::default()
                }),
                peering_db: None,
                ixp: None,
                providers: vec![ProviderStatus::new(
                    ProviderId::TeamCymru,
                    ProviderState::Error,
                    "Timed out.",
                )],
            }),
        }
    }

    #[test]
    fn hop_is_emitted_before_lookups_finish() {
        let mut state = RunState::new(3);
        let lookups = feed(&mut state, " 1  8.8.4.4  1.0 ms  2.0 ms  *");
        assert_eq!(lookups, [full("8.8.4.4")]);

        let changed = state.take_changed();
        assert_eq!(changed.len(), 1);
        let hop = &changed[0];
        assert_eq!(hop.lookup_state, LookupState::Pending);
        assert_eq!(hop.ip_address.as_deref(), Some("8.8.4.4"));
        assert_eq!(hop.loss_percent, Some(33.33));
        assert_eq!(hop.latency.avg_rtt_ms, Some(1.5));
        assert!(hop.asn.is_none());

        state.apply_lookup(&lookups[0], enriched(15169));
        let updated = state.take_changed();
        assert_eq!(updated.len(), 1);
        assert_eq!(updated[0].lookup_state, LookupState::Complete);
        assert_eq!(updated[0].host_name.as_deref(), Some("as15169.example"));
        assert_eq!(updated[0].asn.as_ref().and_then(|a| a.asn), Some(15169));
        assert_eq!(
            updated[0].providers.as_ref().unwrap()[0].status,
            ProviderState::Error
        );

        assert!(
            state.take_changed().is_empty(),
            "unchanged hops are not re-emitted"
        );
    }

    #[test]
    fn multipath_responders_are_kept_and_deduplicated() {
        let mut state = RunState::new(3);
        let first = feed(&mut state, " 5  72.14.204.170  11.9 ms");
        let second = feed(&mut state, "    108.170.252.1  12.2 ms");
        let third = feed(&mut state, "    72.14.204.170  12.0 ms");
        assert_eq!(first, [full("72.14.204.170")]);
        assert_eq!(
            second,
            [LookupRequest {
                ip: "108.170.252.1".into(),
                kind: LookupKind::NameOnly
            }]
        );
        assert!(third.is_empty());

        let hops = state.hops();
        assert_eq!(hops.len(), 1);
        let hop = &hops[0];
        let ips: Vec<&str> = hop
            .responders
            .iter()
            .map(|r| r.ip_address.as_str())
            .collect();
        assert_eq!(ips, ["72.14.204.170", "108.170.252.1"]);
        assert_eq!(hop.responders[0].rtts_ms, [11.9, 12.0]);
        assert_eq!(hop.loss_percent, Some(0.0));
        assert_eq!(hop.raw_line.lines().count(), 3);
    }

    #[test]
    fn name_only_lookup_is_upgraded_when_ip_becomes_primary() {
        let mut state = RunState::new(1);
        feed(&mut state, " 3  10.0.0.1  1 ms 10.0.0.2  1 ms");
        let upgraded = feed(&mut state, " 4  10.0.0.2  2 ms");
        assert_eq!(upgraded, [full("10.0.0.2")]);
    }

    #[test]
    fn abandoned_lookup_completes_the_hop() {
        let mut state = RunState::new(3);
        let lookups = feed(&mut state, " 2  9.9.9.9  5 ms");
        state.abandon_lookup(&lookups[0]);
        assert_eq!(state.hops()[0].lookup_state, LookupState::Complete);
    }

    #[test]
    fn timeout_hop_has_full_loss_and_no_lookups() {
        let mut state = RunState::new(3);
        assert!(feed(&mut state, " 4  * * *").is_empty());
        let hop = &state.hops()[0];
        assert_eq!(hop.loss_percent, Some(100.0));
        assert_eq!(hop.ip_address, None);
        assert_eq!(hop.lookup_state, LookupState::Complete);
    }

    #[test]
    fn continuation_before_any_hop_is_ignored() {
        let mut state = RunState::new(3);
        assert!(feed(&mut state, "    1.2.3.4  1 ms").is_empty());
        assert!(state.hops().is_empty());
    }

    /// Real `traceroute -n -q 3` output from macOS (ISP router addresses
    /// replaced with documentation ranges). Extra responders of a hop are on
    /// indented lines without a hop number.
    #[test]
    fn real_macos_multipath_output() {
        let mut state = RunState::new(3);
        for line in include_str!("../../fixtures/traceroute/macos-multipath-udp.txt").lines() {
            state.apply_line(parse_line(line));
        }
        let hops = state.hops();
        let summary: Vec<(u32, Vec<&str>, Option<f64>)> = hops
            .iter()
            .map(|hop| {
                (
                    hop.hop_index,
                    hop.responders
                        .iter()
                        .map(|r| r.ip_address.as_str())
                        .collect(),
                    hop.loss_percent,
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                (1, vec!["192.168.1.1"], Some(0.0)),
                (2, vec!["198.51.100.1"], Some(0.0)),
                (
                    3,
                    vec!["198.51.100.33", "198.51.100.34", "198.51.100.35"],
                    Some(0.0)
                ),
                (4, vec!["203.0.113.10", "203.0.113.11"], Some(33.33)),
                (5, vec!["142.250.169.206"], Some(66.67)),
                (6, vec![], Some(100.0)),
                (7, vec!["8.8.8.8", "142.251.49.217"], Some(33.33)),
            ]
        );
        assert!(hops[0].is_private);
        assert_eq!(hops[2].raw_line.lines().count(), 3);
    }

    fn located(geo: GeoDetails, asn: u32) -> IpLookup {
        let mut lookup = enriched(asn);
        lookup.host_name = None;
        if let Some(enrichment) = lookup.enrichment.as_mut() {
            enrichment.geo = Some(geo);
        }
        lookup
    }

    fn geo(latitude: f64, longitude: f64, city: Option<&str>, radius: f64) -> GeoDetails {
        GeoDetails {
            latitude,
            longitude,
            city: city.map(str::to_string),
            country: None,
            iso_code: None,
            confidence: Some(radius),
        }
    }

    /// The trace from Mumbai of the old deferred anycast note, run through
    /// the state: hop 2 is the RTT reference, 8.8.8.8 is anycast, and the
    /// Cogent router name beats GeoLite2's registered location.
    #[test]
    fn locations_use_reference_hop_rtt_and_host_names() {
        let mut state = RunState::new(1);
        let gateway = feed(&mut state, " 1  192.168.1.1  0.5 ms");
        let isp = feed(&mut state, " 2  49.44.1.1  2.0 ms");
        let anycast = feed(&mut state, " 3  8.8.8.8  4.0 ms");
        let cogent = feed(
            &mut state,
            " 4  be3187.ccr41.fra03.atlas.cogentco.com (154.54.1.1)  120.0 ms",
        );
        state.apply_lookup(
            &gateway[0],
            IpLookup {
                host_name: None,
                enrichment: None,
            },
        );
        state.apply_lookup(
            &isp[0],
            located(geo(19.076, 72.8777, Some("Mumbai"), 20.0), 55836),
        );
        state.apply_lookup(
            &anycast[0],
            located(geo(37.751, -97.822, None, 1000.0), 15169),
        );
        // GeoLite2 places the Cogent router at the company's US address.
        state.apply_lookup(
            &cogent[0],
            located(geo(38.9, -77.0, Some("Washington"), 1000.0), 174),
        );

        let hops = state.hops();
        assert_eq!(hops[0].location, Default::default(), "private hop");
        assert!(hops[1].location.is_rtt_reference);
        assert_eq!(
            hops[1].location.best.as_ref().unwrap().source,
            LocationSource::GeoliteCity
        );

        let dns = &hops[2].location;
        assert!(dns.best.is_none(), "anycast hops get no point");
        let info = dns.anycast.as_ref().unwrap();
        assert_eq!(info.evidence, AnycastEvidence::KnownPrefix);
        assert!(info.geolite_ruled_out);
        assert_eq!(
            dns.alternatives[0].rtt.as_ref().unwrap().verdict,
            RttVerdict::Infeasible
        );

        let router = &hops[3].location;
        let best = router.best.as_ref().unwrap();
        assert_eq!(best.source, LocationSource::HostnameHint);
        assert_eq!(router.hostname_hint.as_ref().unwrap().token, "fra03");
        assert_eq!(best.rtt.as_ref().unwrap().verdict, RttVerdict::Feasible);
        assert_eq!(router.alternatives[0].source, LocationSource::GeoliteCity);
    }

    #[test]
    fn a_new_lower_rtt_hop_re_emits_earlier_hops() {
        let mut state = RunState::new(1);
        let isp = feed(&mut state, " 1  49.44.1.1  1.0 ms");
        let slow = feed(&mut state, " 2  62.115.1.1  130.0 ms");
        state.apply_lookup(
            &isp[0],
            located(geo(19.076, 72.8777, Some("Mumbai"), 20.0), 55836),
        );
        state.apply_lookup(
            &slow[0],
            located(geo(51.5, -0.12, Some("London"), 20.0), 1299),
        );
        state.take_changed();
        assert!(state.hops()[1].location.best.is_some());

        // Hop 3 answers in 3 ms, so hop 2 cannot be in London.
        feed(&mut state, " 3  49.44.9.9  3.0 ms");
        let changed: Vec<u32> = state.take_changed().iter().map(|h| h.hop_index).collect();
        assert!(changed.contains(&2), "{changed:?}");
        assert!(state.hops()[1].location.best.is_none());
    }

    #[test]
    fn multipath_hop_is_checked_with_its_primary_responders_rtt() {
        let mut state = RunState::new(2);
        let isp = feed(&mut state, " 1  49.44.1.1  1.0 ms");
        // The primary responder (London) answers in 130 ms; a second path
        // of the same hop answers in 3 ms.
        let hop = feed(&mut state, " 2  62.115.1.1  130.0 ms 49.44.9.9  3.0 ms");
        state.apply_lookup(
            &isp[0],
            located(geo(19.076, 72.8777, Some("Mumbai"), 20.0), 55836),
        );
        state.apply_lookup(
            &hop[0],
            located(geo(51.5, -0.12, Some("London"), 20.0), 1299),
        );

        let hops = state.hops();
        assert_eq!(hops[1].latency.min_rtt_ms, Some(3.0));
        let best = hops[1]
            .location
            .best
            .as_ref()
            .expect("London is possible at 130 ms");
        let check = best.rtt.as_ref().unwrap();
        assert_eq!(check.verdict, RttVerdict::Feasible);
        assert_eq!(check.bound_rtt_ms, 130.0);
    }

    #[test]
    fn latency_stats_round_and_report_jitter() {
        let stats = compute_latency_stats(&[1.234, 0.567, 0.890]);
        assert_eq!(stats.min_rtt_ms, Some(0.57));
        assert_eq!(stats.max_rtt_ms, Some(1.23));
        assert_eq!(stats.avg_rtt_ms, Some(0.9));
        assert_eq!(stats.jitter_ms, Some(0.67));
        assert_eq!(compute_latency_stats(&[5.0]).jitter_ms, None);
    }
}
