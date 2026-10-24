//! Speed-of-light check for anycast addresses.
//!
//! None of the registry providers flag anycast prefixes, so the check uses
//! measured RTTs instead. Light in fibre covers about 200 km per ms one way,
//! so a reply after `rtt` ms cannot come from more than `rtt * 100` km away.
//! When GeoLite2 places a hop further from the vantage point than that, the
//! answer came from a closer replica (anycast) or the geolocation is wrong.
//! The UI shows this as "suspected", never as a fact.

use crate::types::GeoDetails;

const FIBRE_KM_PER_RTT_MS: f64 = 100.0;
const EARTH_RADIUS_KM: f64 = 6371.0;
/// GeoLite2 omits the radius for some records; assume a metro-sized area.
const DEFAULT_ACCURACY_KM: f64 = 50.0;
/// Absorbs small coordinate and timing errors so that borderline hops are
/// not flagged.
const SLACK_KM: f64 = 100.0;

pub fn haversine_km(a: &GeoDetails, b: &GeoDetails) -> f64 {
    let (lat1, lat2) = (a.latitude.to_radians(), b.latitude.to_radians());
    let d_lat = lat2 - lat1;
    let d_lon = (b.longitude - a.longitude).to_radians();
    let h = (d_lat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (d_lon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_KM * h.sqrt().asin()
}

/// `vantage` is the geolocation of the first public hop, which stands in
/// for the location of the machine that runs the trace.
pub fn anycast_suspected(vantage: &GeoDetails, hop: &GeoDetails, min_rtt_ms: f64) -> bool {
    if !min_rtt_ms.is_finite() || min_rtt_ms <= 0.0 {
        return false;
    }
    let uncertainty = vantage.confidence.unwrap_or(DEFAULT_ACCURACY_KM)
        + hop.confidence.unwrap_or(DEFAULT_ACCURACY_KM)
        + SLACK_KM;
    let max_reach_km = min_rtt_ms * FIBRE_KM_PER_RTT_MS;
    haversine_km(vantage, hop) - uncertainty > max_reach_km
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geo(latitude: f64, longitude: f64, radius: Option<f64>) -> GeoDetails {
        GeoDetails {
            latitude,
            longitude,
            city: None,
            country: None,
            iso_code: None,
            confidence: radius,
        }
    }

    const MUMBAI: (f64, f64) = (19.076, 72.8777);
    const LONDON: (f64, f64) = (51.5072, -0.1276);
    const US_CENTROID: (f64, f64) = (37.751, -97.822);

    #[test]
    fn haversine_matches_known_distance() {
        let d = haversine_km(
            &geo(MUMBAI.0, MUMBAI.1, None),
            &geo(LONDON.0, LONDON.1, None),
        );
        assert!((d - 7190.0).abs() < 50.0, "{d}");
    }

    #[test]
    fn flags_reply_faster_than_light_allows() {
        // 8.8.8.8 answers in 4 ms from Mumbai, but GeoLite2 places it at the
        // US country centroid (radius 1000 km), about 13,000 km away.
        let vantage = geo(MUMBAI.0, MUMBAI.1, Some(20.0));
        let target = geo(US_CENTROID.0, US_CENTROID.1, Some(1000.0));
        assert!(anycast_suspected(&vantage, &target, 4.0));
    }

    #[test]
    fn does_not_flag_physically_possible_replies() {
        let vantage = geo(MUMBAI.0, MUMBAI.1, Some(20.0));
        let london = geo(LONDON.0, LONDON.1, Some(20.0));
        // 7190 km needs at least ~72 ms RTT; 120 ms is plausible.
        assert!(!anycast_suspected(&vantage, &london, 120.0));
        // A nearby hop is never flagged.
        assert!(!anycast_suspected(&vantage, &geo(19.2, 72.9, None), 1.0));
    }

    #[test]
    fn ignores_missing_or_invalid_rtt() {
        let vantage = geo(MUMBAI.0, MUMBAI.1, None);
        let far = geo(LONDON.0, LONDON.1, None);
        assert!(!anycast_suspected(&vantage, &far, 0.0));
        assert!(!anycast_suspected(&vantage, &far, f64::NAN));
    }
}
