//! Disk cache for globe imagery tiles, served to the renderer through the
//! `vistiles` URI scheme.
//!
//! The renderer only names an allowlisted layer and a tile address
//! (`vistiles://localhost/{layer}/{z}/{y}/{x}.{ext}`). This module builds the
//! upstream URL itself and only talks to `ALLOWED_UPSTREAM_HOSTS`, so the
//! scheme is not a proxy. Only complete image responses are stored; errors are
//! never cached. The cache lives in `$APPCACHE/tiles`, has a size cap and
//! drops the least recently used tiles first.

use crate::atomic_file::{is_temp_file, write_atomic};
use serde::Serialize;
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};
use tauri::http::{header, Response, StatusCode, Uri};

pub const TILE_SCHEME: &str = "vistiles";
pub const DEFAULT_CAP_BYTES: u64 = 500_000_000;
/// A full cache evicts down to this share of the cap, so it does not evict
/// on every new tile.
const EVICT_TO_PERCENT: u64 = 90;
/// GIBS tiles are 5 to 50 KB; anything far larger is not a tile.
const MAX_TILE_BYTES: usize = 2 * 1024 * 1024;
const ALLOWED_UPSTREAM_HOSTS: &[&str] = &["gibs.earthdata.nasa.gov"];
/// `clear` moves the cache folder to a sibling with this prefix, then
/// deletes it.
const TRASH_PREFIX: &str = "tiles-trash-";
/// Consecutive upstream failures (network, timeout, 5xx, 429) after which
/// the cache stops asking upstream for `BREAKER_PAUSE`. Offline, this turns
/// one timeout per tile into a few timeouts per pause.
const BREAKER_THRESHOLD: u32 = 3;
const BREAKER_PAUSE: Duration = Duration::from_secs(30);

/// An imagery layer that may be fetched. Mirrors `ONLINE_IMAGERY` in
/// src/renderer/lib/imagery.ts.
#[derive(Debug, PartialEq, Eq)]
pub struct TileLayer {
    /// Path segment the renderer uses.
    pub id: &'static str,
    pub gibs_layer: &'static str,
    pub tile_matrix_set: &'static str,
    pub max_zoom: u8,
    /// Extension in the renderer URL and the cache file name.
    pub extension: &'static str,
    pub upstream_extension: &'static str,
    pub content_type: &'static str,
}

/// NASA GIBS, EPSG:3857, 256 px tiles (Cesium's WebMercatorTilingScheme).
pub const TILE_LAYERS: &[TileLayer] = &[TileLayer {
    id: "blue-marble",
    gibs_layer: "BlueMarble_ShadedRelief_Bathymetry",
    tile_matrix_set: "GoogleMapsCompatible_Level8",
    max_zoom: 8,
    extension: "jpg",
    upstream_extension: "jpeg",
    content_type: "image/jpeg",
}];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TileAddress {
    pub layer: &'static TileLayer,
    pub z: u8,
    pub y: u32,
    pub x: u32,
}

impl TileAddress {
    /// Relative path in the cache folder. Built only from the allowlisted
    /// layer id and integers, so it cannot leave the folder.
    pub fn cache_key(&self) -> String {
        format!(
            "{}/{}/{}/{}.{}",
            self.layer.id, self.z, self.y, self.x, self.layer.extension
        )
    }

    pub fn upstream_url(&self) -> reqwest::Url {
        let url = format!(
            "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{}/default/{}/{}/{}/{}.{}",
            self.layer.gibs_layer,
            self.layer.tile_matrix_set,
            self.z,
            self.y,
            self.x,
            self.layer.upstream_extension
        );
        reqwest::Url::parse(&url).expect("tile URLs are built from constants and integers")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TileError {
    /// The request did not come through the tile scheme's own host.
    BadHost,
    BadPath,
    UnknownLayer,
    OutOfRange,
    /// Upstream has no such tile.
    NotFound,
    /// Upstream failed recently; not asked again until the pause ends.
    Paused,
    Upstream(String),
    /// The app has not finished starting.
    NotReady,
}

impl TileError {
    fn status(&self) -> StatusCode {
        match self {
            TileError::BadHost => StatusCode::FORBIDDEN,
            TileError::BadPath => StatusCode::BAD_REQUEST,
            TileError::UnknownLayer | TileError::OutOfRange | TileError::NotFound => {
                StatusCode::NOT_FOUND
            }
            TileError::Paused | TileError::NotReady => StatusCode::SERVICE_UNAVAILABLE,
            TileError::Upstream(_) => StatusCode::BAD_GATEWAY,
        }
    }

    fn message(&self) -> String {
        match self {
            TileError::BadHost => "Tile requests must use the vistiles scheme host.".into(),
            TileError::BadPath => "Expected /{layer}/{z}/{y}/{x}.{ext}.".into(),
            TileError::UnknownLayer => "Unknown imagery layer.".into(),
            TileError::OutOfRange => "Tile address is outside the layer.".into(),
            TileError::NotFound => "The imagery server has no such tile.".into(),
            TileError::Paused => format!(
                "The imagery server failed {BREAKER_THRESHOLD} times in a row; retrying after {} s.",
                BREAKER_PAUSE.as_secs()
            ),
            TileError::Upstream(message) => format!("Imagery server error: {message}"),
            TileError::NotReady => "The tile cache is starting.".into(),
        }
    }
}

fn parse_index<T: std::str::FromStr>(text: &str) -> Result<T, TileError> {
    if text.is_empty() || text.len() > 6 || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(TileError::BadPath);
    }
    text.parse().map_err(|_| TileError::BadPath)
}

/// Parses `vistiles://localhost/{layer}/{z}/{y}/{x}.{ext}` (macOS, Linux) or
/// `http(s)://vistiles.localhost/...` (Windows).
pub fn parse_tile_uri(uri: &Uri) -> Result<TileAddress, TileError> {
    match uri.host() {
        Some("localhost") | Some("vistiles.localhost") => {}
        _ => return Err(TileError::BadHost),
    }
    let path = uri.path().strip_prefix('/').ok_or(TileError::BadPath)?;
    let parts: Vec<&str> = path.split('/').collect();
    let [layer, z, y, file] = parts.as_slice() else {
        return Err(TileError::BadPath);
    };
    let layer = TILE_LAYERS
        .iter()
        .find(|candidate| candidate.id == *layer)
        .ok_or(TileError::UnknownLayer)?;
    let (x, extension) = file.split_once('.').ok_or(TileError::BadPath)?;
    if extension != layer.extension {
        return Err(TileError::BadPath);
    }
    let z: u8 = parse_index(z)?;
    let y: u32 = parse_index(y)?;
    let x: u32 = parse_index(x)?;
    if z > layer.max_zoom || x >= 1 << z || y >= 1 << z {
        return Err(TileError::OutOfRange);
    }
    Ok(TileAddress { layer, z, y, x })
}

pub fn is_allowed_upstream(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url
            .host_str()
            .is_some_and(|host| ALLOWED_UPSTREAM_HOSTS.contains(&host))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TileCacheInfo {
    pub size_bytes: u64,
    pub tile_count: u64,
    pub cap_bytes: u64,
}

#[derive(Debug, Clone, Copy)]
struct IndexEntry {
    size: u64,
    last_used: u64,
}

#[derive(Debug, Default)]
struct Index {
    loaded: bool,
    entries: HashMap<String, IndexEntry>,
    total_bytes: u64,
    clock: u64,
}

impl Index {
    fn touch(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    fn insert(&mut self, key: String, size: u64) {
        let last_used = self.touch();
        if let Some(old) = self.entries.insert(key, IndexEntry { size, last_used }) {
            self.total_bytes -= old.size;
        }
        self.total_bytes += size;
    }

    fn remove(&mut self, key: &str) {
        if let Some(old) = self.entries.remove(key) {
            self.total_bytes -= old.size;
        }
    }
}

/// The files on disk and an in-memory index of their sizes and last use.
/// One lock covers the index and the file operations: tile files are small,
/// and the lock keeps index and disk in step, also across `clear`.
pub struct TileStore {
    root: PathBuf,
    cap_bytes: u64,
    index: Mutex<Index>,
}

impl TileStore {
    pub fn new(root: PathBuf, cap_bytes: u64) -> Self {
        Self {
            root,
            cap_bytes,
            index: Mutex::new(Index::default()),
        }
    }

    /// Locks the index, scanning the folder the first time. The first scan
    /// also removes temporary files and moved-aside folders that a crash or
    /// an interrupted `clear` left behind.
    fn index(&self) -> MutexGuard<'_, Index> {
        let mut index = self.index.lock().unwrap_or_else(|e| e.into_inner());
        if !index.loaded {
            self.remove_trash();
            let mut found = Vec::new();
            scan(&self.root, &self.root, &mut found);
            // Across restarts, the write time stands in for the last use.
            found.sort_by_key(|(_, _, modified)| *modified);
            for (key, size, _) in found {
                index.insert(key, size);
            }
            index.loaded = true;
        }
        index
    }

    fn remove_trash(&self) {
        let Some(parent) = self.root.parent() else {
            return;
        };
        let Ok(entries) = std::fs::read_dir(parent) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(TRASH_PREFIX)
                && path.is_dir()
            {
                if let Err(err) = std::fs::remove_dir_all(&path) {
                    log::warn!("Failed to delete {}: {err}", path.display());
                }
            }
        }
    }

    pub fn get(&self, key: &str) -> Option<Vec<u8>> {
        let mut index = self.index();
        let bytes = match std::fs::read(self.root.join(key)) {
            Ok(bytes) => bytes,
            Err(err) => {
                if err.kind() != io::ErrorKind::NotFound {
                    log::warn!("Failed to read cached tile {key}: {err}");
                }
                index.remove(key);
                return None;
            }
        };
        let last_used = index.touch();
        match index.entries.get_mut(key) {
            Some(entry) => entry.last_used = last_used,
            None => index.insert(key.to_string(), bytes.len() as u64),
        }
        Some(bytes)
    }

    pub fn put(&self, key: &str, bytes: &[u8]) -> io::Result<()> {
        let mut index = self.index();
        write_atomic(&self.root.join(key), bytes)?;
        index.insert(key.to_string(), bytes.len() as u64);
        if index.total_bytes > self.cap_bytes {
            self.evict(&mut index, key);
        }
        Ok(())
    }

    /// Removes the least recently used tiles until the cache is at
    /// `EVICT_TO_PERCENT` of its cap. `keep` (the tile just written) stays.
    fn evict(&self, index: &mut Index, keep: &str) {
        let target = self.cap_bytes / 100 * EVICT_TO_PERCENT;
        let mut by_age: Vec<(u64, String)> = index
            .entries
            .iter()
            .filter(|(key, _)| key.as_str() != keep)
            .map(|(key, entry)| (entry.last_used, key.clone()))
            .collect();
        by_age.sort_unstable();
        for (_, key) in by_age {
            if index.total_bytes <= target {
                break;
            }
            match std::fs::remove_file(self.root.join(&key)) {
                Ok(()) => index.remove(&key),
                Err(err) if err.kind() == io::ErrorKind::NotFound => index.remove(&key),
                Err(err) => log::warn!("Failed to evict cached tile {key}: {err}"),
            }
        }
    }

    pub fn info(&self) -> TileCacheInfo {
        let index = self.index();
        TileCacheInfo {
            size_bytes: index.total_bytes,
            tile_count: index.entries.len() as u64,
            cap_bytes: self.cap_bytes,
        }
    }

    /// Moves the folder aside and deletes it, so the cache is empty at once
    /// even when deleting many files takes a while.
    pub fn clear(&self) -> io::Result<TileCacheInfo> {
        let mut index = self.index();
        let trash = self
            .root
            .with_file_name(format!("{TRASH_PREFIX}{}", uuid::Uuid::new_v4().simple()));
        match std::fs::rename(&self.root, &trash) {
            Ok(()) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
        *index = Index {
            loaded: true,
            ..Index::default()
        };
        drop(index);
        // The cache is already empty; a folder that cannot be deleted now is
        // deleted at the next start.
        if trash.exists() {
            if let Err(err) = std::fs::remove_dir_all(&trash) {
                log::warn!("Failed to delete {}: {err}", trash.display());
            }
        }
        Ok(self.info())
    }
}

fn scan(root: &Path, dir: &Path, found: &mut Vec<(String, u64, SystemTime)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_dir() {
            scan(root, &path, found);
        } else if is_temp_file(&path) {
            let _ = std::fs::remove_file(&path);
        } else if let Ok(relative) = path.strip_prefix(root) {
            let key = relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            found.push((key, meta.len(), modified));
        }
    }
}

/// An upstream answer, before it is checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

pub trait TileFetcher: Send + Sync + 'static {
    fn fetch(&self, url: reqwest::Url) -> impl Future<Output = Result<Fetched, String>> + Send;
}

pub struct HttpFetcher {
    /// A client that could not be built is kept as its error: falling back
    /// to a default client would follow redirects to any host.
    client: Result<reqwest::Client, String>,
}

fn client_builder() -> reqwest::ClientBuilder {
    // Redirects are followed only to allowlisted hosts.
    let redirects = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 3 {
            attempt.error("too many redirects")
        } else if is_allowed_upstream(attempt.url()) {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    reqwest::Client::builder()
        .user_agent(format!(
            "VisTracer/{} (+https://github.com/rush-skills/vistracer)",
            env!("CARGO_PKG_VERSION")
        ))
        .redirect(redirects)
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
}

impl Default for HttpFetcher {
    fn default() -> Self {
        Self {
            client: client_builder()
                .build()
                .map_err(|e| format!("cannot create the HTTP client: {e}")),
        }
    }
}

impl TileFetcher for HttpFetcher {
    async fn fetch(&self, url: reqwest::Url) -> Result<Fetched, String> {
        let client = self.client.as_ref().map_err(Clone::clone)?;
        let mut response = client.get(url).send().await.map_err(|e| e.to_string())?;
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if body.len() + chunk.len() > MAX_TILE_BYTES {
                return Err(format!("response larger than {MAX_TILE_BYTES} bytes"));
            }
            body.extend_from_slice(&chunk);
        }
        Ok(Fetched {
            status,
            content_type,
            body,
        })
    }
}

#[derive(Debug, Default)]
struct Breaker {
    failures: u32,
    paused_until: Option<Instant>,
}

impl Breaker {
    fn is_paused(&self, now: Instant) -> bool {
        self.paused_until.is_some_and(|until| now < until)
    }

    fn record(&mut self, ok: bool, now: Instant) {
        if ok {
            self.failures = 0;
            self.paused_until = None;
            return;
        }
        self.failures += 1;
        if self.failures >= BREAKER_THRESHOLD {
            self.failures = 0;
            self.paused_until = now.checked_add(BREAKER_PAUSE);
            log::warn!(
                "Imagery server failed {BREAKER_THRESHOLD} times in a row; using cached and bundled imagery for {} s",
                BREAKER_PAUSE.as_secs()
            );
        }
    }
}

pub struct Tile {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

fn is_image(layer: &TileLayer, fetched: &Fetched) -> bool {
    let type_ok = fetched
        .content_type
        .as_deref()
        .is_some_and(|value| value.starts_with(layer.content_type));
    let magic_ok = match layer.content_type {
        "image/jpeg" => fetched.body.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => fetched.body.starts_with(b"\x89PNG"),
        _ => false,
    };
    type_ok && magic_ok
}

pub struct TileService<F> {
    store: Arc<TileStore>,
    fetcher: F,
    /// One fetch per tile at a time; later requests wait and read the cache.
    in_flight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    breaker: Mutex<Breaker>,
}

impl<F: TileFetcher> TileService<F> {
    pub fn new(store: TileStore, fetcher: F) -> Self {
        Self {
            store: Arc::new(store),
            fetcher,
            in_flight: Mutex::new(HashMap::new()),
            breaker: Mutex::new(Breaker::default()),
        }
    }

    fn breaker(&self) -> MutexGuard<'_, Breaker> {
        self.breaker.lock().unwrap_or_else(|e| e.into_inner())
    }

    async fn cached(&self, key: &str) -> Option<Vec<u8>> {
        let store = self.store.clone();
        let key = key.to_string();
        tokio::task::spawn_blocking(move || store.get(&key))
            .await
            .ok()
            .flatten()
    }

    pub async fn serve(&self, uri: &Uri) -> Result<Tile, TileError> {
        let address = parse_tile_uri(uri)?;
        let content_type = address.layer.content_type;
        let key = address.cache_key();
        if let Some(bytes) = self.cached(&key).await {
            return Ok(Tile {
                bytes,
                content_type,
            });
        }

        let gate = {
            let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
            in_flight.entry(key.clone()).or_default().clone()
        };
        let result = {
            let _turn = gate.lock().await;
            match self.cached(&key).await {
                Some(bytes) => Ok(bytes),
                None => self.fetch_and_store(&address, &key).await,
            }
        };
        {
            let mut in_flight = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
            // The map and this task hold the gate: nobody else waits for it.
            if Arc::strong_count(&gate) == 2 {
                in_flight.remove(&key);
            }
        }
        result.map(|bytes| Tile {
            bytes,
            content_type,
        })
    }

    async fn fetch_and_store(
        &self,
        address: &TileAddress,
        key: &str,
    ) -> Result<Vec<u8>, TileError> {
        if self.breaker().is_paused(Instant::now()) {
            return Err(TileError::Paused);
        }
        let url = address.upstream_url();
        if !is_allowed_upstream(&url) {
            return Err(TileError::BadHost);
        }
        let fetched = match self.fetcher.fetch(url).await {
            Ok(fetched) => fetched,
            Err(message) => {
                self.breaker().record(false, Instant::now());
                return Err(TileError::Upstream(message));
            }
        };
        let server_failed = fetched.status == 429 || fetched.status >= 500;
        self.breaker().record(!server_failed, Instant::now());
        if fetched.status == 404 {
            return Err(TileError::NotFound);
        }
        if fetched.status != 200 {
            return Err(TileError::Upstream(format!("HTTP {}", fetched.status)));
        }
        if !is_image(address.layer, &fetched) {
            return Err(TileError::Upstream(format!(
                "expected {}, got {}",
                address.layer.content_type,
                fetched.content_type.as_deref().unwrap_or("no content type")
            )));
        }
        let store = self.store.clone();
        let key = key.to_string();
        let bytes = fetched.body;
        let stored = bytes.clone();
        // A failed write only costs a later download, so the tile is served
        // either way.
        match tokio::task::spawn_blocking(move || store.put(&key, &stored)).await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => log::warn!("Failed to cache tile: {err}"),
            Err(err) => log::warn!("Tile cache write task failed: {err}"),
        }
        Ok(bytes)
    }

    pub async fn info(&self) -> Result<TileCacheInfo, String> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.info())
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn clear(&self) -> Result<TileCacheInfo, String> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            store.clear().map_err(|err| {
                format!(
                    "Could not clear the tile cache in {}: {err}",
                    store.root.display()
                )
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// The response for the webview. The tile scheme is another origin than the
/// app, so every response allows cross-origin reads; WebGL needs that to
/// use the image as a texture.
pub fn into_response(result: Result<Tile, TileError>) -> Response<Vec<u8>> {
    let builder = Response::builder().header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    let response = match result {
        Ok(tile) => builder
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, tile.content_type)
            .body(tile.bytes),
        Err(err) => builder
            .status(err.status())
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .body(err.message().into_bytes()),
    };
    response.unwrap_or_else(|_| {
        let mut fallback = Response::new(Vec::new());
        *fallback.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
        fallback
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const JPEG: &[u8] = &[0xff, 0xd8, 0xff, 0xe0, 0, 0x10, b'J', b'F', b'I', b'F'];

    fn temp_root(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("vistracer-{name}-{}", uuid::Uuid::new_v4()))
            .join("tiles")
    }

    fn uri(text: &str) -> Uri {
        text.parse().unwrap()
    }

    fn jpeg(size: usize, fill: u8) -> Vec<u8> {
        let mut bytes = JPEG.to_vec();
        bytes.resize(size, fill);
        bytes
    }

    #[derive(Clone)]
    enum Reply {
        Ok(Fetched),
        Fail(&'static str),
    }

    /// Answers every request with `reply` after `delay`, counting calls.
    struct FakeFetcher {
        reply: Mutex<Reply>,
        delay: Duration,
        calls: AtomicUsize,
        urls: Mutex<Vec<String>>,
    }

    impl FakeFetcher {
        fn new(reply: Reply) -> Self {
            Self {
                reply: Mutex::new(reply),
                delay: Duration::ZERO,
                calls: AtomicUsize::new(0),
                urls: Mutex::new(Vec::new()),
            }
        }

        fn image(body: Vec<u8>) -> Self {
            Self::new(Reply::Ok(Fetched {
                status: 200,
                content_type: Some("image/jpeg".into()),
                body,
            }))
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl TileFetcher for FakeFetcher {
        async fn fetch(&self, url: reqwest::Url) -> Result<Fetched, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.urls.lock().unwrap().push(url.to_string());
            tokio::time::sleep(self.delay).await;
            let reply = self.reply.lock().unwrap().clone();
            match reply {
                Reply::Ok(fetched) => Ok(fetched),
                Reply::Fail(message) => Err(message.to_string()),
            }
        }
    }

    fn files_on_disk(root: &Path) -> Vec<(String, u64)> {
        let mut found = Vec::new();
        scan(root, root, &mut found);
        let mut files: Vec<_> = found.into_iter().map(|(k, size, _)| (k, size)).collect();
        files.sort();
        files
    }

    fn temp_files(dir: &Path) -> usize {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return 0;
        };
        entries
            .flatten()
            .map(|entry| {
                let path = entry.path();
                if path.is_dir() {
                    temp_files(&path)
                } else {
                    usize::from(is_temp_file(&path))
                }
            })
            .sum()
    }

    #[test]
    fn parses_tile_addresses_on_every_platform() {
        let address = parse_tile_uri(&uri("vistiles://localhost/blue-marble/5/12/17.jpg")).unwrap();
        assert_eq!((address.z, address.y, address.x), (5, 12, 17));
        assert_eq!(address.cache_key(), "blue-marble/5/12/17.jpg");
        assert_eq!(
            address.upstream_url().as_str(),
            "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/5/12/17.jpeg"
        );
        // Windows serves custom schemes as http(s)://<scheme>.localhost.
        for windows in [
            "http://vistiles.localhost/blue-marble/0/0/0.jpg",
            "https://vistiles.localhost/blue-marble/8/255/255.jpg",
        ] {
            assert!(parse_tile_uri(&uri(windows)).is_ok(), "{windows}");
        }
    }

    #[test]
    fn rejects_other_hosts_and_bad_paths() {
        let cases = [
            (
                "vistiles://evil.example/blue-marble/1/0/0.jpg",
                TileError::BadHost,
            ),
            (
                "https://gibs.earthdata.nasa.gov/blue-marble/1/0/0.jpg",
                TileError::BadHost,
            ),
            (
                "vistiles://localhost/https://evil.example/1/0/0.jpg",
                TileError::BadPath,
            ),
            (
                "vistiles://localhost/evil.example/1/0/0.jpg",
                TileError::UnknownLayer,
            ),
            (
                "vistiles://localhost/blue-marble/1/0/../0.jpg",
                TileError::BadPath,
            ),
            (
                "vistiles://localhost/blue-marble/1/0/%2e%2e.jpg",
                TileError::BadPath,
            ),
            (
                "vistiles://localhost/blue-marble/1/0/0.png",
                TileError::BadPath,
            ),
            ("vistiles://localhost/blue-marble/1/0/0", TileError::BadPath),
            (
                "vistiles://localhost/blue-marble/1/0/-1.jpg",
                TileError::BadPath,
            ),
            (
                "vistiles://localhost/blue-marble/1/0/+1.jpg",
                TileError::BadPath,
            ),
            (
                "vistiles://localhost/blue-marble/1/0/0/0.jpg",
                TileError::BadPath,
            ),
            (
                "vistiles://localhost/blue-marble/1/0.jpg",
                TileError::BadPath,
            ),
            (
                "vistiles://localhost/blue-marble/9/0/0.jpg",
                TileError::OutOfRange,
            ),
            (
                "vistiles://localhost/blue-marble/2/4/0.jpg",
                TileError::OutOfRange,
            ),
            (
                "vistiles://localhost/blue-marble/2/0/4.jpg",
                TileError::OutOfRange,
            ),
            (
                "vistiles://localhost/blue-marble/1/0/9999999.jpg",
                TileError::BadPath,
            ),
        ];
        for (text, expected) in cases {
            assert_eq!(parse_tile_uri(&uri(text)), Err(expected), "{text}");
        }
    }

    #[test]
    fn only_allowlisted_https_hosts_are_upstream() {
        for layer in TILE_LAYERS {
            let address = TileAddress {
                layer,
                z: 3,
                y: 1,
                x: 2,
            };
            assert!(is_allowed_upstream(&address.upstream_url()));
        }
        for url in [
            "http://gibs.earthdata.nasa.gov/x.jpeg",
            "https://evil.example/x.jpeg",
            "https://gibs.earthdata.nasa.gov.evil.example/x.jpeg",
            "https://gibs.earthdata.nasa.gov@evil.example/x.jpeg",
            "https://user@gibs.earthdata.nasa.gov/x.jpeg",
            "https://gibs.earthdata.nasa.gov:8443/x.jpeg",
        ] {
            assert!(
                !is_allowed_upstream(&reqwest::Url::parse(url).unwrap()),
                "{url}"
            );
        }
    }

    #[tokio::test]
    async fn a_miss_fetches_once_and_a_hit_reads_the_disk() {
        let root = temp_root("tiles-hit");
        let body = jpeg(1000, 7);
        let service = TileService::new(
            TileStore::new(root.clone(), DEFAULT_CAP_BYTES),
            FakeFetcher::image(body.clone()),
        );
        let request = uri("vistiles://localhost/blue-marble/4/3/9.jpg");

        let first = service.serve(&request).await.unwrap();
        assert_eq!(first.bytes, body);
        assert_eq!(first.content_type, "image/jpeg");
        assert_eq!(service.fetcher.calls(), 1);
        assert_eq!(
            service.fetcher.urls.lock().unwrap()[0],
            "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/4/3/9.jpeg"
        );

        let second = service.serve(&request).await.unwrap();
        assert_eq!(second.bytes, body);
        assert_eq!(
            service.fetcher.calls(),
            1,
            "the second request is a cache hit"
        );
        assert_eq!(
            files_on_disk(&root),
            vec![("blue-marble/4/3/9.jpg".into(), 1000)]
        );

        // A new process finds the tile on disk.
        let reopened = TileStore::new(root.clone(), DEFAULT_CAP_BYTES);
        assert_eq!(reopened.get("blue-marble/4/3/9.jpg"), Some(body));
        assert_eq!(
            reopened.info(),
            TileCacheInfo {
                size_bytes: 1000,
                tile_count: 1,
                cap_bytes: DEFAULT_CAP_BYTES
            }
        );
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn errors_and_non_images_are_never_cached() {
        let root = temp_root("tiles-errors");
        let request = uri("vistiles://localhost/blue-marble/2/1/1.jpg");
        let replies = [
            (
                Reply::Ok(Fetched {
                    status: 404,
                    content_type: Some("text/xml".into()),
                    body: b"<x/>".to_vec(),
                }),
                TileError::NotFound,
            ),
            (
                Reply::Ok(Fetched {
                    status: 400,
                    content_type: Some("text/xml".into()),
                    body: b"<ExceptionReport/>".to_vec(),
                }),
                TileError::Upstream("HTTP 400".into()),
            ),
            (
                // A 200 with an error page is not a tile.
                Reply::Ok(Fetched {
                    status: 200,
                    content_type: Some("text/html".into()),
                    body: b"<html>".to_vec(),
                }),
                TileError::Upstream("expected image/jpeg, got text/html".into()),
            ),
            (
                // The right content type with the wrong bytes is not a tile either.
                Reply::Ok(Fetched {
                    status: 200,
                    content_type: Some("image/jpeg".into()),
                    body: b"GIF89a".to_vec(),
                }),
                TileError::Upstream("expected image/jpeg, got image/jpeg".into()),
            ),
            (
                Reply::Fail("connection refused"),
                TileError::Upstream("connection refused".into()),
            ),
        ];
        for (reply, expected) in replies {
            let service = TileService::new(
                TileStore::new(root.clone(), DEFAULT_CAP_BYTES),
                FakeFetcher::new(reply),
            );
            assert_eq!(service.serve(&request).await.err(), Some(expected));
        }
        assert!(files_on_disk(&root).is_empty());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[tokio::test]
    async fn bad_requests_never_reach_upstream() {
        let root = temp_root("tiles-reject");
        let service = TileService::new(
            TileStore::new(root.clone(), DEFAULT_CAP_BYTES),
            FakeFetcher::image(jpeg(100, 1)),
        );
        for text in [
            "vistiles://evil.example/blue-marble/1/0/0.jpg",
            "vistiles://localhost/../../etc/passwd",
            "vistiles://localhost/blue-marble/1/0/..%2f..%2fx.jpg",
            "vistiles://localhost/osm/1/0/0.png",
        ] {
            let response = into_response(service.serve(&uri(text)).await);
            assert!(
                response.status().is_client_error(),
                "{text}: {}",
                response.status()
            );
        }
        assert_eq!(service.fetcher.calls(), 0);
        assert!(!root.exists(), "nothing is written for a rejected request");
    }

    #[test]
    fn eviction_keeps_the_cache_under_its_cap_and_drops_the_least_recently_used() {
        let root = temp_root("tiles-evict");
        let store = TileStore::new(root.clone(), 10_000);
        for i in 0..5 {
            store
                .put(&format!("blue-marble/3/0/{i}.jpg"), &jpeg(2_000, i))
                .unwrap();
        }
        assert_eq!(store.info().size_bytes, 10_000);
        // Reading tile 0 makes tile 1 the least recently used.
        assert!(store.get("blue-marble/3/0/0.jpg").is_some());
        store.put("blue-marble/3/0/5.jpg", &jpeg(2_000, 5)).unwrap();

        let info = store.info();
        assert!(
            info.size_bytes <= 9_000,
            "evicts down to 90 % of the cap: {info:?}"
        );
        let on_disk = files_on_disk(&root);
        let keys: Vec<&str> = on_disk.iter().map(|(key, _)| key.as_str()).collect();
        assert_eq!(
            keys,
            [
                "blue-marble/3/0/0.jpg",
                "blue-marble/3/0/3.jpg",
                "blue-marble/3/0/4.jpg",
                "blue-marble/3/0/5.jpg"
            ]
        );
        assert_eq!(
            info.size_bytes,
            on_disk.iter().map(|(_, size)| size).sum::<u64>()
        );
        assert_eq!(info.tile_count, 4);

        // A tile larger than the whole cap is kept alone rather than lost.
        store
            .put("blue-marble/3/1/0.jpg", &jpeg(12_000, 9))
            .unwrap();
        assert_eq!(files_on_disk(&root).len(), 1);
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn scan_counts_existing_files_and_removes_crash_leftovers() {
        let root = temp_root("tiles-scan");
        std::fs::create_dir_all(root.join("blue-marble/1/0")).unwrap();
        std::fs::write(root.join("blue-marble/1/0/0.jpg"), jpeg(300, 1)).unwrap();
        std::fs::write(root.join("blue-marble/1/0/1.jpg.0123abcd.tmp"), b"half").unwrap();
        let store = TileStore::new(root.clone(), DEFAULT_CAP_BYTES);
        assert_eq!(store.info().tile_count, 1);
        assert_eq!(store.info().size_bytes, 300);
        assert_eq!(temp_files(&root), 0);
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn first_use_deletes_folders_an_interrupted_clear_left_behind() {
        let root = temp_root("tiles-trash");
        let parent = root.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(root.join("blue-marble/1/0")).unwrap();
        std::fs::write(root.join("blue-marble/1/0/0.jpg"), jpeg(300, 1)).unwrap();
        let trash = parent.join(format!("{TRASH_PREFIX}0123abcd"));
        std::fs::create_dir_all(trash.join("blue-marble/2/0")).unwrap();
        std::fs::write(trash.join("blue-marble/2/0/0.jpg"), jpeg(300, 2)).unwrap();
        std::fs::write(parent.join("enrichment-cache.json"), b"{}").unwrap();

        let store = TileStore::new(root.clone(), DEFAULT_CAP_BYTES);
        assert_eq!(store.info().tile_count, 1);
        assert!(!trash.exists());
        assert!(
            parent.join("enrichment-cache.json").exists(),
            "other files stay"
        );
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[tokio::test]
    async fn clear_empties_the_cache_and_later_tiles_are_cached_again() {
        let root = temp_root("tiles-clear");
        let service = TileService::new(
            TileStore::new(root.clone(), DEFAULT_CAP_BYTES),
            FakeFetcher::image(jpeg(500, 3)),
        );
        for x in 0..3 {
            let request = uri(&format!("vistiles://localhost/blue-marble/2/0/{x}.jpg"));
            service.serve(&request).await.unwrap();
        }
        assert_eq!(service.info().await.unwrap().tile_count, 3);

        let cleared = service.clear().await.unwrap();
        assert_eq!((cleared.size_bytes, cleared.tile_count), (0, 0));
        assert!(files_on_disk(&root).is_empty());
        let siblings = std::fs::read_dir(root.parent().unwrap()).unwrap().count();
        assert_eq!(siblings, 0, "the moved-aside folder is deleted");

        service
            .serve(&uri("vistiles://localhost/blue-marble/2/0/0.jpg"))
            .await
            .unwrap();
        assert_eq!(
            service.fetcher.calls(),
            4,
            "a cleared tile is fetched again"
        );
        assert_eq!(service.info().await.unwrap().tile_count, 1);
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_requests_for_one_tile_fetch_it_once() {
        let root = temp_root("tiles-same");
        let body = jpeg(4_000, 5);
        let mut fetcher = FakeFetcher::image(body.clone());
        fetcher.delay = Duration::from_millis(50);
        let service = Arc::new(TileService::new(
            TileStore::new(root.clone(), DEFAULT_CAP_BYTES),
            fetcher,
        ));

        let tasks: Vec<_> = (0..16)
            .map(|_| {
                let service = service.clone();
                tokio::spawn(async move {
                    service
                        .serve(&uri("vistiles://localhost/blue-marble/6/20/33.jpg"))
                        .await
                        .map(|tile| tile.bytes)
                })
            })
            .collect();
        for task in tasks {
            assert_eq!(task.await.unwrap().unwrap(), body);
        }
        assert_eq!(service.fetcher.calls(), 1);
        assert_eq!(
            files_on_disk(&root),
            vec![("blue-marble/6/20/33.jpg".into(), 4_000)]
        );
        assert_eq!(temp_files(&root), 0);
        assert!(service.in_flight.lock().unwrap().is_empty());
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_writes_of_many_tiles_keep_disk_and_index_in_step() {
        let root = temp_root("tiles-many");
        let mut fetcher = FakeFetcher::image(jpeg(1_000, 2));
        fetcher.delay = Duration::from_millis(5);
        // Room for 20 tiles; 64 arrive concurrently, so eviction runs while
        // other writes are in progress.
        let service = Arc::new(TileService::new(
            TileStore::new(root.clone(), 20_000),
            fetcher,
        ));
        let tasks: Vec<_> = (0..64u32)
            .map(|i| {
                let service = service.clone();
                tokio::spawn(async move {
                    let request =
                        format!("vistiles://localhost/blue-marble/6/{}/{}.jpg", i / 8, i % 8);
                    service
                        .serve(&uri(&request))
                        .await
                        .map(|tile| tile.bytes.len())
                })
            })
            .collect();
        for task in tasks {
            assert_eq!(task.await.unwrap().unwrap(), 1_000);
        }
        let info = service.info().await.unwrap();
        let on_disk = files_on_disk(&root);
        assert!(info.size_bytes <= 20_000, "{info:?}");
        assert_eq!(info.tile_count as usize, on_disk.len());
        assert_eq!(
            info.size_bytes,
            on_disk.iter().map(|(_, size)| size).sum::<u64>()
        );
        assert_eq!(temp_files(&root), 0);
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    /// Serves one canned HTTP response per connection and counts requests
    /// per path.
    async fn mock_upstream(
        reply: impl Fn(&str, u16) -> Vec<u8> + Send + Sync + 'static,
    ) -> (std::net::SocketAddr, Arc<Mutex<Vec<String>>>) {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let paths = Arc::new(Mutex::new(Vec::new()));
        let seen = paths.clone();
        let reply = Arc::new(reply);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let reply = reply.clone();
                let seen = seen.clone();
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stream);
                    let mut request_line = String::new();
                    let _ = reader.read_line(&mut request_line).await;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                    }
                    let path = request_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    seen.lock().unwrap().push(path.clone());
                    let mut stream = reader.into_inner();
                    let _ = stream.write_all(&reply(&path, addr.port())).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        (addr, paths)
    }

    fn http_reply(status: &str, headers: &[(&str, String)], body: &[u8]) -> Vec<u8> {
        let mut head = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n",
            body.len()
        );
        for (name, value) in headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str("\r\n");
        let mut bytes = head.into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    #[tokio::test]
    async fn http_fetcher_reads_images_caps_the_size_and_never_follows_other_hosts() {
        let (addr, paths) = mock_upstream(|path, port| match path {
            "/tile" => http_reply("200 OK", &[("Content-Type", "image/jpeg".into())], JPEG),
            "/huge" => http_reply(
                "200 OK",
                &[("Content-Type", "image/jpeg".into())],
                &jpeg(MAX_TILE_BYTES + 1, 0),
            ),
            "/redirect" => http_reply(
                "302 Found",
                &[("Location", format!("http://127.0.0.1:{port}/elsewhere"))],
                b"",
            ),
            _ => http_reply("500 Internal Server Error", &[], b""),
        })
        .await;
        let fetcher = HttpFetcher {
            client: Ok(client_builder().no_proxy().build().unwrap()),
        };
        let url = |path: &str| reqwest::Url::parse(&format!("http://{addr}{path}")).unwrap();

        let tile = fetcher.fetch(url("/tile")).await.unwrap();
        assert_eq!(tile.status, 200);
        assert_eq!(tile.content_type.as_deref(), Some("image/jpeg"));
        assert_eq!(tile.body, JPEG);

        let huge = fetcher.fetch(url("/huge")).await;
        assert!(huge.unwrap_err().contains("larger than"));

        let redirect = fetcher.fetch(url("/redirect")).await.unwrap();
        assert_eq!(
            redirect.status, 302,
            "a redirect off the allowlist is not followed"
        );
        assert!(!paths.lock().unwrap().contains(&"/elsewhere".to_string()));

        let broken = HttpFetcher {
            client: Err("no TLS backend".into()),
        };
        assert_eq!(
            broken.fetch(url("/tile")).await.err().as_deref(),
            Some("no TLS backend")
        );
    }

    #[tokio::test]
    async fn repeated_upstream_failures_pause_fetching() {
        let root = temp_root("tiles-breaker");
        let service = TileService::new(
            TileStore::new(root.clone(), DEFAULT_CAP_BYTES),
            FakeFetcher::new(Reply::Fail("dns error")),
        );
        for x in 0..BREAKER_THRESHOLD {
            let request = uri(&format!("vistiles://localhost/blue-marble/3/0/{x}.jpg"));
            assert!(matches!(
                service.serve(&request).await,
                Err(TileError::Upstream(_))
            ));
        }
        let request = uri("vistiles://localhost/blue-marble/3/1/0.jpg");
        assert_eq!(service.serve(&request).await.err(), Some(TileError::Paused));
        assert_eq!(service.fetcher.calls(), BREAKER_THRESHOLD as usize);
        let response = into_response(service.serve(&request).await);
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    /// Fetches one real GIBS tile through the whole service, twice:
    /// `cargo test smoke_real_gibs_tile -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "network: downloads one tile from NASA GIBS"]
    async fn smoke_real_gibs_tile() {
        let root = temp_root("tiles-smoke");
        let service = TileService::new(
            TileStore::new(root.clone(), DEFAULT_CAP_BYTES),
            HttpFetcher::default(),
        );
        // Level 5 tile over western Europe.
        let request = uri("vistiles://localhost/blue-marble/5/10/16.jpg");
        let started = Instant::now();
        let tile = service.serve(&request).await.expect("GIBS tile");
        let fetched_in = started.elapsed();
        assert!(tile.bytes.starts_with(&[0xff, 0xd8, 0xff]));
        let started = Instant::now();
        let cached = service.serve(&request).await.expect("cached tile");
        assert_eq!(cached.bytes, tile.bytes);
        println!(
            "GIBS tile: {} bytes in {fetched_in:?}; cache hit in {:?}; {:?}",
            tile.bytes.len(),
            started.elapsed(),
            service.info().await.unwrap()
        );
        std::fs::remove_dir_all(root.parent().unwrap()).unwrap();
    }

    #[test]
    fn breaker_resumes_after_the_pause_and_resets_on_success() {
        let start = Instant::now();
        let mut breaker = Breaker::default();
        breaker.record(false, start);
        breaker.record(true, start);
        breaker.record(false, start);
        breaker.record(false, start);
        assert!(!breaker.is_paused(start), "a success resets the count");
        breaker.record(false, start);
        assert!(breaker.is_paused(start));
        assert!(!breaker.is_paused(start + BREAKER_PAUSE));
    }

    #[test]
    fn responses_allow_cross_origin_reads() {
        let ok = into_response(Ok(Tile {
            bytes: JPEG.to_vec(),
            content_type: "image/jpeg",
        }));
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "image/jpeg");
        assert_eq!(ok.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
        let error = into_response(Err(TileError::BadHost));
        assert_eq!(error.status(), StatusCode::FORBIDDEN);
        assert_eq!(error.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    }
}
