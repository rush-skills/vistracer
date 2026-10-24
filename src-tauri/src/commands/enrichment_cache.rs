//! TTL cache for enrichment provider responses, kept in memory and
//! persisted to the app cache directory between sessions.

use crate::types::{PeeringDbDetails, ProviderId};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

use super::integrations::{CymruRecord, RdapRecord, RipeStatRecord};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtlEntry<V> {
    pub value: V,
    pub stored_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TtlMap<V> {
    entries: HashMap<String, TtlEntry<V>>,
}

impl<V> Default for TtlMap<V> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

impl<V> TtlMap<V> {
    fn is_fresh(stored_at_ms: i64, now_ms: i64, ttl_ms: i64) -> bool {
        // An entry from the future (clock moved back) counts as expired.
        let age = now_ms - stored_at_ms;
        (0..ttl_ms).contains(&age)
    }

    pub fn get(&self, key: &str, now_ms: i64, ttl_ms: i64) -> Option<&V> {
        self.entries
            .get(key)
            .filter(|entry| Self::is_fresh(entry.stored_at_ms, now_ms, ttl_ms))
            .map(|entry| &entry.value)
    }

    pub fn insert(&mut self, key: String, value: V, now_ms: i64) {
        self.entries.insert(
            key,
            TtlEntry {
                value,
                stored_at_ms: now_ms,
            },
        );
    }

    /// Drops expired entries, then the oldest entries above `max_entries`.
    pub fn prune(&mut self, now_ms: i64, ttl_ms: i64, max_entries: usize) {
        self.entries
            .retain(|_, entry| Self::is_fresh(entry.stored_at_ms, now_ms, ttl_ms));
        if self.entries.len() > max_entries {
            let mut by_age: Vec<(String, i64)> = self
                .entries
                .iter()
                .map(|(key, entry)| (key.clone(), entry.stored_at_ms))
                .collect();
            by_age.sort_by_key(|(_, stored_at)| *stored_at);
            let excess = self.entries.len() - max_entries;
            for (key, _) in by_age.into_iter().take(excess) {
                self.entries.remove(&key);
            }
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

/// A cached provider answer. `None` records that the provider had no data
/// for the key, so repeated misses do not hit the network either.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "provider", content = "record", rename_all = "camelCase")]
pub enum CachedRecord {
    TeamCymru(Option<CymruRecord>),
    Rdap(Option<RdapRecord>),
    RipeStat(Option<RipeStatRecord>),
    PeeringDb(Option<PeeringDbDetails>),
}

/// Maps a provider record type to its cache slot.
pub trait CachedProvider: Clone + Sized {
    const PROVIDER: ProviderId;
    fn wrap(record: Option<Self>) -> CachedRecord;
    fn unwrap(record: &CachedRecord) -> Option<Option<Self>>;
}

macro_rules! cached_provider {
    ($ty:ty, $id:expr, $variant:ident) => {
        impl CachedProvider for $ty {
            const PROVIDER: ProviderId = $id;
            fn wrap(record: Option<Self>) -> CachedRecord {
                CachedRecord::$variant(record)
            }
            fn unwrap(record: &CachedRecord) -> Option<Option<Self>> {
                match record {
                    CachedRecord::$variant(inner) => Some(inner.clone()),
                    _ => None,
                }
            }
        }
    };
}

cached_provider!(CymruRecord, ProviderId::TeamCymru, TeamCymru);
cached_provider!(RdapRecord, ProviderId::Rdap, Rdap);
cached_provider!(RipeStatRecord, ProviderId::RipeStat, RipeStat);
cached_provider!(PeeringDbDetails, ProviderId::PeeringDb, PeeringDb);

const CACHE_FORMAT_VERSION: u32 = 1;
pub const MAX_CACHE_ENTRIES: usize = 4000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    version: u32,
    entries: TtlMap<CachedRecord>,
}

#[derive(Debug, Default)]
pub struct EnrichmentCache {
    entries: TtlMap<CachedRecord>,
    dirty: bool,
}

pub fn cache_key(provider: ProviderId, key: &str) -> String {
    let provider = serde_json::to_value(provider)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    format!("{provider}:{key}")
}

impl EnrichmentCache {
    pub fn get<T: CachedProvider>(&self, key: &str, now_ms: i64, ttl_ms: i64) -> Option<Option<T>> {
        self.entries
            .get(&cache_key(T::PROVIDER, key), now_ms, ttl_ms)
            .and_then(T::unwrap)
    }

    pub fn insert<T: CachedProvider>(&mut self, key: &str, record: Option<T>, now_ms: i64) {
        self.entries
            .insert(cache_key(T::PROVIDER, key), T::wrap(record), now_ms);
        self.dirty = true;
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Loads the cache file, dropping expired entries. A missing or
    /// unreadable file gives an empty cache; the next save replaces it.
    pub fn load(path: &Path, now_ms: i64, ttl_ms: i64) -> Self {
        let mut entries = match std::fs::read_to_string(path) {
            Ok(text) => match serde_json::from_str::<CacheFile>(&text) {
                Ok(file) if file.version == CACHE_FORMAT_VERSION => file.entries,
                Ok(file) => {
                    log::info!(
                        "Ignoring enrichment cache with format version {}",
                        file.version
                    );
                    TtlMap::default()
                }
                Err(err) => {
                    log::warn!(
                        "Ignoring unreadable enrichment cache {}: {err}",
                        path.display()
                    );
                    TtlMap::default()
                }
            },
            Err(_) => TtlMap::default(),
        };
        entries.prune(now_ms, ttl_ms, MAX_CACHE_ENTRIES);
        Self {
            entries,
            dirty: false,
        }
    }

    /// Writes the cache through a temporary file and a rename, so a crash
    /// during the write cannot leave a truncated cache behind.
    pub fn save_if_dirty(&mut self, path: &Path, now_ms: i64, ttl_ms: i64) -> std::io::Result<()> {
        if !self.dirty {
            return Ok(());
        }
        self.entries.prune(now_ms, ttl_ms, MAX_CACHE_ENTRIES);
        let file = CacheFile {
            version: CACHE_FORMAT_VERSION,
            entries: self.entries.clone(),
        };
        let json = serde_json::to_vec(&file).map_err(std::io::Error::other)?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, path)?;
        self.dirty = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: i64 = 3_600_000;

    fn cymru(asn: u32) -> CymruRecord {
        CymruRecord {
            asn: Some(asn),
            prefix: Some("8.8.8.0/24".into()),
            country: Some("US".into()),
            registry: Some("arin".into()),
            as_name: Some("GOOGLE".into()),
        }
    }

    #[test]
    fn ttl_map_expires_entries() {
        let mut map = TtlMap::default();
        map.insert("a".to_string(), 1, 1_000);
        assert_eq!(map.get("a", 1_000, HOUR), Some(&1));
        assert_eq!(map.get("a", 1_000 + HOUR - 1, HOUR), Some(&1));
        assert_eq!(map.get("a", 1_000 + HOUR, HOUR), None);
        // Clock moved back: treat as expired rather than valid forever.
        assert_eq!(map.get("a", 0, HOUR), None);
    }

    #[test]
    fn ttl_map_prune_removes_expired_then_oldest() {
        let mut map = TtlMap::default();
        map.insert("old".to_string(), 0, 0);
        map.insert("b".to_string(), 1, 10 * HOUR);
        map.insert("c".to_string(), 2, 11 * HOUR);
        map.insert("d".to_string(), 3, 12 * HOUR);
        map.prune(12 * HOUR, 5 * HOUR, 2);
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("old", 12 * HOUR, 5 * HOUR), None);
        assert_eq!(map.get("b", 12 * HOUR, 5 * HOUR), None);
        assert_eq!(map.get("d", 12 * HOUR, 5 * HOUR), Some(&3));
    }

    #[test]
    fn cache_keeps_providers_and_negative_results_apart() {
        let mut cache = EnrichmentCache::default();
        cache.insert("8.8.8.8", Some(cymru(15169)), 0);
        cache.insert::<RdapRecord>("8.8.8.8", None, 0);

        assert_eq!(
            cache.get::<CymruRecord>("8.8.8.8", 1, HOUR),
            Some(Some(cymru(15169)))
        );
        assert_eq!(cache.get::<RdapRecord>("8.8.8.8", 1, HOUR), Some(None));
        assert_eq!(cache.get::<RipeStatRecord>("8.8.8.8", 1, HOUR), None);
        assert_eq!(cache.get::<CymruRecord>("8.8.8.8", HOUR, HOUR), None);
    }

    #[test]
    fn cache_round_trips_through_disk_and_drops_expired() {
        let dir = std::env::temp_dir().join(format!("vistracer-cache-{}", uuid::Uuid::new_v4()));
        let path = dir.join("enrichment-cache.json");

        let mut cache = EnrichmentCache::default();
        cache.insert("1.1.1.1", Some(cymru(13335)), 0);
        cache.insert("8.8.8.8", Some(cymru(15169)), 2 * HOUR);
        cache.save_if_dirty(&path, 2 * HOUR, 24 * HOUR).unwrap();
        assert!(!path.with_extension("json.tmp").exists());

        let loaded = EnrichmentCache::load(&path, 25 * HOUR, 24 * HOUR);
        assert_eq!(loaded.len(), 1);
        assert_eq!(
            loaded.get::<CymruRecord>("8.8.8.8", 25 * HOUR, 24 * HOUR),
            Some(Some(cymru(15169)))
        );
        assert_eq!(
            loaded.get::<CymruRecord>("1.1.1.1", 25 * HOUR, 24 * HOUR),
            None
        );

        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(EnrichmentCache::load(&path, 0, HOUR).len(), 0);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn save_is_skipped_when_nothing_changed() {
        let dir = std::env::temp_dir().join(format!("vistracer-cache-{}", uuid::Uuid::new_v4()));
        let path = dir.join("enrichment-cache.json");
        let mut cache = EnrichmentCache::default();
        cache.save_if_dirty(&path, 0, HOUR).unwrap();
        assert!(!path.exists());
    }
}
