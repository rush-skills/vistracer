//! TTL cache for enrichment provider responses, kept in memory and
//! persisted to the app cache directory between sessions.

use crate::types::{PeeringDbDetails, ProviderId};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::integrations::{CymruRecord, RdapRecord, RipeStatRecord};
use crate::geoloc::ixp::IxDataset;

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
        self.get_entry(key, now_ms, ttl_ms)
            .map(|entry| &entry.value)
    }

    pub fn get_entry(&self, key: &str, now_ms: i64, ttl_ms: i64) -> Option<&TtlEntry<V>> {
        self.entries
            .get(key)
            .filter(|entry| Self::is_fresh(entry.stored_at_ms, now_ms, ttl_ms))
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
    PeeringDbIx(Option<IxDataset>),
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
cached_provider!(IxDataset, ProviderId::PeeringDbIx, PeeringDbIx);

const CACHE_FORMAT_VERSION: u32 = 1;
pub const MAX_CACHE_ENTRIES: usize = 4000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFile {
    version: u32,
    entries: TtlMap<CachedRecord>,
}

/// Same layout as `CacheFile`, borrowed, so a snapshot needs no clone.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheFileRef<'a> {
    version: u32,
    entries: &'a TtlMap<CachedRecord>,
}

/// Writes through a temporary file and a rename, so a crash during the
/// write cannot leave a truncated cache behind.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
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

    /// Like `get`, with the time the entry was stored.
    pub fn get_stored<T: CachedProvider>(
        &self,
        key: &str,
        now_ms: i64,
        ttl_ms: i64,
    ) -> Option<(Option<T>, i64)> {
        let entry = self
            .entries
            .get_entry(&cache_key(T::PROVIDER, key), now_ms, ttl_ms)?;
        Some((T::unwrap(&entry.value)?, entry.stored_at_ms))
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

    /// Prunes and serialises the cache when it changed since the last
    /// snapshot. The caller writes the bytes without holding the cache lock
    /// and calls `mark_dirty` if that write fails.
    pub fn snapshot_if_dirty(
        &mut self,
        now_ms: i64,
        ttl_ms: i64,
    ) -> serde_json::Result<Option<Vec<u8>>> {
        if !self.dirty {
            return Ok(None);
        }
        self.entries.prune(now_ms, ttl_ms, MAX_CACHE_ENTRIES);
        let bytes = serde_json::to_vec(&CacheFileRef {
            version: CACHE_FORMAT_VERSION,
            entries: &self.entries,
        })?;
        self.dirty = false;
        Ok(Some(bytes))
    }

    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The provider cache shared by the lookups and the IX list download,
/// with its file on disk.
pub struct ProviderCache {
    path: Option<PathBuf>,
    ttl_ms: i64,
    /// Entries younger than this are kept on load and save, even when they
    /// are past `ttl_ms`. Callers use it to keep entries with a longer life
    /// than the provider TTL (the IX list is used for up to 7 days).
    retain_ms: i64,
    entries: Mutex<EnrichmentCache>,
    /// Held from snapshot to rename, so two writers (two runs that finish
    /// together, or a run and an IX list download) write in snapshot order
    /// and never share the temporary file.
    persist_lock: Mutex<()>,
}

impl ProviderCache {
    /// Loads the file at `path`; `None` keeps the cache in memory only.
    /// `retain_ms` is raised to at least `ttl_ms`.
    pub fn new(path: Option<PathBuf>, ttl_ms: i64, retain_ms: i64) -> Self {
        let retain_ms = retain_ms.max(ttl_ms);
        let entries = match &path {
            Some(path) => EnrichmentCache::load(path, now_ms(), retain_ms),
            None => EnrichmentCache::default(),
        };
        Self {
            path,
            ttl_ms,
            retain_ms,
            entries: Mutex::new(entries),
            persist_lock: Mutex::new(()),
        }
    }

    fn entries(&self) -> std::sync::MutexGuard<'_, EnrichmentCache> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn get<T: CachedProvider>(&self, key: &str) -> Option<Option<T>> {
        self.entries().get::<T>(key, now_ms(), self.ttl_ms)
    }

    /// An entry up to `max_age_ms` old, with the time it was stored.
    pub fn get_stored<T: CachedProvider>(
        &self,
        key: &str,
        max_age_ms: i64,
    ) -> Option<(Option<T>, i64)> {
        self.entries().get_stored::<T>(key, now_ms(), max_age_ms)
    }

    pub fn insert<T: CachedProvider>(&self, key: &str, record: Option<T>) {
        self.insert_at(key, record, now_ms());
    }

    pub fn insert_at<T: CachedProvider>(&self, key: &str, record: Option<T>, stored_at_ms: i64) {
        self.entries().insert(key, record, stored_at_ms);
    }

    /// Writes changed entries to disk. Errors are logged; a lost cache only
    /// costs extra lookups.
    pub fn persist(&self) {
        self.persist_with(write_atomic);
    }

    fn persist_with(&self, write: impl FnOnce(&Path, &[u8]) -> std::io::Result<()>) {
        let Some(path) = &self.path else {
            return;
        };
        let _writer = self.persist_lock.lock().unwrap_or_else(|e| e.into_inner());
        // Serialise under the entries lock; write after it is released so
        // lookups are not blocked by disk I/O.
        let snapshot = self.entries().snapshot_if_dirty(now_ms(), self.retain_ms);
        let bytes = match snapshot {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return,
            Err(err) => {
                log::warn!("Failed to serialise enrichment cache: {err}");
                return;
            }
        };
        if let Err(err) = write(path, &bytes) {
            log::warn!("Failed to write enrichment cache {}: {err}", path.display());
            self.entries().mark_dirty();
        }
    }

    #[cfg(test)]
    pub fn has_unsaved_changes(&self) -> bool {
        self.entries().dirty
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
        let bytes = cache
            .snapshot_if_dirty(2 * HOUR, 24 * HOUR)
            .unwrap()
            .unwrap();
        write_atomic(&path, &bytes).unwrap();
        assert!(!path.with_extension("json.tmp").exists());
        assert_eq!(cache.snapshot_if_dirty(2 * HOUR, 24 * HOUR).unwrap(), None);

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
    fn concurrent_persists_never_write_an_older_snapshot_last() {
        use std::sync::mpsc;

        let dir = std::env::temp_dir().join(format!("vistracer-persist-{}", uuid::Uuid::new_v4()));
        let path = dir.join("enrichment-cache.json");
        let cache = ProviderCache::new(Some(path.clone()), HOUR, HOUR);
        cache.insert("1.1.1.1", Some(cymru(13335)));

        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        std::thread::scope(|scope| {
            let cache = &cache;
            // The first run's write is slow (busy disk) and holds an older
            // snapshot while the second run finishes.
            scope.spawn(move || {
                cache.persist_with(move |path, bytes| {
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    write_atomic(path, bytes)
                });
            });
            entered_rx.recv().unwrap();
            cache.insert("8.8.8.8", Some(cymru(15169)));
            let second = scope.spawn(move || cache.persist());
            std::thread::sleep(std::time::Duration::from_millis(100));
            release_tx.send(()).unwrap();
            second.join().unwrap();
        });

        let loaded = EnrichmentCache::load(&path, now_ms(), HOUR);
        assert_eq!(
            loaded.get::<CymruRecord>("8.8.8.8", now_ms(), HOUR),
            Some(Some(cymru(15169))),
            "the newer snapshot must be the one on disk"
        );
        assert!(!path.with_extension("json.tmp").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn retained_entries_outlive_a_short_provider_ttl() {
        let dir = std::env::temp_dir().join(format!("vistracer-retain-{}", uuid::Uuid::new_v4()));
        let path = dir.join("enrichment-cache.json");
        // A one-hour provider TTL must not drop a 25-hour-old entry that a
        // caller keeps for up to 7 days.
        let cache = ProviderCache::new(Some(path.clone()), HOUR, 7 * 24 * HOUR);
        cache.insert_at("8.8.8.8", Some(cymru(15169)), now_ms() - 25 * HOUR);
        cache.persist();

        let reloaded = ProviderCache::new(Some(path), HOUR, 7 * 24 * HOUR);
        assert_eq!(reloaded.get::<CymruRecord>("8.8.8.8"), None, "past the TTL");
        assert!(reloaded
            .get_stored::<CymruRecord>("8.8.8.8", 7 * 24 * HOUR)
            .is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn snapshot_is_skipped_when_nothing_changed() {
        let mut cache = EnrichmentCache::default();
        assert_eq!(cache.snapshot_if_dirty(0, HOUR).unwrap(), None);
        cache.mark_dirty();
        assert!(cache.snapshot_if_dirty(0, HOUR).unwrap().is_some());
    }
}
