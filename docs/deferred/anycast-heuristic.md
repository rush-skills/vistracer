# Deferred: speed-of-light "suspected anycast" heuristic

Status: removed from the phase 1 PR (rush-skills/vistracer#1) on review. It
belongs to the geolocation-quality phase. This note keeps the code and the
tests so that phase can restore them. The code below is the version that
passed `cargo test` and `npm test` at commit `548eeb1`.

## What it did

No registry provider (Team Cymru, RDAP, RIPEstat, PeeringDB) flags anycast
prefixes, so the check used measured RTTs. Light in fibre covers about 100 km
per millisecond of round-trip time. The vantage point was the GeoLite2
location of the first public hop. When GeoLite2 placed a later hop further
from the vantage point than its minimum RTT allowed (plus both accuracy radii
and 100 km slack), the hop got `isAnycastSuspected: true`. Example: 8.8.8.8
answers in 4 ms from Mumbai while GeoLite2 places it at the US centroid
(about 13,000 km away).

The UI showed an "anycast?" tag in the hop row and a notice in the hop
details panel. Both said "suspected", because a wrong geolocation gives the
same signal.

## Open points for the geolocation-quality phase

- The vantage point is a guess (first public hop). A VPN or a far-away ISP
  edge moves it.
- GeoLite2 country-centroid records (radius about 1000 km) dominate the
  error budget; consider ignoring hops without a city.
- Decide if the flag should also lower the confidence shown for the hop
  location on the globe.

## How to restore

1. Add `src-tauri/src/commands/anycast.rs` (below) and `pub mod anycast;` in
   `src-tauri/src/commands/mod.rs`.
2. In `run_state.rs`: `use super::anycast::anycast_suspected;`, add
   `GeoDetails` to the `crate::types` import, add `primary_geo` and
   `vantage`, give `render_hop` a `vantage: Option<(u32, &GeoDetails)>`
   parameter, compute `is_anycast_suspected` as below, and in `hops()` call
   `let vantage = self.vantage();` and pass it to `render_hop`.
3. Restore the UI tag, notice and CSS, the tests, and the docs text.

## `src-tauri/src/commands/anycast.rs`

```rust
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
```

## `run_state.rs` additions

```rust
    fn primary_geo(&self, hop: &ParsedHop) -> Option<&GeoDetails> {
        let primary = hop.responders.first()?;
        if is_private_ip(&primary.ip) {
            return None;
        }
        self.results
            .get(&primary.ip)?
            .enrichment
            .as_ref()?
            .geo
            .as_ref()
    }

    /// The first public hop with a location. It stands in for the location
    /// of the machine running the trace.
    fn vantage(&self) -> Option<(u32, &GeoDetails)> {
        self.hops
            .values()
            .find_map(|hop| self.primary_geo(hop).map(|geo| (hop.hop_index, geo)))
    }
```

In `render_hop`, after `let geo = ...`:

```rust
        let is_anycast_suspected = match (vantage, geo.as_ref(), latency.min_rtt_ms) {
            (Some((vantage_index, vantage_geo)), Some(hop_geo), Some(min_rtt)) => {
                hop.hop_index > vantage_index && anycast_suspected(vantage_geo, hop_geo, min_rtt)
            }
            _ => false,
        };
```

Test (with its helper from the test module):

```rust
    fn geo(latitude: f64, longitude: f64, radius: f64) -> GeoDetails {
        GeoDetails {
            latitude,
            longitude,
            city: None,
            country: None,
            iso_code: None,
            confidence: Some(radius),
        }
    }

    #[test]
    fn anycast_is_flagged_relative_to_first_public_hop() {
        let mut state = RunState::new(1);
        let gateway = feed(&mut state, " 1  192.168.1.1  0.5 ms");
        let isp = feed(&mut state, " 2  49.44.1.1  3.0 ms");
        let anycast = feed(&mut state, " 3  8.8.8.8  4.0 ms");
        state.apply_lookup(
            &gateway[0],
            IpLookup {
                host_name: None,
                enrichment: None,
            },
        );
        // ISP edge in Mumbai, 8.8.8.8 geolocated to the US centroid.
        state.apply_lookup(&isp[0], enriched(Some(geo(19.076, 72.8777, 20.0)), 55836));
        state.apply_lookup(
            &anycast[0],
            enriched(Some(geo(37.751, -97.822, 1000.0)), 15169),
        );

        let hops = state.hops();
        assert!(
            !hops[1].is_anycast_suspected,
            "vantage hop itself is never flagged"
        );
        assert!(hops[2].is_anycast_suspected);
    }
```

## Renderer

`HopDetailsPane.tsx`, in the ASN cell after the `AS…` text:

```tsx
                            {hop.isAnycastSuspected && (
                              <span
                                className="hop-details__tag hop-details__tag--anycast"
                                title="RTT too short for the geolocated distance: likely anycast"
                              >
                                anycast?
                              </span>
                            )}
```

`HopInspector.tsx`, after the title:

```tsx
      {hop.isAnycastSuspected && (
        <p className="hop-inspector__notice">
          Suspected anycast: the measured RTT is too short for the distance to the GeoLite2
          location, so a closer replica answered (or the geolocation is wrong).
        </p>
      )}
```

`HopDetailsPane.css`:

```css
.hop-details__tag--anycast {
  background: rgba(171, 140, 255, 0.2);
}

.hop-inspector__notice {
  margin: 0 0 0.6rem;
  padding: 0.45rem 0.6rem;
  border-radius: 10px;
  background: rgba(171, 140, 255, 0.12);
  line-height: 1.45;
}
```

`HopDetailsPane.test.tsx` checked `screen.getByText("anycast?")` in the table
test and `details.getByText(/Suspected anycast/)` for a hop with
`isAnycastSuspected: true`.

## Docs text (docs/architecture.md)

The hop pipeline diagram labelled the edge back into `RunState` as
`"apply_lookup + anycast check"`, and this section followed the merge rules:

> No provider flags anycast prefixes. `commands/anycast.rs` uses a
> speed-of-light check instead: light in fibre covers about 100 km per
> millisecond of round-trip time. When GeoLite2 places a hop further from the
> vantage point (the first public hop with a location) than its minimum RTT
> allows, plus the accuracy radii and 100 km slack, the hop is marked
> `isAnycastSuspected`. The UI calls it "suspected": the cause can also be a
> wrong geolocation.
