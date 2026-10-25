use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::types::*;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GeoSettings {
    #[serde(rename = "cityDbPath")]
    pub city_db_path: Option<String>,
    #[serde(rename = "asnDbPath")]
    pub asn_db_path: Option<String>,
    #[serde(rename = "lastUpdated")]
    pub last_updated: Option<f64>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Preferences {
    #[serde(rename = "reducedMotion")]
    pub reduced_motion: Option<bool>,
    #[serde(rename = "highContrast")]
    pub high_contrast: Option<bool>,
    pub onboarding: Option<OnboardingPreferences>,
    #[serde(default, deserialize_with = "lenient_ui")]
    pub ui: UiPreferences,
}

/// Colours of the panels around the globe. The globe looks the same in both.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Dark,
    Light,
}

/// The layer id of the online NASA GIBS tiles. Mirrors
/// `ONLINE_IMAGERY_LAYER_ID` in src/common/ipc.ts.
pub const ONLINE_IMAGERY_LAYER: &str = "online-imagery";
/// More entries than any registry will have; bounds what a settings file can hold.
const MAX_UI_ENTRIES: usize = 64;
const MAX_UI_ID_LEN: usize = 40;

/// Theme, globe layers and collapsed panels (`preferences.ui`). Layer and
/// panel ids come from the renderer's registries. Ids that this version does
/// not know are kept, so the choices of a newer version survive a downgrade.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct UiPreferences {
    pub theme: Theme,
    /// Layer id → shown. A missing id uses the layer's default.
    pub layers: BTreeMap<String, bool>,
    /// Panel id → collapsed. A missing id uses the panel's default.
    pub collapsed: BTreeMap<String, bool>,
}

impl UiPreferences {
    /// Whether the tile cache may download NASA GIBS tiles. On unless the
    /// user switched the online imagery layer off.
    pub fn online_imagery(&self) -> bool {
        self.layers
            .get(ONLINE_IMAGERY_LAYER)
            .copied()
            .unwrap_or(true)
    }

    /// Checks UI preferences that arrive from the renderer before they are stored.
    pub fn validated(self) -> Result<Self, String> {
        for (what, entries) in [("layer", &self.layers), ("panel", &self.collapsed)] {
            if entries.len() > MAX_UI_ENTRIES {
                return Err(format!(
                    "Too many {what} entries in the UI preferences: {} (at most {MAX_UI_ENTRIES}).",
                    entries.len()
                ));
            }
            if !entries.keys().all(|id| is_registry_id(id)) {
                return Err(format!(
                    "Invalid {what} id in the UI preferences: use 1 to {MAX_UI_ID_LEN} lowercase letters, digits and dashes."
                ));
            }
        }
        Ok(self)
    }
}

fn is_registry_id(id: &str) -> bool {
    (1..=MAX_UI_ID_LEN).contains(&id.len())
        && !id.starts_with('-')
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A damaged `ui` section in settings.json falls back to the defaults. A
/// strict parse would fail the whole file and also drop the database paths
/// and provider settings.
fn lenient_ui<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<UiPreferences, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    let parsed = serde_json::from_value::<UiPreferences>(value)
        .map_err(|e| e.to_string())
        .and_then(UiPreferences::validated);
    Ok(parsed.unwrap_or_else(|error| {
        log::warn!("Ignoring invalid UI preferences in settings.json: {error}");
        UiPreferences::default()
    }))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheSettings {
    #[serde(rename = "dnsTtlMs")]
    pub dns_ttl_ms: u64,
    #[serde(rename = "enrichmentTtlMs")]
    pub enrichment_ttl_ms: u64,
}

impl Default for CacheSettings {
    fn default() -> Self {
        Self {
            dns_ttl_ms: 86_400_000,         // 24h
            enrichment_ttl_ms: 604_800_000, // 7d: registry data changes slowly
        }
    }
}

pub const DEFAULT_RDAP_BASE_URL: &str = "https://rdap.org/ip";
pub const RIPE_STAT_SOURCE_APP: &str = "VisTracer";

/// `#[serde(default)]` keeps older or partial settings files loadable: a
/// missing provider section falls back to its default instead of failing
/// the whole file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct IntegrationSettings {
    #[serde(rename = "teamCymru")]
    pub team_cymru: TeamCymruSettings,
    pub rdap: RdapSettings,
    #[serde(rename = "ripeStat")]
    pub ripe_stat: RipeStatSettings,
    #[serde(rename = "peeringDb")]
    pub peering_db: PeeringDbSettings,
    #[serde(rename = "ixMatching")]
    pub ix_matching: IxMatchingSettings,
}

impl Default for IntegrationSettings {
    fn default() -> Self {
        Self {
            team_cymru: TeamCymruSettings { enabled: true },
            rdap: RdapSettings {
                enabled: true,
                base_url: Some(DEFAULT_RDAP_BASE_URL.to_string()),
            },
            ripe_stat: RipeStatSettings {
                enabled: true,
                source_app: RIPE_STAT_SOURCE_APP.to_string(),
            },
            peering_db: PeeringDbSettings {
                enabled: false,
                api_key: None,
            },
            ix_matching: IxMatchingSettings::default(),
        }
    }
}

impl IntegrationSettings {
    /// Checks settings that arrive from the renderer before they are stored.
    pub fn validated(mut self) -> Result<Self, String> {
        self.rdap.base_url = match self.rdap.base_url.as_deref().map(str::trim) {
            None | Some("") => Some(DEFAULT_RDAP_BASE_URL.to_string()),
            Some(raw) => {
                let url = reqwest::Url::parse(raw)
                    .map_err(|_| format!("RDAP base URL \"{raw}\" is not a valid URL."))?;
                if !matches!(url.scheme(), "https" | "http") {
                    return Err("RDAP base URL must start with https:// or http://.".to_string());
                }
                Some(raw.trim_end_matches('/').to_string())
            }
        };
        self.peering_db.api_key = self
            .peering_db
            .api_key
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty());
        if self
            .peering_db
            .api_key
            .as_deref()
            .is_some_and(|key| key.chars().any(|c| c.is_control() || c.is_whitespace()))
        {
            return Err(
                "PeeringDB API key must not contain spaces or control characters.".to_string(),
            );
        }
        // RIPEstat asks clients to identify themselves; the value is fixed.
        self.ripe_stat.source_app = RIPE_STAT_SOURCE_APP.to_string();
        Ok(self)
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

impl RdapSettings {
    pub fn base_url(&self) -> &str {
        self.base_url.as_deref().unwrap_or(DEFAULT_RDAP_BASE_URL)
    }
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

/// Placing hops at internet exchanges. Separate from the PeeringDB switch:
/// it downloads PeeringDB's public exchange list and sends nothing about
/// the user's route, so it is on by default, also for settings files saved
/// before the switch existed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct IxMatchingSettings {
    pub enabled: bool,
}

impl Default for IxMatchingSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DnsCacheEntry {
    pub value: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: f64,
}

/// In-memory store for settings, the DNS cache, and recent runs. Settings
/// are persisted to settings.json; provider responses have their own cache
/// (see `enrichment_cache`).
pub struct AppStore {
    pub geo: GeoSettings,
    pub preferences: Preferences,
    pub cache_settings: CacheSettings,
    pub integrations: IntegrationSettings,
    pub dns_cache: HashMap<String, DnsCacheEntry>,
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
                ui: UiPreferences::default(),
            },
            cache_settings: CacheSettings::default(),
            integrations: IntegrationSettings::default(),
            dns_cache: HashMap::new(),
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

    pub fn get_recent_runs(&self, limit: usize) -> Vec<RecentRun> {
        let mut runs: Vec<RecentRun> = self
            .runs
            .iter()
            .map(|run| RecentRun {
                id: format!("{}{}", run.summary.target, run.summary.started_at as u64),
                started_at: run.summary.started_at,
                target: run.summary.target.clone(),
                protocol: run.request.protocol,
            })
            .collect();
        runs.sort_by(|a, b| {
            b.started_at
                .partial_cmp(&a.started_at)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
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

/// Subset of AppStore that gets persisted to disk as JSON.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PersistedSettings {
    #[serde(default)]
    pub geo: GeoSettings,
    #[serde(default)]
    pub preferences: Preferences,
    #[serde(default)]
    pub integrations: IntegrationSettings,
}

fn settings_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("settings.json")
}

pub fn load_persisted_settings(app_data_dir: &Path) -> PersistedSettings {
    let path = settings_path(app_data_dir);
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|e| {
            log::warn!("Failed to parse settings.json, using defaults: {}", e);
            PersistedSettings::default()
        }),
        Err(_) => PersistedSettings::default(),
    }
}

pub fn save_persisted_settings(app_data_dir: &Path, store: &AppStore) {
    let settings = PersistedSettings {
        geo: store.geo.clone(),
        preferences: store.preferences.clone(),
        integrations: store.integrations.clone(),
    };
    let path = settings_path(app_data_dir);
    match serde_json::to_string_pretty(&settings) {
        Ok(json) => {
            if let Err(e) = std::fs::write(&path, json) {
                log::error!("Failed to write settings.json: {}", e);
            }
        }
        Err(e) => log::error!("Failed to serialize settings: {}", e),
    }
}

pub type SharedStore = Mutex<AppStore>;

pub fn ensure_app_data_dirs(app_data_dir: &Path) {
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

pub fn configure_geo_database_defaults(
    store: &SharedStore,
    assets_dir: &Path,
    app_data_dir: &Path,
) {
    // 1. Load any previously persisted settings from disk
    let persisted = load_persisted_settings(app_data_dir);

    let mut guard = store.lock().unwrap_or_else(|e| e.into_inner());
    guard.preferences = persisted.preferences;
    guard.integrations = persisted.integrations;
    guard.geo = persisted.geo;

    // 2. Validate that persisted geo paths still exist on disk
    if let Some(ref p) = guard.geo.city_db_path {
        if !Path::new(p).exists() {
            guard.geo.city_db_path = None;
        }
    }
    if let Some(ref p) = guard.geo.asn_db_path {
        if !Path::new(p).exists() {
            guard.geo.asn_db_path = None;
        }
    }

    // 3. If no valid paths yet, check the auto-download directory
    let db_dir = app_data_dir.join("databases");
    if guard.geo.city_db_path.is_none() {
        let candidate = db_dir.join("GeoLite2-City.mmdb");
        if candidate.exists() {
            guard.geo.city_db_path = Some(candidate.to_string_lossy().to_string());
        }
    }
    if guard.geo.asn_db_path.is_none() {
        let candidate = db_dir.join("GeoLite2-ASN.mmdb");
        if candidate.exists() {
            guard.geo.asn_db_path = Some(candidate.to_string_lossy().to_string());
        }
    }

    // 4. Fall back to bundled assets directory
    if guard.geo.city_db_path.is_none() {
        let candidate = assets_dir.join("GeoLite2-City.mmdb");
        if candidate.exists() {
            guard.geo.city_db_path = Some(candidate.to_string_lossy().to_string());
        }
    }
    if guard.geo.asn_db_path.is_none() {
        let candidate = assets_dir.join("GeoLite2-ASN.mmdb");
        if candidate.exists() {
            guard.geo.asn_db_path = Some(candidate.to_string_lossy().to_string());
        }
    }

    // Update last_updated timestamp from file metadata if available
    let mut updated = guard.geo.last_updated;
    for p in [&guard.geo.city_db_path, &guard.geo.asn_db_path]
        .into_iter()
        .flatten()
    {
        if let Ok(modified) = std::fs::metadata(p).and_then(|meta| meta.modified()) {
            let ms = modified
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as f64;
            updated = Some(updated.map_or(ms, |u: f64| u.max(ms)));
        }
    }
    guard.geo.last_updated = updated;

    log::info!(
        "Geo database configuration: city={:?}, asn={:?}",
        guard.geo.city_db_path,
        guard.geo.asn_db_path
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validated_normalizes_integration_settings() {
        let mut settings = IntegrationSettings::default();
        settings.rdap.base_url = Some("  ".into());
        settings.peering_db.api_key = Some("  abc123  ".into());
        settings.ripe_stat.source_app = "Something else".into();
        let valid = settings.validated().unwrap();
        assert_eq!(valid.rdap.base_url(), DEFAULT_RDAP_BASE_URL);
        assert_eq!(valid.peering_db.api_key.as_deref(), Some("abc123"));
        assert_eq!(valid.ripe_stat.source_app, RIPE_STAT_SOURCE_APP);

        let mut blank_key = IntegrationSettings::default();
        blank_key.peering_db.api_key = Some("   ".into());
        assert_eq!(blank_key.validated().unwrap().peering_db.api_key, None);

        let mut custom = IntegrationSettings::default();
        custom.rdap.base_url = Some("https://rdap.example.net/ip/".into());
        assert_eq!(
            custom.validated().unwrap().rdap.base_url(),
            "https://rdap.example.net/ip"
        );
    }

    #[test]
    fn validated_rejects_bad_urls_and_keys() {
        let mut ftp = IntegrationSettings::default();
        ftp.rdap.base_url = Some("ftp://rdap.example.net".into());
        assert!(ftp.validated().is_err());

        let mut garbage = IntegrationSettings::default();
        garbage.rdap.base_url = Some("not a url".into());
        assert!(garbage.validated().is_err());

        let mut key = IntegrationSettings::default();
        key.peering_db.api_key = Some("abc\ndef".into());
        assert!(key.validated().is_err());
    }

    #[test]
    fn exchange_matching_is_on_by_default_and_for_old_settings_files() {
        assert!(IntegrationSettings::default().ix_matching.enabled);

        // A settings.json saved before the switch existed.
        let old: PersistedSettings = serde_json::from_str(
            r#"{"integrations":{"teamCymru":{"enabled":true},"rdap":{"enabled":true,"baseUrl":null},"ripeStat":{"enabled":true,"sourceApp":"VisTracer"},"peeringDb":{"enabled":false,"apiKey":null}}}"#,
        )
        .unwrap();
        assert!(old.integrations.ix_matching.enabled);
        assert!(!old.integrations.peering_db.enabled);

        let empty: IntegrationSettings = serde_json::from_str(r#"{"ixMatching":{}}"#).unwrap();
        assert!(empty.ix_matching.enabled);

        let off: IntegrationSettings =
            serde_json::from_str(r#"{"ixMatching":{"enabled":false}}"#).unwrap();
        assert!(!off.ix_matching.enabled);
        let saved = serde_json::to_value(off.validated().unwrap()).unwrap();
        assert_eq!(saved["ixMatching"]["enabled"], serde_json::json!(false));
    }

    #[test]
    fn ui_preferences_default_to_dark_with_online_imagery_on() {
        let ui = UiPreferences::default();
        assert_eq!(ui.theme, Theme::Dark);
        assert!(ui.online_imagery());

        // A settings.json saved before the section existed.
        let old: PersistedSettings =
            serde_json::from_str(r#"{"preferences":{"onboarding":{"skipOnLaunch":true}}}"#)
                .unwrap();
        assert_eq!(old.preferences.ui, UiPreferences::default());

        let saved: UiPreferences = serde_json::from_value(serde_json::json!({
            "theme": "light",
            "layers": { "online-imagery": false, "rings": true },
            "collapsed": { "hops": true }
        }))
        .unwrap();
        assert_eq!(saved.theme, Theme::Light);
        assert!(!saved.online_imagery());
        assert_eq!(saved.collapsed.get("hops"), Some(&true));
        assert_eq!(
            serde_json::to_value(&saved).unwrap()["theme"],
            serde_json::json!("light")
        );
    }

    #[test]
    fn ui_preferences_reject_bad_ids_and_unbounded_maps() {
        let with_layer = |id: &str| UiPreferences {
            layers: BTreeMap::from([(id.to_string(), true)]),
            ..UiPreferences::default()
        };
        assert!(with_layer("anycast-reach").validated().is_ok());
        // A phase 5 layer this version does not know is kept.
        assert!(with_layer("ixp-sites").validated().is_ok());
        for bad in ["", "Arcs", "-arcs", "arcs/../x", "a b", &"x".repeat(41)] {
            assert!(with_layer(bad).validated().is_err(), "{bad:?}");
        }
        let many = UiPreferences {
            collapsed: (0..65).map(|i| (format!("panel-{i}"), true)).collect(),
            ..UiPreferences::default()
        };
        assert!(many.validated().is_err());
        assert!(
            serde_json::from_value::<UiPreferences>(serde_json::json!({ "theme": "neon" }))
                .is_err()
        );
    }

    #[test]
    fn a_damaged_ui_section_keeps_the_rest_of_the_settings_file() {
        let file = r#"{
            "geo": { "cityDbPath": "/data/GeoLite2-City.mmdb" },
            "preferences": { "ui": { "theme": "neon", "layers": { "BAD ID": false } } },
            "integrations": { "peeringDb": { "enabled": true, "apiKey": null } }
        }"#;
        let parsed: PersistedSettings = serde_json::from_str(file).unwrap();
        assert_eq!(parsed.preferences.ui, UiPreferences::default());
        assert_eq!(
            parsed.geo.city_db_path.as_deref(),
            Some("/data/GeoLite2-City.mmdb")
        );
        assert!(parsed.integrations.peering_db.enabled);
    }

    #[test]
    fn partial_integration_settings_fall_back_to_defaults() {
        let parsed: IntegrationSettings =
            serde_json::from_str(r#"{"peeringDb":{"enabled":true,"apiKey":"k"}}"#).unwrap();
        assert!(parsed.peering_db.enabled);
        assert!(parsed.team_cymru.enabled);
        assert_eq!(parsed.rdap.base_url(), DEFAULT_RDAP_BASE_URL);
    }
}
