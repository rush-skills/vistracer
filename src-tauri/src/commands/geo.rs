use crate::commands::persistence::{GeoCacheValue, SharedStore};
use crate::net::is_private_ip;
use crate::types::*;
use maxminddb::Reader;
use std::net::IpAddr;
use std::path::Path;
use std::sync::Mutex;

pub struct GeoReaders {
    pub city_reader: Option<Reader<Vec<u8>>>,
    pub asn_reader: Option<Reader<Vec<u8>>>,
    pub city_db_status: String,
    pub asn_db_status: String,
    pub status_message: Option<String>,
}

impl Default for GeoReaders {
    fn default() -> Self {
        Self {
            city_reader: None,
            asn_reader: None,
            city_db_status: "missing".to_string(),
            asn_db_status: "missing".to_string(),
            status_message: None,
        }
    }
}

pub type SharedGeoReaders = Mutex<GeoReaders>;

pub fn load_reader(path: &str) -> Result<Reader<Vec<u8>>, String> {
    if !Path::new(path).exists() {
        return Err("File not found".to_string());
    }
    Reader::open_readfile(path).map_err(|e| format!("Failed to open database: {}", e))
}

pub fn ensure_readers(readers: &SharedGeoReaders, store: &SharedStore) {
    let store_guard = store.lock().unwrap();
    let city_path = store_guard.geo.city_db_path.clone();
    let asn_path = store_guard.geo.asn_db_path.clone();
    drop(store_guard);

    let mut guard = readers.lock().unwrap();

    if guard.city_reader.is_none() {
        if let Some(ref path) = city_path {
            match load_reader(path) {
                Ok(reader) => {
                    guard.city_reader = Some(reader);
                    guard.city_db_status = "loaded".to_string();
                }
                Err(e) => {
                    log::warn!("Failed to load city database at {}: {}", path, e);
                    guard.city_db_status = "error".to_string();
                    guard.status_message = Some(e);
                }
            }
        }
    }

    if guard.asn_reader.is_none() {
        if let Some(ref path) = asn_path {
            match load_reader(path) {
                Ok(reader) => {
                    guard.asn_reader = Some(reader);
                    guard.asn_db_status = "loaded".to_string();
                }
                Err(e) => {
                    log::warn!("Failed to load ASN database at {}: {}", path, e);
                    guard.asn_db_status = "error".to_string();
                    guard.status_message = Some(e);
                }
            }
        }
    }
}

pub fn reload_geo_databases(readers: &SharedGeoReaders, store: &SharedStore) {
    {
        let mut guard = readers.lock().unwrap();
        guard.city_reader = None;
        guard.asn_reader = None;
        guard.city_db_status = "missing".to_string();
        guard.asn_db_status = "missing".to_string();
        guard.status_message = None;
    }
    ensure_readers(readers, store);
}

#[derive(Debug, Clone)]
pub struct GeoLookupResult {
    pub geo: Option<GeoDetails>,
    pub asn: Option<AsnDetails>,
    pub providers: Vec<ProviderStatus>,
    pub peering_db: Option<PeeringDbDetails>,
}

pub fn lookup_geo(
    ip: &str,
    force_refresh: bool,
    store: &SharedStore,
    readers: &SharedGeoReaders,
) -> Option<GeoLookupResult> {
    if ip.is_empty() || is_private_ip(ip) {
        let providers = vec![
            provider_skipped("maxmind", "Private IP address."),
            provider_skipped("team-cymru", "Private IP address."),
            provider_skipped("rdap", "Private IP address."),
            provider_skipped("ripe-stat", "Private IP address."),
            provider_skipped("peeringdb", "Private IP address."),
        ];
        return Some(GeoLookupResult {
            geo: None,
            asn: None,
            providers,
            peering_db: None,
        });
    }

    // Check cache
    if !force_refresh {
        let guard = store.lock().unwrap();
        if let Some(cached) = guard.get_cached_geo(ip) {
            let geo = if cached.latitude.is_some() && cached.longitude.is_some() {
                Some(GeoDetails {
                    latitude: cached.latitude.unwrap(),
                    longitude: cached.longitude.unwrap(),
                    city: cached.city.clone(),
                    country: cached.country.clone(),
                    iso_code: cached.iso_code.clone(),
                    confidence: cached.confidence,
                })
            } else {
                None
            };

            let asn = cached.asn.map(|asn_num| AsnDetails {
                asn: Some(asn_num),
                name: cached.asn_name.clone(),
                network: cached.network.clone(),
                country: cached.asn_country.clone(),
                registry: cached.asn_registry.clone(),
            });

            return Some(GeoLookupResult {
                geo,
                asn,
                providers: cached.providers.clone().unwrap_or_default(),
                peering_db: cached.peering_db.clone(),
            });
        }
    }

    ensure_readers(readers, store);

    let ip_addr: IpAddr = ip.parse().ok()?;
    let reader_guard = readers.lock().unwrap();

    // City lookup
    let geo = reader_guard.city_reader.as_ref().and_then(|reader| {
        #[derive(serde::Deserialize)]
        struct CityRecord {
            location: Option<Location>,
            city: Option<City>,
            country: Option<Country>,
        }
        #[derive(serde::Deserialize)]
        struct Location {
            latitude: Option<f64>,
            longitude: Option<f64>,
            accuracy_radius: Option<f64>,
        }
        #[derive(serde::Deserialize)]
        struct City {
            names: Option<std::collections::HashMap<String, String>>,
        }
        #[derive(serde::Deserialize)]
        struct Country {
            names: Option<std::collections::HashMap<String, String>>,
            iso_code: Option<String>,
        }

        match reader.lookup::<CityRecord>(ip_addr) {
            Ok(record) => {
                let lat = record.location.as_ref().and_then(|l| l.latitude)?;
                let lon = record.location.as_ref().and_then(|l| l.longitude)?;
                Some(GeoDetails {
                    latitude: lat,
                    longitude: lon,
                    city: record
                        .city
                        .and_then(|c| c.names.and_then(|n| n.get("en").cloned())),
                    country: record
                        .country
                        .as_ref()
                        .and_then(|c| c.names.as_ref().and_then(|n| n.get("en").cloned())),
                    iso_code: record
                        .country
                        .and_then(|c| c.iso_code),
                    confidence: record
                        .location
                        .and_then(|l| l.accuracy_radius),
                })
            }
            Err(e) => {
                log::warn!("Geo lookup failed for {}: {}", ip, e);
                None
            }
        }
    });

    // ASN lookup
    let asn = reader_guard.asn_reader.as_ref().and_then(|reader| {
        #[derive(serde::Deserialize)]
        struct AsnRecord {
            autonomous_system_number: Option<u32>,
            autonomous_system_organization: Option<String>,
        }

        match reader.lookup::<AsnRecord>(ip_addr) {
            Ok(record) => Some(AsnDetails {
                asn: record.autonomous_system_number,
                name: record.autonomous_system_organization,
                network: None,
                country: None,
                registry: None,
            }),
            Err(e) => {
                log::warn!("ASN lookup failed for {}: {}", ip, e);
                None
            }
        }
    });

    drop(reader_guard);

    let providers = vec![provider_skipped("maxmind", "Resolved locally via GeoLite2.")];

    let result = GeoLookupResult {
        geo: geo.clone(),
        asn: asn.clone(),
        providers,
        peering_db: None,
    };

    // Cache the result
    if geo.is_some() || asn.is_some() {
        let mut guard = store.lock().unwrap();
        guard.set_cached_geo(
            ip,
            GeoCacheValue {
                latitude: geo.as_ref().map(|g| g.latitude),
                longitude: geo.as_ref().map(|g| g.longitude),
                city: geo.as_ref().and_then(|g| g.city.clone()),
                country: geo.as_ref().and_then(|g| g.country.clone()),
                iso_code: geo.as_ref().and_then(|g| g.iso_code.clone()),
                confidence: geo.as_ref().and_then(|g| g.confidence),
                asn: asn.as_ref().and_then(|a| a.asn),
                asn_name: asn.as_ref().and_then(|a| a.name.clone()),
                network: asn.as_ref().and_then(|a| a.network.clone()),
                asn_country: asn.as_ref().and_then(|a| a.country.clone()),
                asn_registry: asn.as_ref().and_then(|a| a.registry.clone()),
                providers: Some(result.providers.clone()),
                peering_db: None,
            },
        );
    }

    Some(result)
}

fn provider_skipped(provider: &str, message: &str) -> ProviderStatus {
    ProviderStatus {
        provider: provider.to_string(),
        status: "skipped".to_string(),
        message: Some(message.to_string()),
        details: None,
    }
}
