//! Speed-of-light checks for location estimates.
//!
//! Light in fibre covers about 200 km per millisecond one way, so a reply
//! after `rtt` ms comes from at most `rtt / 2 * 200` km away. Every probe
//! starts at the user's machine, so for two hops `a` and `b`:
//!
//! `distance(a, b) <= distance(a, user) + distance(user, b) <= reach(rtt_a) + reach(rtt_b)`
//!
//! The reference hop `a` is the first public hop with a city-level
//! estimate (see `estimate::choose_reference`); the user's own address is
//! not known to the app. The check only filters estimates and changes
//! their radius. It never moves an estimate.

use crate::types::{RttCheck, RttVerdict};

/// One-way speed of light in optical fibre (about c / 1.47).
pub const FIBRE_KM_PER_MS: f64 = 200.0;
const EARTH_RADIUS_KM: f64 = 6371.0;
/// Absorbs coordinate rounding and clock jitter so borderline estimates are
/// not rejected.
pub const SLACK_KM: f64 = 100.0;

pub fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let (phi1, phi2) = (lat1.to_radians(), lat2.to_radians());
    let d_phi = phi2 - phi1;
    let d_lambda = (lon2 - lon1).to_radians();
    let h = (d_phi / 2.0).sin().powi(2) + phi1.cos() * phi2.cos() * (d_lambda / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_KM * h.sqrt().min(1.0).asin()
}

/// Furthest distance a reply after `rtt_ms` can have travelled one way.
pub fn reach_km(rtt_ms: f64) -> f64 {
    rtt_ms / 2.0 * FIBRE_KM_PER_MS
}

/// The location that other hops are checked against.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RttReference {
    pub hop_index: u32,
    pub latitude: f64,
    pub longitude: f64,
    /// Hard radius of the reference estimate (see `estimate::hard_radius_km`).
    pub radius_km: f64,
    pub rtt_ms: f64,
}

/// The smallest RTT that limits how far a hop can be from the user.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RttBound {
    pub hop_index: u32,
    pub rtt_ms: f64,
}

/// Furthest a hop with RTT bound `bound` can be from the reference centre.
pub fn max_distance_km(reference: &RttReference, bound: RttBound) -> f64 {
    reach_km(reference.rtt_ms) + reach_km(bound.rtt_ms) + reference.radius_km + SLACK_KM
}

/// Checks an estimate (centre, stated `radius_km`, `hard_radius_km` beyond
/// which the source is certainly wrong) against the RTT bound. Returns the
/// verdict and the radius to show.
///
/// The hop lies in both the estimate's hard disk and the disk of radius
/// `max` around the reference. Seen from the estimate's centre, that area
/// ends at `distance + max`. If that is inside the stated radius, the
/// radius shrinks to it. If the area starts outside the stated radius
/// (`distance - max > radius`), the radius grows to cover it.
pub fn check(
    latitude: f64,
    longitude: f64,
    radius_km: f64,
    hard_radius_km: f64,
    reference: &RttReference,
    bound: RttBound,
) -> (RttCheck, f64) {
    let distance = haversine_km(reference.latitude, reference.longitude, latitude, longitude);
    let max = max_distance_km(reference, bound);
    let outer = distance + max;
    let (verdict, radius) = if distance - hard_radius_km > max {
        (RttVerdict::Infeasible, radius_km)
    } else if outer < radius_km {
        (RttVerdict::Tightened, outer)
    } else if distance - max > radius_km {
        (RttVerdict::Widened, outer.min(hard_radius_km))
    } else {
        (RttVerdict::Feasible, radius_km)
    };
    let check = RttCheck {
        verdict,
        distance_km: round1(distance),
        max_distance_km: round1(max),
        original_radius_km: radius_km,
        reference_hop_index: reference.hop_index,
        bound_hop_index: bound.hop_index,
        bound_rtt_ms: bound.rtt_ms,
    };
    (check, round1(radius))
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;

    const MUMBAI: (f64, f64) = (19.076, 72.8777);
    const LONDON: (f64, f64) = (51.5072, -0.1276);
    const US_CENTROID: (f64, f64) = (37.751, -97.822);
    const PUNE: (f64, f64) = (18.5204, 73.8567);

    fn reference(radius_km: f64, rtt_ms: f64) -> RttReference {
        RttReference {
            hop_index: 2,
            latitude: MUMBAI.0,
            longitude: MUMBAI.1,
            radius_km,
            rtt_ms,
        }
    }

    fn bound(rtt_ms: f64) -> RttBound {
        RttBound {
            hop_index: 5,
            rtt_ms,
        }
    }

    #[test]
    fn haversine_matches_known_distances() {
        let d = haversine_km(MUMBAI.0, MUMBAI.1, LONDON.0, LONDON.1);
        assert!((d - 7190.0).abs() < 30.0, "{d}");
        assert_eq!(haversine_km(10.0, 20.0, 10.0, 20.0), 0.0);
        // Antipodes: half the circumference.
        let half = haversine_km(0.0, 0.0, 0.0, 180.0);
        assert!((half - std::f64::consts::PI * EARTH_RADIUS_KM).abs() < 1e-6);
    }

    #[test]
    fn reach_is_half_the_rtt_at_fibre_speed() {
        assert_eq!(reach_km(1.0), 100.0);
        assert_eq!(reach_km(4.0), 400.0);
        assert_eq!(reach_km(0.0), 0.0);
    }

    #[test]
    fn max_distance_adds_both_reaches_the_reference_radius_and_slack() {
        // 2 ms to the reference (200 km), 4 ms to the hop (400 km), 40 km
        // reference radius, 100 km slack.
        assert_eq!(max_distance_km(&reference(40.0, 2.0), bound(4.0)), 740.0);
    }

    #[test]
    fn far_estimate_with_short_rtt_is_infeasible() {
        // 8.8.8.8 answers in 4 ms from Mumbai; GeoLite2 places it at the US
        // centroid (radius 1000 km, hard radius 2000 km), ~13,000 km away.
        let (result, radius) = check(
            US_CENTROID.0,
            US_CENTROID.1,
            1000.0,
            2000.0,
            &reference(40.0, 2.0),
            bound(4.0),
        );
        assert_eq!(result.verdict, RttVerdict::Infeasible);
        assert!(result.distance_km > 13_000.0, "{result:?}");
        assert_eq!(result.max_distance_km, 740.0);
        assert_eq!(radius, 1000.0, "an infeasible estimate keeps its radius");
        assert_eq!(result.bound_hop_index, 5);
        assert_eq!(result.reference_hop_index, 2);
    }

    #[test]
    fn plausible_far_estimate_is_feasible() {
        // London needs >= ~72 ms RTT from Mumbai; 120 ms is plausible.
        let (result, radius) = check(
            LONDON.0,
            LONDON.1,
            50.0,
            50.0,
            &reference(40.0, 2.0),
            bound(120.0),
        );
        assert_eq!(result.verdict, RttVerdict::Feasible);
        assert_eq!(radius, 50.0);
    }

    #[test]
    fn small_rtt_tightens_a_large_radius() {
        // A 500 km GeoLite2 city record in Pune (~120 km from Mumbai) and a
        // 1 ms bound: the hop is within 100 + 100 + 40 + 100 = 340 km of
        // Mumbai, so within ~460 km of Pune.
        let (result, radius) = check(
            PUNE.0,
            PUNE.1,
            500.0,
            1000.0,
            &reference(40.0, 1.0),
            bound(1.0),
        );
        assert_eq!(result.verdict, RttVerdict::Tightened);
        assert!(
            (radius - (result.distance_km + 340.0)).abs() < 0.2,
            "{radius}"
        );
        assert!(radius < 500.0);
        assert_eq!(result.original_radius_km, 500.0);
    }

    #[test]
    fn estimate_feasible_only_beyond_its_radius_is_widened() {
        // A Bangalore estimate (radius 100 km, hard 200 km) ~845 km from the
        // Mumbai reference, with a 740 km limit: the hop can only be in the
        // part of the hard disk that faces Mumbai, beyond the 100 km radius.
        const BANGALORE: (f64, f64) = (12.9716, 77.5946);
        let (result, radius) = check(
            BANGALORE.0,
            BANGALORE.1,
            100.0,
            200.0,
            &reference(40.0, 2.0),
            bound(4.0),
        );
        assert!(
            result.distance_km - result.max_distance_km > 100.0,
            "{result:?}"
        );
        assert!(result.distance_km - 200.0 <= result.max_distance_km);
        assert_eq!(result.verdict, RttVerdict::Widened);
        assert_eq!(radius, 200.0, "grows to the hard radius, never beyond");
    }

    #[test]
    fn verdict_boundary_is_inclusive_for_feasible() {
        // Exactly at the limit: distance - hard == max is still possible.
        let r = RttReference {
            hop_index: 1,
            latitude: 0.0,
            longitude: 0.0,
            radius_km: 0.0,
            rtt_ms: 0.0,
        };
        let distance = haversine_km(0.0, 0.0, 0.0, 10.0);
        let rtt = (distance - 50.0 - SLACK_KM) / 100.0;
        let (result, _) = check(0.0, 10.0, 50.0, 50.0, &r, bound(rtt + 1e-9));
        assert_ne!(result.verdict, RttVerdict::Infeasible, "{result:?}");
        let (result, _) = check(0.0, 10.0, 50.0, 50.0, &r, bound(rtt - 0.01));
        assert_eq!(result.verdict, RttVerdict::Infeasible);
    }
}
