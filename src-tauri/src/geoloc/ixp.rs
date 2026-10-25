//! PeeringDB exchange (IX) peering LANs.
//!
//! An address on an IX peering LAN belongs to a router port inside one of
//! the IX facilities, so the IX location is a good location for the hop.
//! The dataset joins five PeeringDB objects: `ixpfx` (prefix) -> `ixlan`
//! -> `ix` (name, city), and `ixfac` -> `fac` (coordinates). The IX
//! position is the centre of its facilities; the radius covers all of them.
//! The exchanges and facilities with a position are also the sites of the
//! globe's exchange and data centre layers (`IxIndex::sites`).

use super::places::{self, CITY_NAMES};
use super::prefix::{IpPrefix, PrefixTable};
use super::rtt::haversine_km;
use crate::types::{ExchangeSite, FacilitySite, IxpMatch, PeeringDbSites};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::net::IpAddr;

/// Radius for an IX in a single building or campus.
pub const IX_MIN_RADIUS_KM: f64 = 25.0;
/// Radius for an IX placed by its city name (no facility coordinates).
const IX_CITY_RADIUS_KM: f64 = 50.0;
/// IX LANs are never larger than this; shorter prefixes in the data are
/// treated as errors so they cannot claim large parts of the Internet.
const MIN_V4_LEN: u8 = 16;
const MIN_V6_LEN: u8 = 32;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IxPosition {
    pub latitude: f64,
    pub longitude: f64,
    pub radius_km: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IxExchange {
    pub id: u64,
    pub name: String,
    pub city: Option<String>,
    pub country: Option<String>,
    pub position: Option<IxPosition>,
    pub facility_count: u32,
    /// Networks connected to the exchange (PeeringDB `net_count`).
    #[serde(default)]
    pub network_count: u32,
}

/// A PeeringDB facility (data centre) with coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IxFacility {
    pub id: u64,
    pub name: String,
    pub org: Option<String>,
    pub city: Option<String>,
    pub country: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    pub network_count: u32,
    pub exchange_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IxLanPrefix {
    pub prefix: String,
    pub ix_id: u64,
}

/// The dataset layout `build_dataset` writes. A cached dataset with a lower
/// version (saved before facilities were kept) is refreshed like an
/// expired one, and used meanwhile.
pub const IX_DATASET_VERSION: u32 = 2;

/// The joined PeeringDB data, small enough to keep in the provider cache.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IxDataset {
    #[serde(default)]
    pub version: u32,
    pub exchanges: Vec<IxExchange>,
    pub prefixes: Vec<IxLanPrefix>,
    #[serde(default)]
    pub facilities: Vec<IxFacility>,
}

/// The five PeeringDB list responses that make up the dataset.
pub struct IxResponses {
    pub ixpfx: Value,
    pub ixlan: Value,
    pub ix: Value,
    pub ixfac: Value,
    pub fac: Value,
}

#[derive(Deserialize)]
struct IxpfxRow {
    ixlan_id: u64,
    prefix: String,
}

#[derive(Deserialize)]
struct IxlanRow {
    id: u64,
    ix_id: u64,
}

#[derive(Deserialize)]
struct IxRow {
    id: u64,
    name: String,
    city: Option<String>,
    country: Option<String>,
    net_count: Option<u32>,
}

#[derive(Deserialize)]
struct IxfacRow {
    ix_id: u64,
    fac_id: u64,
}

#[derive(Deserialize)]
struct FacRow {
    id: u64,
    name: Option<String>,
    org_name: Option<String>,
    city: Option<String>,
    country: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    net_count: Option<u32>,
    ix_count: Option<u32>,
}

fn valid_coordinates(latitude: Option<f64>, longitude: Option<f64>) -> Option<(f64, f64)> {
    let (lat, lon) = (latitude?, longitude?);
    let valid = lat.is_finite()
        && lon.is_finite()
        && (-90.0..=90.0).contains(&lat)
        && (-180.0..=180.0).contains(&lon)
        && (lat, lon) != (0.0, 0.0);
    valid.then_some((lat, lon))
}

/// Rows that do not have the expected shape are skipped, not fatal: one
/// bad record must not hide every IX.
fn rows<T: for<'de> Deserialize<'de>>(body: &Value, object: &str) -> Result<Vec<T>, String> {
    let data = body
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("PeeringDB {object} response has no data list"))?;
    Ok(data
        .iter()
        .filter_map(|row| serde_json::from_value(row.clone()).ok())
        .collect())
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Centre of the points (mean of unit vectors, so it also works across
/// the antimeridian) and the distance to the furthest point.
fn centre(points: &[(f64, f64)]) -> Option<IxPosition> {
    if points.is_empty() {
        return None;
    }
    let (mut x, mut y, mut z) = (0.0, 0.0, 0.0);
    for (lat, lon) in points {
        let (phi, lambda) = (lat.to_radians(), lon.to_radians());
        x += phi.cos() * lambda.cos();
        y += phi.cos() * lambda.sin();
        z += phi.sin();
    }
    let latitude = z.atan2((x * x + y * y).sqrt()).to_degrees();
    let longitude = y.atan2(x).to_degrees();
    let spread = points
        .iter()
        .map(|(lat, lon)| haversine_km(latitude, longitude, *lat, *lon))
        .fold(0.0, f64::max);
    Some(IxPosition {
        latitude,
        longitude,
        radius_km: (spread.round()).max(IX_MIN_RADIUS_KM),
    })
}

fn city_position(city: Option<&str>) -> Option<IxPosition> {
    let key: String = city?
        .chars()
        .filter(char::is_ascii_alphabetic)
        .collect::<String>()
        .to_ascii_lowercase();
    let place = places::lookup(CITY_NAMES, &key)?;
    let airport = places::airport(place.iata)?;
    Some(IxPosition {
        latitude: airport.latitude,
        longitude: airport.longitude,
        radius_km: IX_CITY_RADIUS_KM,
    })
}

fn valid_ix_prefix(prefix: &IpPrefix) -> bool {
    match prefix {
        IpPrefix::V4 { len, .. } => *len >= MIN_V4_LEN,
        IpPrefix::V6 { len, .. } => *len >= MIN_V6_LEN,
    }
}

/// Joins the PeeringDB responses into the cached dataset.
pub fn build_dataset(responses: &IxResponses) -> Result<IxDataset, String> {
    let ixlan_to_ix: HashMap<u64, u64> = rows::<IxlanRow>(&responses.ixlan, "ixlan")?
        .into_iter()
        .map(|row| (row.id, row.ix_id))
        .collect();
    let mut fac_coords: HashMap<u64, (f64, f64)> = HashMap::new();
    let mut facilities = Vec::new();
    for row in rows::<FacRow>(&responses.fac, "fac")? {
        let Some((latitude, longitude)) = valid_coordinates(row.latitude, row.longitude) else {
            continue;
        };
        fac_coords.insert(row.id, (latitude, longitude));
        if let Some(name) = non_empty(row.name) {
            facilities.push(IxFacility {
                id: row.id,
                name,
                org: non_empty(row.org_name),
                city: non_empty(row.city),
                country: non_empty(row.country),
                latitude,
                longitude,
                network_count: row.net_count.unwrap_or(0),
                exchange_count: row.ix_count.unwrap_or(0),
            });
        }
    }
    facilities.sort_by_key(|facility| facility.id);
    let mut ix_facilities: HashMap<u64, Vec<(f64, f64)>> = HashMap::new();
    for row in rows::<IxfacRow>(&responses.ixfac, "ixfac")? {
        if let Some(coords) = fac_coords.get(&row.fac_id) {
            ix_facilities.entry(row.ix_id).or_default().push(*coords);
        }
    }

    let exchanges: Vec<IxExchange> = rows::<IxRow>(&responses.ix, "ix")?
        .into_iter()
        .map(|row| {
            let city = non_empty(row.city);
            let facilities = ix_facilities.remove(&row.id).unwrap_or_default();
            let position = centre(&facilities).or_else(|| city_position(city.as_deref()));
            IxExchange {
                id: row.id,
                name: row.name.trim().to_string(),
                city,
                country: non_empty(row.country),
                position,
                facility_count: u32::try_from(facilities.len()).unwrap_or(u32::MAX),
                network_count: row.net_count.unwrap_or(0),
            }
        })
        .filter(|ix| !ix.name.is_empty())
        .collect();

    let mut prefixes: Vec<IxLanPrefix> = rows::<IxpfxRow>(&responses.ixpfx, "ixpfx")?
        .into_iter()
        .filter_map(|row| {
            let prefix = IpPrefix::parse(&row.prefix).filter(valid_ix_prefix)?;
            Some(IxLanPrefix {
                prefix: prefix.to_string(),
                ix_id: *ixlan_to_ix.get(&row.ixlan_id)?,
            })
        })
        .collect();
    prefixes.sort_by(|a, b| a.prefix.cmp(&b.prefix));
    prefixes.dedup();

    if exchanges.is_empty() || prefixes.is_empty() {
        return Err("PeeringDB returned no IX peering LANs".to_string());
    }
    Ok(IxDataset {
        version: IX_DATASET_VERSION,
        exchanges,
        prefixes,
        facilities,
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct IxpHit {
    pub info: IxpMatch,
    pub position: Option<IxPosition>,
}

pub struct IxIndex {
    table: PrefixTable<usize>,
    exchanges: Vec<IxExchange>,
    facilities: Vec<IxFacility>,
    version: u32,
}

impl IxIndex {
    pub fn new(dataset: IxDataset) -> Self {
        let by_id: HashMap<u64, usize> = dataset
            .exchanges
            .iter()
            .enumerate()
            .map(|(index, ix)| (ix.id, index))
            .collect();
        let entries = dataset
            .prefixes
            .iter()
            .filter_map(|p| Some((IpPrefix::parse(&p.prefix)?, *by_id.get(&p.ix_id)?)))
            .collect();
        Self {
            table: PrefixTable::new(entries),
            exchanges: dataset.exchanges,
            facilities: dataset.facilities,
            version: dataset.version,
        }
    }

    /// False for a dataset saved by an older version, which lacks fields.
    pub fn is_current(&self) -> bool {
        self.version >= IX_DATASET_VERSION
    }

    /// Exchanges with a position, and facilities, for the globe layers.
    pub fn sites(&self, stored_at_ms: i64) -> PeeringDbSites {
        PeeringDbSites {
            stored_at: stored_at_ms,
            complete: self.is_current(),
            exchanges: self
                .exchanges
                .iter()
                .filter_map(|ix| {
                    let position = ix.position?;
                    Some(ExchangeSite {
                        id: ix.id,
                        name: ix.name.clone(),
                        city: ix.city.clone(),
                        country: ix.country.clone(),
                        latitude: position.latitude,
                        longitude: position.longitude,
                        radius_km: position.radius_km,
                        facility_count: ix.facility_count,
                        network_count: ix.network_count,
                    })
                })
                .collect(),
            facilities: self
                .facilities
                .iter()
                .map(|facility| FacilitySite {
                    id: facility.id,
                    name: facility.name.clone(),
                    org: facility.org.clone(),
                    city: facility.city.clone(),
                    country: facility.country.clone(),
                    latitude: facility.latitude,
                    longitude: facility.longitude,
                    network_count: facility.network_count,
                    exchange_count: facility.exchange_count,
                })
                .collect(),
        }
    }

    pub fn prefix_count(&self) -> usize {
        self.table.len()
    }

    pub fn lookup(&self, ip: IpAddr) -> Option<IxpHit> {
        let (prefix, index) = self.table.lookup(ip)?;
        let ix = &self.exchanges[*index];
        Some(IxpHit {
            info: IxpMatch {
                ix_id: ix.id,
                name: ix.name.clone(),
                city: ix.city.clone(),
                country: ix.country.clone(),
                prefix: prefix.to_string(),
                facility_count: ix.facility_count,
            },
            position: ix.position,
        })
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let text = match name {
            "ixpfx" => include_str!("../../fixtures/providers/peeringdb-ix/ixpfx.json"),
            "ixlan" => include_str!("../../fixtures/providers/peeringdb-ix/ixlan.json"),
            "ix" => include_str!("../../fixtures/providers/peeringdb-ix/ix.json"),
            "ixfac" => include_str!("../../fixtures/providers/peeringdb-ix/ixfac.json"),
            "fac" => include_str!("../../fixtures/providers/peeringdb-ix/fac.json"),
            _ => unreachable!(),
        };
        serde_json::from_str(text).unwrap()
    }

    /// Real PeeringDB rows for DE-CIX Frankfurt (ix 31) and AMS-IX (ix 26).
    pub fn real_responses() -> IxResponses {
        IxResponses {
            ixpfx: fixture("ixpfx"),
            ixlan: fixture("ixlan"),
            ix: fixture("ix"),
            ixfac: fixture("ixfac"),
            fac: fixture("fac"),
        }
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn real_peeringdb_rows_join_into_exchanges_with_positions() {
        let dataset = build_dataset(&real_responses()).unwrap();
        assert_eq!(dataset.prefixes.len(), 4);
        let decix = dataset.exchanges.iter().find(|ix| ix.id == 31).unwrap();
        assert_eq!(decix.name, "DE-CIX Frankfurt");
        assert_eq!(decix.country.as_deref(), Some("DE"));
        let position = decix.position.unwrap();
        // Most facilities are in Frankfurt; one is in Karlsruhe, ~120 km
        // away, and the radius covers it.
        assert!(
            haversine_km(position.latitude, position.longitude, 50.11, 8.68) < 30.0,
            "{position:?}"
        );
        assert!(
            position.radius_km > 100.0 && position.radius_km < 150.0,
            "{position:?}"
        );
        let amsix = dataset.exchanges.iter().find(|ix| ix.id == 26).unwrap();
        assert!(amsix.position.unwrap().radius_km < 50.0, "{amsix:?}");
        assert!(decix.facility_count > 10);
    }

    #[test]
    fn index_matches_v4_and_v6_peering_lans() {
        let index = IxIndex::new(build_dataset(&real_responses()).unwrap());
        assert_eq!(index.prefix_count(), 4);

        let v4 = index.lookup(ip("80.81.194.152")).unwrap();
        assert_eq!(v4.info.name, "DE-CIX Frankfurt");
        assert_eq!(v4.info.prefix, "80.81.192.0/21");
        let v6 = index.lookup(ip("2001:7f8:1::a500:1200:1")).unwrap();
        assert_eq!(v6.info.name, "AMS-IX");
        assert_eq!(v6.info.prefix, "2001:7f8:1::/64");

        // Last address of the /21 and the first one after it.
        assert!(index.lookup(ip("80.249.215.255")).is_some());
        assert!(index.lookup(ip("80.249.216.0")).is_none());
        assert!(index.lookup(ip("8.8.8.8")).is_none());
    }

    #[test]
    fn bad_rows_are_skipped_and_huge_prefixes_rejected() {
        let mut responses = real_responses();
        responses.ixpfx = serde_json::json!({"data": [
            {"ixlan_id": 31, "prefix": "80.81.192.0/21"},
            {"ixlan_id": 31, "prefix": "0.0.0.0/0"},
            {"ixlan_id": 31, "prefix": "2000::/3"},
            {"ixlan_id": 999, "prefix": "185.1.0.0/24"},
            {"ixlan_id": 31, "prefix": "not a prefix"},
            {"prefix": "185.2.0.0/24"}
        ]});
        responses.fac = serde_json::json!({"data": [
            {"id": 58, "latitude": null, "longitude": null},
            {"id": 59, "latitude": 0.0, "longitude": 0.0}
        ]});
        let dataset = build_dataset(&responses).unwrap();
        assert_eq!(dataset.prefixes.len(), 1, "{:?}", dataset.prefixes);
        // No usable facility coordinates: fall back to the IX city.
        let decix = dataset.exchanges.iter().find(|ix| ix.id == 31).unwrap();
        assert_eq!(decix.facility_count, 0);
        let position = decix.position.unwrap();
        assert_eq!(position.radius_km, IX_CITY_RADIUS_KM);
        assert!(haversine_km(position.latitude, position.longitude, 50.03, 8.57) < 1.0);
    }

    #[test]
    fn empty_or_malformed_responses_are_errors() {
        let mut responses = real_responses();
        responses.ixpfx = serde_json::json!({"data": []});
        assert!(build_dataset(&responses).is_err());
        let mut responses = real_responses();
        responses.ix = serde_json::json!({"error": "throttled"});
        assert!(build_dataset(&responses)
            .unwrap_err()
            .contains("ix response has no data"));
    }

    #[test]
    fn facilities_keep_the_fields_the_globe_shows() {
        let dataset = build_dataset(&real_responses()).unwrap();
        assert_eq!(dataset.version, IX_DATASET_VERSION);
        let fac = dataset.facilities.iter().find(|fac| fac.id == 58).unwrap();
        assert_eq!(fac.name, "Digital Realty Frankfurt FRA1-27");
        assert_eq!(fac.org.as_deref(), Some("Digital Realty"));
        assert_eq!(fac.city.as_deref(), Some("Frankfurt"));
        assert_eq!((fac.network_count, fac.exchange_count), (618, 31));
        let sites = IxIndex::new(dataset).sites(7);
        assert_eq!(sites.stored_at, 7);
        assert!(sites.complete);
        assert_eq!(sites.exchanges.len(), 2);
        assert_eq!(sites.facilities.len(), 41);
    }

    #[test]
    fn facilities_without_a_name_or_coordinates_are_left_out() {
        let mut responses = real_responses();
        responses.fac = serde_json::json!({"data": [
            {"id": 58, "name": "Named", "latitude": 50.12, "longitude": 8.73},
            {"id": 59, "name": " ", "latitude": 50.10, "longitude": 8.63},
            {"id": 60, "name": "No place", "latitude": null, "longitude": 8.63},
            {"id": 61, "name": "Null island", "latitude": 0.0, "longitude": 0.0},
            {"id": 62, "name": "Off the globe", "latitude": 91.0, "longitude": 4.95},
            {"id": "63", "name": "Bad id", "latitude": 52.35, "longitude": 4.95}
        ]});
        let dataset = build_dataset(&responses).unwrap();
        let names: Vec<&str> = dataset.facilities.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["Named"]);
        // An unnamed facility still places the exchanges it hosts.
        let decix = dataset.exchanges.iter().find(|ix| ix.id == 31).unwrap();
        assert_eq!(decix.facility_count, 2);
        assert_eq!(
            (
                dataset.facilities[0].network_count,
                dataset.facilities[0].org.clone()
            ),
            (0, None)
        );
    }

    #[test]
    fn a_dataset_saved_by_the_previous_version_still_loads() {
        let saved = serde_json::json!({
            "exchanges": [{"id": 31, "name": "DE-CIX Frankfurt", "city": "Frankfurt",
                "country": "DE", "position": {"latitude": 50.1, "longitude": 8.7, "radiusKm": 25.0},
                "facilityCount": 3}],
            "prefixes": [{"prefix": "80.81.192.0/21", "ixId": 31}]
        });
        let dataset: IxDataset = serde_json::from_value(saved).unwrap();
        assert_eq!(
            (dataset.version, dataset.exchanges[0].network_count),
            (0, 0)
        );
        let index = IxIndex::new(dataset);
        assert!(!index.is_current());
        let sites = index.sites(0);
        assert!(!sites.complete && sites.facilities.is_empty());
        assert_eq!(sites.exchanges[0].radius_km, 25.0);
    }

    #[test]
    fn centre_handles_the_antimeridian() {
        let position = centre(&[(0.0, 179.9), (0.0, -179.9)]).unwrap();
        assert!(position.longitude.abs() > 179.0, "{position:?}");
        assert!(position.radius_km < 30.0);
    }
}
