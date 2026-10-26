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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::persistence::AppStore;

    /// MaxMind DB test files; source and licence in fixtures/geoip/README.md.
    fn fixture(name: &str) -> String {
        format!("{}/fixtures/geoip/{name}", env!("CARGO_MANIFEST_DIR"))
    }

    fn lookup(
        city_db: Option<String>,
        asn_db: Option<String>,
        ip: &str,
    ) -> (GeoLiteResult, SharedGeoReaders) {
        let mut store = AppStore::default();
        store.geo.city_db_path = city_db;
        store.geo.asn_db_path = asn_db;
        let store: SharedStore = Mutex::new(store);
        let readers = SharedGeoReaders::default();
        let result = lookup_geolite(ip.parse().unwrap(), &readers, &store);
        (result, readers)
    }

    #[test]
    fn city_record_decodes_with_accuracy_radius() {
        let city_db = Some(fixture("GeoLite2-City-Test.mmdb"));

        let (result, _) = lookup(city_db.clone(), None, "81.2.69.142");
        assert_eq!(
            result.geo,
            Some(GeoDetails {
                latitude: 51.5142,
                longitude: -0.0931,
                city: Some("London".into()),
                country: Some("United Kingdom".into()),
                iso_code: Some("GB".into()),
                confidence: Some(10.0),
            })
        );
        assert_eq!(
            result.status().message.as_deref(),
            Some("Resolved from local GeoLite2 databases.")
        );

        // An IPv6 network with a country and no city.
        let (result, _) = lookup(city_db, None, "2001:218::1");
        let geo = result.geo.expect("record for 2001:218::/32");
        assert_eq!((geo.latitude, geo.longitude), (35.68536, 139.75309));
        assert_eq!(geo.city, None);
        assert_eq!(geo.iso_code.as_deref(), Some("JP"));
        assert_eq!(geo.confidence, Some(100.0));
    }

    #[test]
    fn asn_record_decodes() {
        let asn_db = Some(fixture("GeoLite2-ASN-Test.mmdb"));
        for (ip, number, name) in [
            ("1.128.0.1", 1221, "Telstra Pty Ltd"),
            ("2600:6000::1", 237, "Merit Network Inc."),
        ] {
            let (result, _) = lookup(None, asn_db.clone(), ip);
            let asn = result.asn.expect(ip);
            assert_eq!(asn.asn, Some(number));
            assert_eq!(asn.name.as_deref(), Some(name));
        }
    }

    #[test]
    fn address_without_record_is_no_result() {
        let (result, readers) = lookup(
            Some(fixture("GeoLite2-City-Test.mmdb")),
            Some(fixture("GeoLite2-ASN-Test.mmdb")),
            "1.1.1.1",
        );
        assert_eq!(result.geo, None);
        assert_eq!(result.asn, None);
        assert!(result.databases_loaded);
        assert_eq!(result.status().status, ProviderState::Success);
        assert_eq!(
            result.status().message.as_deref(),
            Some("No GeoLite2 record for this address.")
        );
        let (city, asn, errors) = database_statuses(&readers);
        assert_eq!(city, GeoDatabaseStatus::Loaded);
        assert_eq!(asn, GeoDatabaseStatus::Loaded);
        assert!(errors.is_empty(), "{errors:?}");
    }

    #[test]
    fn file_that_is_not_a_database_is_a_load_error() {
        let path =
            std::env::temp_dir().join(format!("vistracer-not-mmdb-{}.mmdb", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"not a MaxMind database").unwrap();
        let (result, readers) = lookup(
            Some(path.to_string_lossy().into_owned()),
            Some(fixture("missing.mmdb")),
            "81.2.69.142",
        );
        std::fs::remove_file(&path).unwrap();

        assert!(!result.databases_loaded);
        assert_eq!(result.status().status, ProviderState::Skipped);
        let (city, asn, errors) = database_statuses(&readers);
        assert_eq!(city, GeoDatabaseStatus::Error);
        assert_eq!(asn, GeoDatabaseStatus::Error);
        assert_eq!(errors.len(), 2, "{errors:?}");
        assert!(
            errors[0].starts_with("City database: Failed to open database: "),
            "{errors:?}"
        );
        assert_eq!(errors[1], "ASN database: File not found");
    }

    #[test]
    fn damaged_record_is_no_result() {
        // The file opens, but its doubles have the wrong size, so the record
        // of this address does not decode.
        let (result, readers) = lookup(
            Some(fixture("GeoIP2-City-Test-Broken-Double-Format.mmdb")),
            None,
            "81.2.69.142",
        );
        assert_eq!(result.geo, None);
        assert!(result.databases_loaded);
        assert_eq!(database_statuses(&readers).0, GeoDatabaseStatus::Loaded);
    }

    #[test]
    fn accuracy_radius_reads_any_number_type() {
        // The decoder test record has one value of each MMDB type, with the
        // type as its key. Each value is read as an accuracy radius.
        #[derive(serde::Deserialize)]
        struct EveryType {
            #[serde(deserialize_with = "accuracy_radius_km")]
            array: Option<f64>,
            #[serde(deserialize_with = "accuracy_radius_km")]
            boolean: Option<f64>,
            #[serde(deserialize_with = "accuracy_radius_km")]
            bytes: Option<f64>,
            #[serde(deserialize_with = "accuracy_radius_km")]
            double: Option<f64>,
            #[serde(deserialize_with = "accuracy_radius_km")]
            float: Option<f64>,
            #[serde(deserialize_with = "accuracy_radius_km")]
            int32: Option<f64>,
            #[serde(deserialize_with = "accuracy_radius_km")]
            map: Option<f64>,
            #[serde(deserialize_with = "accuracy_radius_km")]
            uint16: Option<f64>,
            #[serde(deserialize_with = "accuracy_radius_km")]
            uint32: Option<f64>,
            #[serde(deserialize_with = "accuracy_radius_km")]
            uint64: Option<f64>,
            #[serde(deserialize_with = "accuracy_radius_km")]
            uint128: Option<f64>,
            #[serde(deserialize_with = "accuracy_radius_km")]
            utf8_string: Option<f64>,
        }

        let reader = load_reader(&fixture("MaxMind-DB-test-decoder.mmdb")).unwrap();
        let record: EveryType =
            decode_record(&reader, "1.1.1.1".parse().unwrap(), "test").expect("record");

        assert_eq!(record.uint16, Some(100.0));
        assert_eq!(record.uint32, Some(268_435_456.0));
        assert_eq!(record.uint64, Some(2f64.powi(60)));
        assert_eq!(record.uint128, Some(2f64.powi(120)));
        assert_eq!(record.double, Some(42.123456));
        assert_eq!(record.float, Some(f64::from(1.1f32)));
        // -268435456: a negative radius means nothing.
        assert_eq!(record.int32, None);
        for (key, value) in [
            ("array", record.array),
            ("boolean", record.boolean),
            ("bytes", record.bytes),
            ("map", record.map),
            ("utf8_string", record.utf8_string),
        ] {
            assert_eq!(value, None, "{key}");
        }
    }
}
