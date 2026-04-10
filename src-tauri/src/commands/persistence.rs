use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::types::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoSettings {
    #[serde(rename = "cityDbPath")]
    pub city_db_path: Option<String>,
    #[serde(rename = "asnDbPath")]
    pub asn_db_path: Option<String>,
    #[serde(rename = "lastUpdated")]
    pub last_updated: Option<f64>,
}

impl Default for GeoSettings {
    fn default() -> Self {
        Self {
            city_db_path: None,
            asn_db_path: None,
            last_updated: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnboardingPreferences {
    #[serde(rename = "skipOnLaunch")]
    pub skip_on_launch: Option<bool>,
    #[serde(rename = "lastCompletedAt")]
    pub last_completed_at: Option<f64>,
    #[serde(rename = "lastDismissedAt")]
    pub last_dismissed_at: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preferences {
    #[serde(rename = "reducedMotion")]
    pub reduced_motion: Option<bool>,
    #[serde(rename = "highContrast")]
    pub high_contrast: Option<bool>,
    pub onboarding: Option<OnboardingPreferences>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheSettings {
    #[serde(rename = "dnsTtlMs")]
    pub dns_ttl_ms: u64,
    #[serde(rename = "geoTtlMs")]
    pub geo_ttl_ms: u64,
}

impl Default for CacheSettings {
    fn default() -> Self {
        Self {
            dns_ttl_ms: 86_400_000,  // 24h
            geo_ttl_ms: 604_800_000, // 7d
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrationSettings {
    #[serde(rename = "teamCymru")]
    pub team_cymru: TeamCymruSettings,
    pub rdap: RdapSettings,
    #[serde(rename = "ripeStat")]
    pub ripe_stat: RipeStatSettings,
    #[serde(rename = "peeringDb")]
    pub peering_db: PeeringDbSettings,
}

impl Default for IntegrationSettings {
    fn default() -> Self {
        Self {
            team_cymru: TeamCymruSettings { enabled: true },
            rdap: RdapSettings {
                enabled: true,
                base_url: Some("https://rdap.org/ip".to_string()),
            },
            ripe_stat: RipeStatSettings {
                enabled: true,
                source_app: "VisTracer".to_string(),
            },
            peering_db: PeeringDbSettings {
                enabled: false,
                api_key: None,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamCymruSettings {
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RdapSettings {
    pub enabled: bool,
    #[serde(rename = "baseUrl")]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RipeStatSettings {
    pub enabled: bool,
    #[serde(rename = "sourceApp")]
    pub source_app: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeeringDbSettings {
    pub enabled: bool,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DnsCacheEntry {
    pub value: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoCacheValue {
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
    pub city: Option<String>,
    pub country: Option<String>,
    #[serde(rename = "isoCode")]
    pub iso_code: Option<String>,
    pub confidence: Option<f64>,
    pub asn: Option<u32>,
    #[serde(rename = "asnName")]
    pub asn_name: Option<String>,
    pub network: Option<String>,
    #[serde(rename = "asnCountry")]
    pub asn_country: Option<String>,
    #[serde(rename = "asnRegistry")]
    pub asn_registry: Option<String>,
    pub providers: Option<Vec<ProviderStatus>>,
    #[serde(rename = "peeringDb")]
    pub peering_db: Option<PeeringDbDetails>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoCacheEntry {
    pub value: GeoCacheValue,
    #[serde(rename = "expiresAt")]
    pub expires_at: f64,
}

/// In-memory store for settings, cache, and runs.
/// This replaces electron-store with a simple in-memory HashMap
/// that persists to the tauri-plugin-store on changes.
pub struct AppStore {
    pub geo: GeoSettings,
    pub preferences: Preferences,
    pub cache_settings: CacheSettings,
    pub integrations: IntegrationSettings,
    pub dns_cache: HashMap<String, DnsCacheEntry>,
    pub geo_cache: HashMap<String, GeoCacheEntry>,
    pub runs: Vec<TracerouteRun>,
}

impl Default for AppStore {
    fn default() -> Self {
        Self {
            geo: GeoSettings::default(),
            preferences: Preferences {
                reduced_motion: None,
                high_contrast: None,
                onboarding: Some(OnboardingPreferences {
                    skip_on_launch: None,
                    last_completed_at: None,
                    last_dismissed_at: None,
                }),
            },
            cache_settings: CacheSettings::default(),
            integrations: IntegrationSettings::default(),
            dns_cache: HashMap::new(),
            geo_cache: HashMap::new(),
            runs: Vec::new(),
        }
    }
}

impl AppStore {
    pub fn get_cached_dns(&self, host: &str) -> Option<String> {
        if let Some(entry) = self.dns_cache.get(host) {
            let now = chrono::Utc::now().timestamp_millis() as f64;
            if entry.expires_at > now {
                return Some(entry.value.clone());
            }
        }
        None
    }

    pub fn set_cached_dns(&mut self, host: &str, value: &str) {
        let now = chrono::Utc::now().timestamp_millis() as f64;
        self.dns_cache.insert(
            host.to_string(),
            DnsCacheEntry {
                value: value.to_string(),
                expires_at: now + self.cache_settings.dns_ttl_ms as f64,
            },
        );
    }

    pub fn get_cached_geo(&self, ip: &str) -> Option<&GeoCacheValue> {
        if let Some(entry) = self.geo_cache.get(ip) {
            let now = chrono::Utc::now().timestamp_millis() as f64;
            if entry.expires_at > now {
                return Some(&entry.value);
            }
        }
        None
    }

    pub fn set_cached_geo(&mut self, ip: &str, value: GeoCacheValue) {
        let now = chrono::Utc::now().timestamp_millis() as f64;
        self.geo_cache.insert(
            ip.to_string(),
            GeoCacheEntry {
                value,
                expires_at: now + self.cache_settings.geo_ttl_ms as f64,
            },
        );
    }

    pub fn get_recent_runs(&self, limit: usize) -> Vec<RecentRun> {
        let mut runs: Vec<RecentRun> = self
            .runs
            .iter()
            .map(|run| RecentRun {
                id: format!("{}{}", run.summary.target, run.summary.started_at as u64),
                started_at: run.summary.started_at,
                target: run.summary.target.clone(),
                protocol: run.request.protocol.clone(),
            })
            .collect();
        runs.sort_by(|a, b| b.started_at.partial_cmp(&a.started_at).unwrap_or(std::cmp::Ordering::Equal));
        runs.truncate(limit);
        runs
    }

    pub fn add_completed_run(&mut self, run: TracerouteRun) {
        self.runs.insert(0, run);
        if self.runs.len() > 10 {
            self.runs.truncate(10);
        }
    }
}

pub type SharedStore = Mutex<AppStore>;

pub fn ensure_app_data_dirs(app_data_dir: &PathBuf) {
    let dirs = vec![
        app_data_dir.join("geo"),
        app_data_dir.join("snapshots"),
        app_data_dir.join("databases"),
    ];
    for dir in dirs {
        if let Err(e) = std::fs::create_dir_all(&dir) {
            log::error!("Failed to create directory {:?}: {}", dir, e);
        }
    }
}

pub async fn configure_geo_database_defaults(store: &SharedStore, assets_dir: &PathBuf) {
    let city_asset_path = assets_dir.join("GeoLite2-City.mmdb");
    let asn_asset_path = assets_dir.join("GeoLite2-ASN.mmdb");

    let mut guard = store.lock().unwrap();
    let mut updated = guard.geo.last_updated;

    if city_asset_path.exists() {
        guard.geo.city_db_path = Some(city_asset_path.to_string_lossy().to_string());
        if let Ok(meta) = std::fs::metadata(&city_asset_path) {
            if let Ok(modified) = meta.modified() {
                let ms = modified
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as f64;
                updated = Some(updated.map_or(ms, |u: f64| u.max(ms)));
            }
        }
    }

    if asn_asset_path.exists() {
        guard.geo.asn_db_path = Some(asn_asset_path.to_string_lossy().to_string());
        if let Ok(meta) = std::fs::metadata(&asn_asset_path) {
            if let Ok(modified) = meta.modified() {
                let ms = modified
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as f64;
                updated = Some(updated.map_or(ms, |u: f64| u.max(ms)));
            }
        }
    }

    guard.geo.last_updated = updated;

    log::info!(
        "Geo database configuration: city={:?}, asn={:?}",
        guard.geo.city_db_path,
        guard.geo.asn_db_path
    );
}
