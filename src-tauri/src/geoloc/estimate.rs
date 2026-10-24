//! Builds the location of every hop of a run.
//!
//! 1. Candidates per hop: PeeringDB IX LAN, host name hint, GeoLite2 city
//!    or country. Private addresses get none.
//! 2. RTT bound per hop: its own minimum RTT, or a lower RTT of a later
//!    hop. A router on the path is no further from the user than any later
//!    hop reached through it. Later hops only count when this hop and the
//!    later hop each have one responder (no load balancing).
//! 3. Reference: the first public hop whose best candidate has at least
//!    medium confidence and a radius of at most `REFERENCE_MAX_RADIUS_KM`.
//!    Every other hop's candidates are checked against it (`rtt::check`).
//! 4. Anycast: a documented anycast prefix, or an anycast operator's ASN
//!    with a GeoLite2 location that the RTT rules out. Anycast hops get no
//!    best estimate.
//! 5. Precedence (`rank`): feasible before infeasible, then higher
//!    confidence, then source (IXP, host name, GeoLite2 city, GeoLite2
//!    country), then smaller radius. An infeasible candidate is never best.

use super::anycast::{anycast_operator, known_service};
use super::hostname::{hostname_hint, HINT_RADIUS_KM};
use super::ixp::IxpHit;
use super::rtt::{self, RttBound, RttReference};
use crate::types::{
    AnycastEvidence, AnycastInfo, AsnDetails, GeoDetails, HopLocation, LocationConfidence,
    LocationEstimate, LocationSource, RttVerdict,
};
use std::cmp::Ordering;
use std::net::IpAddr;

/// Only a city-level estimate is precise enough to check other hops
/// against. A wrong reference makes correct candidates of other hops look
/// impossible, so low-confidence estimates never serve as reference.
pub const REFERENCE_MAX_RADIUS_KM: f64 = 200.0;
const REFERENCE_MIN_CONFIDENCE: LocationConfidence = LocationConfidence::Medium;
/// GeoLite2 omits the accuracy radius for some records.
const GEOLITE_CITY_DEFAULT_RADIUS_KM: f64 = 200.0;
const GEOLITE_COUNTRY_DEFAULT_RADIUS_KM: f64 = 1000.0;
/// GeoLite2 city records up to this radius count as medium confidence.
const GEOLITE_MEDIUM_MAX_RADIUS_KM: f64 = 100.0;

/// What the run knows about one hop's primary responder.
#[derive(Debug, Clone, Copy, Default)]
pub struct HopInput<'a> {
    pub hop_index: u32,
    /// Set only for publicly routable addresses.
    pub public_ip: Option<IpAddr>,
    pub host_name: Option<&'a str>,
    pub geolite: Option<&'a GeoDetails>,
    pub asn: Option<&'a AsnDetails>,
    pub ixp: Option<&'a IxpHit>,
    pub single_responder: bool,
    pub min_rtt_ms: Option<f64>,
}

#[derive(Debug, Clone, Default)]
struct Candidates {
    estimates: Vec<LocationEstimate>,
    location: HopLocation,
    known_anycast: Option<&'static str>,
}

fn source_rank(source: LocationSource) -> u8 {
    match source {
        LocationSource::Ixp => 3,
        LocationSource::HostnameHint => 2,
        LocationSource::GeoliteCity => 1,
        LocationSource::GeoliteCountry => 0,
    }
}

fn is_infeasible(estimate: &LocationEstimate) -> bool {
    estimate
        .rtt
        .as_ref()
        .is_some_and(|check| check.verdict == RttVerdict::Infeasible)
}

/// Best first. See the module documentation for the order.
fn rank(a: &LocationEstimate, b: &LocationEstimate) -> Ordering {
    is_infeasible(a)
        .cmp(&is_infeasible(b))
        .then(b.confidence.cmp(&a.confidence))
        .then(source_rank(b.source).cmp(&source_rank(a.source)))
        .then(a.radius_km.total_cmp(&b.radius_km))
}

/// Radius beyond which the source is certainly wrong. GeoLite2's
/// `accuracy_radius` is a 67 % radius, so the hard limit doubles it.
pub fn hard_radius_km(estimate: &LocationEstimate) -> f64 {
    match estimate.source {
        LocationSource::GeoliteCity | LocationSource::GeoliteCountry => 2.0 * estimate.radius_km,
        LocationSource::Ixp | LocationSource::HostnameHint => estimate.radius_km,
    }
}

/// An IX whose facilities lie within 150 km (one metro and its nearby
/// sites, like DE-CIX Frankfurt with Karlsruhe) is high confidence; IXs
/// that span regions are not.
fn ixp_confidence(radius_km: f64) -> LocationConfidence {
    if radius_km <= 150.0 {
        LocationConfidence::High
    } else if radius_km <= 500.0 {
        LocationConfidence::Medium
    } else {
        LocationConfidence::Low
    }
}

fn geolite_estimate(geo: &GeoDetails) -> LocationEstimate {
    let country = geo.country.clone().or_else(|| geo.iso_code.clone());
    match &geo.city {
        Some(city) => {
            let radius = geo.confidence.unwrap_or(GEOLITE_CITY_DEFAULT_RADIUS_KM);
            LocationEstimate {
                source: LocationSource::GeoliteCity,
                latitude: geo.latitude,
                longitude: geo.longitude,
                radius_km: radius,
                confidence: if radius <= GEOLITE_MEDIUM_MAX_RADIUS_KM {
                    LocationConfidence::Medium
                } else {
                    LocationConfidence::Low
                },
                label: match country {
                    Some(country) => format!("{city}, {country}"),
                    None => city.clone(),
                },
                rtt: None,
            }
        }
        None => LocationEstimate {
            source: LocationSource::GeoliteCountry,
            latitude: geo.latitude,
            longitude: geo.longitude,
            radius_km: geo.confidence.unwrap_or(GEOLITE_COUNTRY_DEFAULT_RADIUS_KM),
            confidence: LocationConfidence::Low,
            label: country.unwrap_or_else(|| "Unknown country".to_string()),
            rtt: None,
        },
    }
}

fn candidates(input: &HopInput) -> Candidates {
    let Some(ip) = input.public_ip else {
        return Candidates::default();
    };
    let mut found = Candidates {
        known_anycast: known_service(ip),
        ..Candidates::default()
    };
    if let Some(hit) = input.ixp {
        if let Some(position) = hit.position {
            found.estimates.push(LocationEstimate {
                source: LocationSource::Ixp,
                latitude: position.latitude,
                longitude: position.longitude,
                radius_km: position.radius_km,
                confidence: ixp_confidence(position.radius_km),
                label: hit.info.name.clone(),
                rtt: None,
            });
        }
        found.location.ixp = Some(hit.info.clone());
    }
    let context_country = input
        .geolite
        .and_then(|g| g.iso_code.as_deref())
        .or_else(|| input.asn.and_then(|a| a.country.as_deref()));
    if let Some(hint) = input
        .host_name
        .and_then(|host| hostname_hint(host, context_country))
    {
        found.estimates.push(LocationEstimate {
            source: LocationSource::HostnameHint,
            latitude: hint.latitude,
            longitude: hint.longitude,
            radius_km: HINT_RADIUS_KM,
            confidence: hint.confidence,
            label: hint.info.place.clone(),
            rtt: None,
        });
        found.location.hostname_hint = Some(hint.info);
    }
    if let Some(geo) = input.geolite {
        found.estimates.push(geolite_estimate(geo));
    }
    found.estimates.sort_by(rank);
    found
}

/// The RTT bound of each hop: its own minimum RTT or a lower one of a
/// later single-responder hop.
fn rtt_bounds(inputs: &[HopInput]) -> Vec<Option<RttBound>> {
    let lower = |a: Option<RttBound>, b: Option<RttBound>| match (a, b) {
        (Some(x), Some(y)) => Some(if y.rtt_ms < x.rtt_ms { y } else { x }),
        (x, y) => x.or(y),
    };
    let mut bounds = vec![None; inputs.len()];
    let mut later: Option<RttBound> = None;
    for (index, input) in inputs.iter().enumerate().rev() {
        let own = input
            .min_rtt_ms
            .filter(|rtt| rtt.is_finite() && *rtt >= 0.0)
            .map(|rtt_ms| RttBound {
                hop_index: input.hop_index,
                rtt_ms,
            });
        if input.single_responder {
            bounds[index] = lower(own, later);
            later = lower(own, later);
        } else {
            bounds[index] = own;
        }
    }
    bounds
}

fn choose_reference(
    inputs: &[HopInput],
    candidates: &[Candidates],
    bounds: &[Option<RttBound>],
) -> Option<RttReference> {
    inputs
        .iter()
        .zip(candidates)
        .zip(bounds)
        .find_map(|((input, found), bound)| {
            let best = found.estimates.first()?;
            let usable = found.known_anycast.is_none()
                && best.radius_km <= REFERENCE_MAX_RADIUS_KM
                && best.confidence >= REFERENCE_MIN_CONFIDENCE;
            usable.then_some(RttReference {
                hop_index: input.hop_index,
                latitude: best.latitude,
                longitude: best.longitude,
                radius_km: hard_radius_km(best),
                rtt_ms: (*bound)?.rtt_ms,
            })
        })
}

fn apply_rtt(estimate: &mut LocationEstimate, reference: &RttReference, bound: RttBound) {
    let (check, radius) = rtt::check(
        estimate.latitude,
        estimate.longitude,
        estimate.radius_km,
        hard_radius_km(estimate),
        reference,
        bound,
    );
    if check.verdict == RttVerdict::Widened {
        estimate.confidence = LocationConfidence::Low;
    }
    estimate.radius_km = radius;
    estimate.rtt = Some(check);
}

fn geolite_ruled_out(estimates: &[LocationEstimate]) -> bool {
    estimates.iter().any(|e| {
        matches!(
            e.source,
            LocationSource::GeoliteCity | LocationSource::GeoliteCountry
        ) && is_infeasible(e)
    })
}

/// Locations for every hop of a run, in the order of `inputs`.
pub fn locate_hops(inputs: &[HopInput]) -> Vec<HopLocation> {
    let candidates: Vec<Candidates> = inputs.iter().map(candidates).collect();
    let bounds = rtt_bounds(inputs);
    let reference = choose_reference(inputs, &candidates, &bounds);

    inputs
        .iter()
        .zip(candidates)
        .zip(bounds)
        .map(|((input, found), bound)| {
            let Candidates {
                mut estimates,
                mut location,
                known_anycast,
            } = found;
            let is_reference = reference.is_some_and(|r| r.hop_index == input.hop_index);
            let checked = match (reference, bound) {
                (Some(reference), Some(bound)) if !is_reference => Some((reference, bound)),
                _ => None,
            };
            if let Some((reference, bound)) = checked {
                for estimate in &mut estimates {
                    apply_rtt(estimate, &reference, bound);
                }
            }
            location.is_rtt_reference = is_reference;

            let ruled_out = geolite_ruled_out(&estimates);
            let evidence = match known_anycast {
                Some(service) => Some((AnycastEvidence::KnownPrefix, service)),
                None => input
                    .asn
                    .and_then(|a| a.asn)
                    .and_then(anycast_operator)
                    .filter(|_| ruled_out)
                    .map(|operator| (AnycastEvidence::OperatorAsnRtt, operator)),
            };
            location.anycast = evidence.map(|(evidence, service)| AnycastInfo {
                evidence,
                service: service.to_string(),
                geolite_ruled_out: ruled_out,
                max_distance_km: checked.map(|(r, b)| rtt::max_distance_km(&r, b).round()),
                reference_hop_index: checked.map(|(r, _)| r.hop_index),
            });

            estimates.sort_by(rank);
            if location.anycast.is_none() && estimates.first().is_some_and(|e| !is_infeasible(e)) {
                location.best = Some(estimates.remove(0));
            }
            location.alternatives = estimates;
            location
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geoloc::ixp::IxPosition;
    use crate::types::IxpMatch;

    const MUMBAI: (f64, f64) = (19.076, 72.8777);

    fn geo(lat: f64, lon: f64, city: Option<&str>, iso: &str, radius: f64) -> GeoDetails {
        GeoDetails {
            latitude: lat,
            longitude: lon,
            city: city.map(str::to_string),
            country: None,
            iso_code: Some(iso.to_string()),
            confidence: Some(radius),
        }
    }

    fn input<'a>(hop_index: u32, ip: &str, rtt: f64) -> HopInput<'a> {
        HopInput {
            hop_index,
            public_ip: ip.parse().ok(),
            single_responder: true,
            min_rtt_ms: Some(rtt),
            ..HopInput::default()
        }
    }

    fn sources(location: &HopLocation) -> Vec<LocationSource> {
        location
            .best
            .iter()
            .chain(&location.alternatives)
            .map(|e| e.source)
            .collect()
    }

    fn decix() -> IxpHit {
        IxpHit {
            info: IxpMatch {
                ix_id: 31,
                name: "DE-CIX Frankfurt".into(),
                city: Some("Frankfurt".into()),
                country: Some("DE".into()),
                prefix: "80.81.192.0/21".into(),
                facility_count: 30,
            },
            position: Some(IxPosition {
                latitude: 50.11,
                longitude: 8.68,
                radius_km: 25.0,
            }),
        }
    }

    #[test]
    fn precedence_is_ixp_then_hint_then_city_then_country() {
        let ixp = decix();
        let city = geo(50.11, 8.68, Some("Frankfurt"), "DE", 50.0);
        let mut hop = input(1, "80.81.194.10", 10.0);
        hop.ixp = Some(&ixp);
        hop.host_name = Some("be3187.ccr41.fra03.atlas.cogentco.com");
        hop.geolite = Some(&city);
        let location = &locate_hops(&[hop])[0];
        assert_eq!(
            sources(location),
            [
                LocationSource::Ixp,
                LocationSource::HostnameHint,
                LocationSource::GeoliteCity
            ]
        );
        let best = location.best.as_ref().unwrap();
        assert_eq!(best.label, "DE-CIX Frankfurt");
        assert_eq!(best.confidence, LocationConfidence::High);
        assert_eq!(location.ixp.as_ref().unwrap().prefix, "80.81.192.0/21");
        assert_eq!(location.hostname_hint.as_ref().unwrap().token, "fra03");

        let country = geo(51.0, 9.0, None, "DE", 1000.0);
        let mut hop = input(1, "80.81.194.10", 10.0);
        hop.geolite = Some(&country);
        let best = locate_hops(&[hop])[0].best.clone().unwrap();
        assert_eq!(best.source, LocationSource::GeoliteCountry);
        assert_eq!(best.confidence, LocationConfidence::Low);
        assert_eq!(best.label, "DE");
    }

    #[test]
    fn higher_confidence_beats_source_rank() {
        // A bare-code hint (low) loses to a 20 km GeoLite2 city (medium).
        let city = geo(48.86, 2.35, Some("Paris"), "FR", 20.0);
        let mut hop = input(1, "193.251.1.1", 5.0);
        hop.host_name = Some("par.example.net");
        hop.geolite = Some(&city);
        let location = &locate_hops(&[hop])[0];
        assert_eq!(
            location.best.as_ref().unwrap().source,
            LocationSource::GeoliteCity
        );
        assert_eq!(
            location.alternatives[0].confidence,
            LocationConfidence::Low,
            "{location:?}"
        );
    }

    #[test]
    fn private_and_silent_hops_have_no_candidates() {
        let mut private = input(1, "192.168.1.1", 0.5);
        private.public_ip = None;
        private.host_name = Some("ae1.fra03.example.net");
        let silent = HopInput {
            hop_index: 2,
            ..HopInput::default()
        };
        for location in locate_hops(&[private, silent]) {
            assert_eq!(location, HopLocation::default());
        }
    }

    #[test]
    fn reference_is_first_public_city_level_hop() {
        let country = geo(22.0, 79.0, None, "IN", 1000.0);
        let mumbai = geo(MUMBAI.0, MUMBAI.1, Some("Mumbai"), "IN", 20.0);
        let mut private = input(1, "192.168.1.1", 0.4);
        private.public_ip = None;
        let mut coarse = input(2, "49.44.1.1", 1.5);
        coarse.geolite = Some(&country);
        let mut city = input(3, "49.44.2.1", 2.0);
        city.geolite = Some(&mumbai);
        let mut far = input(4, "49.44.3.1", 3.0);
        far.geolite = Some(&country);

        let locations = locate_hops(&[private, coarse, city, far]);
        assert!(locations[2].is_rtt_reference);
        assert!(locations[2].best.as_ref().unwrap().rtt.is_none());
        let check = locations[1].best.as_ref().unwrap().rtt.clone().unwrap();
        assert_eq!(check.reference_hop_index, 3);
        // Hop 2's own 1.5 ms is lower than every later RTT.
        assert_eq!(check.bound_hop_index, 2);
        assert_eq!(
            locations[3]
                .best
                .as_ref()
                .unwrap()
                .rtt
                .as_ref()
                .unwrap()
                .reference_hop_index,
            3
        );
    }

    #[test]
    fn low_confidence_estimates_never_become_the_reference() {
        // A 150 km GeoLite2 city record is low confidence, and so is a bare
        // airport code: neither may anchor the RTT check.
        let low_city = geo(18.52, 73.86, Some("Pune"), "IN", 150.0);
        let mumbai = geo(MUMBAI.0, MUMBAI.1, Some("Mumbai"), "IN", 20.0);
        let india = geo(20.0, 77.0, None, "IN", 1000.0);
        let mut first = input(1, "49.44.1.1", 1.0);
        first.geolite = Some(&low_city);
        let mut bare = input(2, "49.44.2.2", 1.5);
        bare.host_name = Some("bom.example.net");
        bare.geolite = Some(&india);
        let mut city = input(3, "49.44.3.3", 2.0);
        city.geolite = Some(&mumbai);

        let locations = locate_hops(&[first, bare, city]);
        assert!(!locations[0].is_rtt_reference);
        assert!(!locations[1].is_rtt_reference);
        assert_eq!(
            locations[1].best.as_ref().unwrap().confidence,
            LocationConfidence::Low
        );
        assert!(locations[2].is_rtt_reference);
        let check = locations[0].best.as_ref().unwrap().rtt.clone().unwrap();
        assert_eq!(check.reference_hop_index, 3);
    }

    #[test]
    fn later_lower_rtt_bounds_a_slow_router_unless_load_balanced() {
        let mumbai = geo(MUMBAI.0, MUMBAI.1, Some("Mumbai"), "IN", 20.0);
        // GeoLite2 places the slow router in London (7,200 km away).
        let london = geo(51.5, -0.12, Some("London"), "GB", 20.0);
        let mut reference = input(1, "49.44.1.1", 1.0);
        reference.geolite = Some(&mumbai);
        let mut slow = input(2, "62.115.1.1", 130.0);
        slow.geolite = Some(&london);
        let fast_later = input(3, "49.44.9.9", 3.0);

        let locations = locate_hops(&[reference, slow, fast_later]);
        let rejected = &locations[1];
        assert!(rejected.best.is_none(), "{rejected:?}");
        let check = rejected.alternatives[0].rtt.clone().unwrap();
        assert_eq!(check.verdict, RttVerdict::Infeasible);
        assert_eq!(check.bound_hop_index, 3);
        assert_eq!(check.bound_rtt_ms, 3.0);

        slow.single_responder = false;
        let locations = locate_hops(&[reference, slow, fast_later]);
        let kept = locations[1].best.as_ref().unwrap();
        assert_eq!(kept.rtt.as_ref().unwrap().verdict, RttVerdict::Feasible);
        assert_eq!(kept.rtt.as_ref().unwrap().bound_hop_index, 2);
    }

    #[test]
    fn infeasible_candidate_is_never_best() {
        let mumbai = geo(MUMBAI.0, MUMBAI.1, Some("Mumbai"), "IN", 20.0);
        let us = geo(37.751, -97.822, None, "US", 1000.0);
        let mut reference = input(1, "49.44.1.1", 1.0);
        reference.geolite = Some(&mumbai);
        let mut hop = input(2, "129.250.1.1", 3.0);
        hop.geolite = Some(&us);
        hop.host_name = Some("bom07s29-in-f14.1e100.net");

        let location = &locate_hops(&[reference, hop])[1];
        let best = location.best.as_ref().unwrap();
        assert_eq!(best.source, LocationSource::HostnameHint);
        assert_eq!(best.label, "Mumbai, IN");
        assert_eq!(
            location.alternatives[0].source,
            LocationSource::GeoliteCountry
        );
        assert!(is_infeasible(&location.alternatives[0]));
        assert!(location.anycast.is_none(), "not an anycast operator");
    }

    #[test]
    fn known_anycast_prefix_has_no_best_point() {
        let mumbai = geo(MUMBAI.0, MUMBAI.1, Some("Mumbai"), "IN", 20.0);
        let us = geo(37.751, -97.822, None, "US", 1000.0);
        let mut reference = input(1, "49.44.1.1", 2.0);
        reference.geolite = Some(&mumbai);
        let mut dns = input(2, "8.8.8.8", 4.0);
        dns.geolite = Some(&us);

        let location = &locate_hops(&[reference, dns])[1];
        assert!(location.best.is_none());
        let anycast = location.anycast.as_ref().unwrap();
        assert_eq!(anycast.evidence, AnycastEvidence::KnownPrefix);
        assert_eq!(anycast.service, "Google Public DNS");
        assert!(anycast.geolite_ruled_out);
        // 200 + 400 + 2 x 20 + 100 km.
        assert_eq!(anycast.max_distance_km, Some(740.0));
        assert_eq!(anycast.reference_hop_index, Some(1));
        assert_eq!(location.alternatives.len(), 1, "GeoLite2 is still listed");

        // Without a reference hop the prefix list alone still decides.
        let alone = &locate_hops(&[dns])[0];
        let anycast = alone.anycast.as_ref().unwrap();
        assert!(!anycast.geolite_ruled_out);
        assert_eq!(anycast.max_distance_km, None);
        assert!(alone.best.is_none());
    }

    #[test]
    fn anycast_operator_needs_the_rtt_to_rule_out_geolite() {
        let mumbai = geo(MUMBAI.0, MUMBAI.1, Some("Mumbai"), "IN", 20.0);
        let us = geo(37.751, -97.822, None, "US", 1000.0);
        let cloudflare = AsnDetails {
            asn: Some(13335),
            ..AsnDetails::default()
        };
        let mut reference = input(1, "49.44.1.1", 1.0);
        reference.geolite = Some(&mumbai);
        let mut edge = input(2, "104.16.132.229", 3.0);
        edge.geolite = Some(&us);
        edge.asn = Some(&cloudflare);

        let location = &locate_hops(&[reference, edge])[1];
        let anycast = location.anycast.as_ref().unwrap();
        assert_eq!(anycast.evidence, AnycastEvidence::OperatorAsnRtt);
        assert_eq!(anycast.service, "Cloudflare");
        assert!(location.best.is_none());

        // 250 ms makes the US location possible: no anycast claim.
        edge.min_rtt_ms = Some(250.0);
        let location = &locate_hops(&[reference, edge])[1];
        assert!(location.anycast.is_none());
        assert_eq!(
            location.best.as_ref().unwrap().source,
            LocationSource::GeoliteCountry
        );
    }

    #[test]
    fn widened_estimate_drops_to_low_confidence() {
        let mumbai = geo(MUMBAI.0, MUMBAI.1, Some("Mumbai"), "IN", 20.0);
        // ~845 km away with radius 100 (hard 200) and a 740 km limit.
        let bangalore = geo(12.9716, 77.5946, Some("Bengaluru"), "IN", 100.0);
        let mut reference = input(1, "49.44.1.1", 2.0);
        reference.geolite = Some(&mumbai);
        let mut hop = input(2, "49.44.5.5", 4.0);
        hop.geolite = Some(&bangalore);
        let best = locate_hops(&[reference, hop])[1].best.clone().unwrap();
        assert_eq!(best.rtt.as_ref().unwrap().verdict, RttVerdict::Widened);
        assert_eq!(best.radius_km, 200.0);
        assert_eq!(best.confidence, LocationConfidence::Low);
    }
}
