use crate::commands::persistence::SharedStore;
use crate::types::*;
use maxminddb::{MaxMindDbError, Reader};
use serde::de::{self, DeserializeOwned, IgnoredAny, MapAccess, SeqAccess, Visitor};
use std::collections::HashMap;
use std::fmt;
use std::net::IpAddr;
use std::path::Path;
use std::sync::Mutex;

pub struct ReaderSlot {
    pub reader: Option<Reader<Vec<u8>>>,
    pub status: GeoDatabaseStatus,
    pub error: Option<String>,
}

impl Default for ReaderSlot {
    fn default() -> Self {
        Self {
            reader: None,
            status: GeoDatabaseStatus::Missing,
            error: None,
        }
    }
}

impl ReaderSlot {
    fn ensure_loaded(&mut self, path: Option<&str>, label: &str) {
        if self.reader.is_some() {
            return;
        }
        let Some(path) = path else {
            self.status = GeoDatabaseStatus::Missing;
            self.error = None;
            return;
        };
        match load_reader(path) {
            Ok(reader) => {
                self.reader = Some(reader);
                self.status = GeoDatabaseStatus::Loaded;
                self.error = None;
            }
            Err(e) => {
                log::warn!("Failed to load {label} database at {path}: {e}");
                self.status = GeoDatabaseStatus::Error;
                self.error = Some(format!("{label} database: {e}"));
            }
        }
    }
}

#[derive(Default)]
pub struct GeoReaders {
    pub city: ReaderSlot,
    pub asn: ReaderSlot,
}

pub type SharedGeoReaders = Mutex<GeoReaders>;

pub fn load_reader(path: &str) -> Result<Reader<Vec<u8>>, String> {
    if !Path::new(path).exists() {
        return Err("File not found".to_string());
    }
    Reader::open_readfile(path).map_err(|e| format!("Failed to open database: {}", e))
}

pub fn ensure_readers(readers: &SharedGeoReaders, store: &SharedStore) {
    let (city_path, asn_path) = {
        let guard = store.lock().unwrap_or_else(|e| e.into_inner());
        (
            guard.geo.city_db_path.clone(),
            guard.geo.asn_db_path.clone(),
        )
    };
    let mut guard = readers.lock().unwrap_or_else(|e| e.into_inner());
    guard.city.ensure_loaded(city_path.as_deref(), "City");
    guard.asn.ensure_loaded(asn_path.as_deref(), "ASN");
}

pub fn reload_geo_databases(readers: &SharedGeoReaders, store: &SharedStore) {
    {
        let mut guard = readers.lock().unwrap_or_else(|e| e.into_inner());
        *guard = GeoReaders::default();
    }
    ensure_readers(readers, store);
}

/// Load state of both databases, for the settings UI.
pub fn database_statuses(
    readers: &SharedGeoReaders,
) -> (GeoDatabaseStatus, GeoDatabaseStatus, Vec<String>) {
    let guard = readers.lock().unwrap_or_else(|e| e.into_inner());
    let errors = [&guard.city.error, &guard.asn.error]
        .into_iter()
        .flatten()
        .cloned()
        .collect();
    (guard.city.status, guard.asn.status, errors)
}

#[derive(Debug, Clone, PartialEq)]
pub struct GeoLiteResult {
    pub geo: Option<GeoDetails>,
    pub asn: Option<AsnDetails>,
    pub databases_loaded: bool,
}

impl GeoLiteResult {
    pub fn status(&self) -> ProviderStatus {
        if !self.databases_loaded {
            ProviderStatus::new(
                ProviderId::MaxMind,
                ProviderState::Skipped,
                "GeoLite2 databases are not configured.",
            )
        } else if self.geo.is_some() || self.asn.is_some() {
            ProviderStatus::new(
                ProviderId::MaxMind,
                ProviderState::Success,
                "Resolved from local GeoLite2 databases.",
            )
        } else {
            ProviderStatus::new(
                ProviderId::MaxMind,
                ProviderState::Success,
                "No GeoLite2 record for this address.",
            )
        }
    }
}

#[derive(serde::Deserialize)]
struct CityRecord {
    location: Option<Location>,
    city: Option<Names>,
    country: Option<Country>,
}

// maxminddb decodes typed fields strictly: an `f64` field accepts only an
// MMDB double, a `u32` only a uint32. These records use GeoLite2's types,
// which are also the types of the crate's own `geoip2` structs.
#[derive(serde::Deserialize)]
struct Location {
    latitude: Option<f64>,
    longitude: Option<f64>,
    #[serde(default, deserialize_with = "accuracy_radius_km")]
    accuracy_radius: Option<f64>,
}

/// Reads `accuracy_radius` from any MMDB number type. GeoLite2 stores it as a
/// uint16, but other writers can use another width, and a strict decode
/// would then fail the whole record. A value that is not a non-negative
/// number counts as missing.
fn accuracy_radius_km<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: de::Deserializer<'de>,
{
    struct Radius;

    impl<'de> Visitor<'de> for Radius {
        type Value = Option<f64>;

        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("an accuracy radius in kilometres")
        }

        fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
            Ok((v.is_finite() && v >= 0.0).then_some(v))
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            self.visit_f64(v as f64)
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            self.visit_f64(v as f64)
        }

        fn visit_u128<E: de::Error>(self, v: u128) -> Result<Self::Value, E> {
            self.visit_f64(v as f64)
        }

        fn visit_bool<E: de::Error>(self, _: bool) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_bytes<E: de::Error>(self, _: &[u8]) -> Result<Self::Value, E> {
            Ok(None)
        }

        // A container must be read to its end, or the decoder would read the
        // next field from the wrong place.
        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
            Ok(None)
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
            Ok(None)
        }
    }

    deserializer.deserialize_any(Radius)
}

#[derive(serde::Deserialize)]
struct Names {
    names: Option<HashMap<String, String>>,
}

#[derive(serde::Deserialize)]
struct Country {
    names: Option<HashMap<String, String>>,
    iso_code: Option<String>,
}

#[derive(serde::Deserialize)]
struct AsnRecord {
    autonomous_system_number: Option<u32>,
    autonomous_system_organization: Option<String>,
}

fn english(names: Option<HashMap<String, String>>) -> Option<String> {
    names.and_then(|mut n| n.remove("en"))
}

/// The record of `ip`, or `None` when the database has no record for it.
/// A record that does not decode means a damaged file or a file with another
/// layout, so it is logged as a warning, not at debug level.
fn decode_record<T: DeserializeOwned>(
    reader: &Reader<Vec<u8>>,
    ip: IpAddr,
    label: &str,
) -> Option<T> {
    match reader.lookup(ip).and_then(|result| result.decode::<T>()) {
        Ok(record) => record,
        // An IPv6 address in an IPv4-only database.
        Err(MaxMindDbError::InvalidInput { message }) => {
            log::debug!("GeoLite2 {label} lookup skipped for {ip}: {message}");
            None
        }
        Err(e) => {
            log::warn!(
                "GeoLite2 {label} record for {ip} does not decode: {e}. \
                 Download the database again or select another .mmdb file."
            );
            None
        }
    }
}

/// Looks the address up in the local GeoLite2 databases. This is a memory
/// lookup, so it runs inline and is not cached.
pub fn lookup_geolite(
    ip: IpAddr,
    readers: &SharedGeoReaders,
    store: &SharedStore,
) -> GeoLiteResult {
    ensure_readers(readers, store);
    let guard = readers.lock().unwrap_or_else(|e| e.into_inner());
    let databases_loaded = guard.city.reader.is_some() || guard.asn.reader.is_some();

    let geo = guard.city.reader.as_ref().and_then(|reader| {
        let record = decode_record::<CityRecord>(reader, ip, "City")?;
        let location = record.location?;
        Some(GeoDetails {
            latitude: location.latitude?,
            longitude: location.longitude?,
            city: record.city.and_then(|c| english(c.names)),
            country: record
                .country
                .as_ref()
                .and_then(|c| english(c.names.clone())),
            iso_code: record.country.and_then(|c| c.iso_code),
            confidence: location.accuracy_radius,
        })
    });

    let asn = guard.asn.reader.as_ref().and_then(|reader| {
        let record = decode_record::<AsnRecord>(reader, ip, "ASN")?;
        Some(AsnDetails {
            asn: record.autonomous_system_number,
            name: record.autonomous_system_organization,
            ..AsnDetails::default()
        })
    });

    GeoLiteResult {
        geo,
        asn,
        databases_loaded,
    }
}
