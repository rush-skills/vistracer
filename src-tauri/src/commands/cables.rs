//! The opt-in submarine cable layer: TeleGeography's Submarine Cable Map
//! data (CC BY-NC-SA 3.0), downloaded only after the user turned the layer
//! on and accepted its notice, and kept in `$APPCACHE/submarine-cables.json`.
//!
//! The caller passes whether the download is allowed (`UiPreferences::
//! submarine_cables`, read from the saved settings at each call). While it
//! is not, nothing is read or downloaded. One download runs at a time; a
//! saved copy is used for `CABLE_TTL_MS`, and an older copy is used when a
//! refresh fails.

use crate::atomic_file::write_atomic;
use crate::upstream::{self, Fetcher, HttpFetcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const CABLE_HOSTS: &[&str] = &["www.submarinecablemap.com"];
pub const CABLE_URL: &str = "https://www.submarinecablemap.com/api/v3/cable/cable-geo.json";
/// The file is about 0.75 MB; a much larger answer is not the cable map.
const MAX_CABLE_BYTES: usize = 8 * 1024 * 1024;
const CABLE_TIMEOUT: Duration = Duration::from_secs(30);
/// The map changes a few times a month; one download a week is enough.
const CABLE_TTL_MS: i64 = 7 * 24 * 3_600_000;
/// No new attempt for this long after a failed download.
const FAILURE_BACKOFF: Duration = Duration::from_secs(10 * 60);
/// Coordinates are rounded to 0.01° (about 1 km), enough for the globe.
const COORDINATE_STEP: f64 = 100.0;
const MAX_TEXT_LEN: usize = 200;

/// One cable: all line strings of its features, as `[longitude, latitude]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cable {
    pub id: String,
    pub name: String,
    pub segments: Vec<Vec<[f64; 2]>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmarineCables {
    /// When the data was downloaded, ms since the epoch.
    pub fetched_at: i64,
    pub source: String,
    /// Set when a refresh failed and an older copy is used.
    #[serde(default)]
    pub note: Option<String>,
    pub cables: Vec<Cable>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CableError {
    /// The layer is off or its notice was not accepted.
    NotAllowed,
    Download(String),
}

impl CableError {
    pub fn message(&self) -> String {
        match self {
            Self::NotAllowed => "Submarine cables are off: turn the layer on in Layers and accept its notice. Nothing was downloaded.".to_string(),
            Self::Download(message) => format!(
                "Could not download the cable map from {}: {message}. The app tries again in {} minutes.",
                CABLE_HOSTS[0],
                FAILURE_BACKOFF.as_secs() / 60
            ),
        }
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    (!text.is_empty() && text.chars().count() <= MAX_TEXT_LEN).then(|| text.to_string())
}

fn point(value: &Value) -> Option<[f64; 2]> {
    let pair = value.as_array()?;
    let (lon, lat) = (pair.first()?.as_f64()?, pair.get(1)?.as_f64()?);
    let valid = lon.is_finite()
        && lat.is_finite()
        && (-180.0..=180.0).contains(&lon)
        && (-90.0..=90.0).contains(&lat);
    let round = |v: f64| (v * COORDINATE_STEP).round() / COORDINATE_STEP;
    valid.then(|| [round(lon), round(lat)])
}

/// A line string with at least two valid points, or nothing: a line with a
/// bad point is dropped whole, so no line jumps across the globe.
fn segment(value: &Value) -> Option<Vec<[f64; 2]>> {
    let points: Option<Vec<[f64; 2]>> = value.as_array()?.iter().map(point).collect();
    let mut points = points?;
    points.dedup();
    (points.len() >= 2).then_some(points)
}

fn segments(geometry: &Value) -> Vec<Vec<[f64; 2]>> {
    let coordinates = geometry.get("coordinates");
    match geometry.get("type").and_then(Value::as_str) {
        Some("LineString") => coordinates.and_then(segment).into_iter().collect(),
        Some("MultiLineString") => coordinates
            .and_then(Value::as_array)
            .map(|lines| lines.iter().filter_map(segment).collect())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Parses TeleGeography's `cable-geo.json` (a GeoJSON FeatureCollection).
/// Features without an id, a name or a valid line are skipped; features of
/// one cable are joined. No cable at all is an error.
pub fn parse_cable_geo(body: &[u8]) -> Result<Vec<Cable>, String> {
    let value: Value =
        serde_json::from_slice(body).map_err(|e| format!("the answer is not JSON ({e})"))?;
    let features = value
        .get("features")
        .and_then(Value::as_array)
        .ok_or("the answer has no GeoJSON features")?;
    let mut cables: BTreeMap<String, Cable> = BTreeMap::new();
    for feature in features {
        let properties = feature.get("properties");
        let (Some(id), Some(name)) = (
            text(properties.and_then(|p| p.get("id"))),
            text(properties.and_then(|p| p.get("name"))),
        ) else {
            continue;
        };
        let lines = feature.get("geometry").map(segments).unwrap_or_default();
        if lines.is_empty() {
            continue;
        }
        cables
            .entry(id.clone())
            .or_insert_with(|| Cable {
                id,
                name,
                segments: Vec::new(),
            })
            .segments
            .extend(lines);
    }
    if cables.is_empty() {
        return Err("the answer has no cable with a valid line".to_string());
    }
    Ok(cables.into_values().collect())
}

#[derive(Default)]
struct CableState {
    loaded: Option<Arc<SubmarineCables>>,
    retry_at: Option<(Instant, String)>,
}

pub struct CableService<F> {
    fetcher: F,
    url: reqwest::Url,
    path: PathBuf,
    /// Held during a download, so concurrent calls make one request.
    state: tokio::sync::Mutex<CableState>,
}

pub fn cable_fetcher() -> HttpFetcher {
    HttpFetcher::new(CABLE_HOSTS, MAX_CABLE_BYTES, CABLE_TIMEOUT)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn is_fresh(cables: &SubmarineCables) -> bool {
    (now_ms() - cables.fetched_at).max(0) < CABLE_TTL_MS
}

impl<F: Fetcher> CableService<F> {
    pub fn new(fetcher: F, path: PathBuf) -> Self {
        let url = reqwest::Url::parse(CABLE_URL).expect("CABLE_URL is a valid URL");
        debug_assert!(upstream::is_allowed(&url, CABLE_HOSTS));
        Self {
            fetcher,
            url,
            path,
            state: tokio::sync::Mutex::new(CableState::default()),
        }
    }

    async fn read_disk(&self) -> Option<SubmarineCables> {
        let path = self.path.clone();
        let bytes = tokio::task::spawn_blocking(move || std::fs::read(path))
            .await
            .ok()?
            .ok()?;
        serde_json::from_slice(&bytes)
            .map_err(|e| log::warn!("Ignored the saved cable map: {e}"))
            .ok()
    }

    async fn download(&self) -> Result<SubmarineCables, String> {
        let fetched = self.fetcher.fetch(self.url.clone()).await?;
        if fetched.status != 200 {
            return Err(format!("HTTP {}", fetched.status));
        }
        let cables = parse_cable_geo(&fetched.body)?;
        let data = SubmarineCables {
            fetched_at: now_ms(),
            source: CABLE_URL.to_string(),
            note: None,
            cables,
        };
        match serde_json::to_vec(&data) {
            Ok(bytes) => {
                let path = self.path.clone();
                match tokio::task::spawn_blocking(move || write_atomic(&path, &bytes)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(err)) => log::warn!("Could not save the cable map: {err}"),
                    Err(err) => log::warn!("Cable map write task failed: {err}"),
                }
            }
            Err(err) => log::warn!("Could not encode the cable map: {err}"),
        }
        Ok(data)
    }

    /// The cable map, from memory, the disk or a download. `allowed` comes
    /// from the saved settings; while it is false nothing is read or sent.
    pub async fn get(&self, allowed: bool) -> Result<Arc<SubmarineCables>, CableError> {
        if !allowed {
            return Err(CableError::NotAllowed);
        }
        let mut state = self.state.lock().await;
        if state.loaded.is_none() {
            state.loaded = self.read_disk().await.map(Arc::new);
        }
        if let Some(loaded) = state.loaded.as_ref().filter(|c| is_fresh(c)) {
            return Ok(loaded.clone());
        }
        let backoff = state
            .retry_at
            .as_ref()
            .filter(|(at, _)| Instant::now() < *at)
            .map(|(_, message)| message.clone());
        let failure = match backoff {
            Some(message) => message,
            None => match self.download().await {
                Ok(data) => {
                    let data = Arc::new(data);
                    state.loaded = Some(data.clone());
                    state.retry_at = None;
                    return Ok(data);
                }
                Err(message) => {
                    log::warn!("Submarine cable map download failed: {message}");
                    state.retry_at = Some((Instant::now() + FAILURE_BACKOFF, message.clone()));
                    message
                }
            },
        };
        match &state.loaded {
            Some(older) => Ok(Arc::new(SubmarineCables {
                note: Some(format!(
                    "A refresh failed ({failure}); showing the saved copy."
                )),
                ..(**older).clone()
            })),
            None => Err(CableError::Download(failure)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::upstream::Fetched;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    const FIXTURE: &str = include_str!("../../fixtures/cables/cable-geo-sample.json");

    struct FakeFetcher {
        replies: Mutex<Vec<Result<Fetched, String>>>,
        calls: AtomicUsize,
    }

    impl FakeFetcher {
        fn new(replies: Vec<Result<Fetched, String>>) -> Self {
            Self {
                replies: Mutex::new(replies),
                calls: AtomicUsize::new(0),
            }
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl Fetcher for FakeFetcher {
        async fn fetch(&self, url: reqwest::Url) -> Result<Fetched, String> {
            assert_eq!(url.as_str(), CABLE_URL);
            self.calls.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(5)).await;
            let mut replies = self.replies.lock().unwrap();
            if replies.len() > 1 {
                replies.remove(0)
            } else {
                replies[0].clone()
            }
        }
    }

    fn ok(body: &str) -> Result<Fetched, String> {
        Ok(Fetched {
            status: 200,
            content_type: Some("application/json".into()),
            body: body.as_bytes().to_vec(),
        })
    }

    fn temp_path() -> PathBuf {
        std::env::temp_dir()
            .join(format!("vistracer-cables-{}", uuid::Uuid::new_v4()))
            .join("submarine-cables.json")
    }

    #[test]
    fn the_sample_parses_into_joined_cables() {
        let cables = parse_cable_geo(FIXTURE.as_bytes()).unwrap();
        let ids: Vec<&str> = cables.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["example-atlantic", "example-indian-ocean"]);
        let atlantic = &cables[0];
        assert_eq!(atlantic.name, "Example Atlantic Cable");
        // Two features of one cable are joined; a broken line is dropped.
        assert_eq!(atlantic.segments.len(), 2);
        assert_eq!(atlantic.segments[0][0], [-73.97, 40.59]);
    }

    #[test]
    fn malformed_features_are_skipped_and_an_empty_map_is_an_error() {
        assert!(parse_cable_geo(b"<html>").unwrap_err().contains("not JSON"));
        assert!(parse_cable_geo(br#"{"type":"FeatureCollection"}"#)
            .unwrap_err()
            .contains("no GeoJSON features"));
        let bad = serde_json::json!({ "features": [
            { "properties": { "name": "No id" },
              "geometry": { "type": "LineString", "coordinates": [[0, 0], [1, 1]] } },
            { "properties": { "id": "x", "name": "Off the globe" },
              "geometry": { "type": "LineString", "coordinates": [[0, 0], [190, 1]] } },
            { "properties": { "id": "y", "name": "One point" },
              "geometry": { "type": "MultiLineString", "coordinates": [[[5, 5]]] } },
            { "properties": { "id": "z", "name": "A point" },
              "geometry": { "type": "Point", "coordinates": [5, 5] } },
            { "properties": { "id": "w", "name": "Text coordinates" },
              "geometry": { "type": "LineString", "coordinates": [["5", "5"], [6, 6]] } }
        ]});
        assert!(parse_cable_geo(bad.to_string().as_bytes())
            .unwrap_err()
            .contains("no cable with a valid line"));
    }

    #[tokio::test]
    async fn nothing_is_read_or_downloaded_while_not_allowed() {
        let path = temp_path();
        let service = CableService::new(FakeFetcher::new(vec![ok(FIXTURE)]), path.clone());
        assert_eq!(
            service.get(false).await.unwrap_err(),
            CableError::NotAllowed
        );
        assert_eq!(service.fetcher.calls(), 0);
        assert!(!path.exists());
        assert!(CableError::NotAllowed
            .message()
            .contains("Nothing was downloaded"));
    }

    #[tokio::test]
    async fn one_download_then_memory_and_disk() {
        let path = temp_path();
        let service = CableService::new(FakeFetcher::new(vec![ok(FIXTURE)]), path.clone());
        let (a, b) = tokio::join!(service.get(true), service.get(true));
        assert_eq!(
            service.fetcher.calls(),
            1,
            "concurrent calls share one download"
        );
        assert_eq!(a.unwrap().cables, b.unwrap().cables);
        service.get(true).await.unwrap();
        assert_eq!(service.fetcher.calls(), 1);

        // After a restart the saved copy is used; switched off, it is not.
        let restarted = CableService::new(FakeFetcher::new(vec![ok(FIXTURE)]), path.clone());
        assert_eq!(
            restarted.get(false).await.unwrap_err(),
            CableError::NotAllowed
        );
        let saved = restarted.get(true).await.unwrap();
        assert_eq!(restarted.fetcher.calls(), 0);
        assert_eq!(saved.cables.len(), 2);
        assert_eq!(saved.source, CABLE_URL);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn a_failed_download_backs_off_and_falls_back_to_the_saved_copy() {
        let path = temp_path();
        let failing = CableService::new(
            FakeFetcher::new(vec![
                Ok(Fetched {
                    status: 503,
                    content_type: None,
                    body: Vec::new(),
                }),
                ok(FIXTURE),
            ]),
            path.clone(),
        );
        let error = failing.get(true).await.unwrap_err();
        assert_eq!(error, CableError::Download("HTTP 503".into()));
        assert!(error.message().contains("www.submarinecablemap.com"));
        assert_eq!(failing.get(true).await.unwrap_err(), error, "no retry yet");
        assert_eq!(failing.fetcher.calls(), 1);

        // An expired saved copy: used, with a note, when the refresh fails.
        let old = SubmarineCables {
            fetched_at: now_ms() - CABLE_TTL_MS - 1,
            source: CABLE_URL.into(),
            note: None,
            cables: parse_cable_geo(FIXTURE.as_bytes()).unwrap(),
        };
        write_atomic(&path, &serde_json::to_vec(&old).unwrap()).unwrap();
        let stale = CableService::new(
            FakeFetcher::new(vec![Err("timed out".into())]),
            path.clone(),
        );
        let shown = stale.get(true).await.unwrap();
        assert_eq!(stale.fetcher.calls(), 1);
        assert_eq!(shown.cables, old.cables);
        assert!(shown.note.as_deref().unwrap().contains("timed out"));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn a_damaged_saved_copy_is_replaced() {
        let path = temp_path();
        write_atomic(&path, b"{ not json").unwrap();
        let service = CableService::new(FakeFetcher::new(vec![ok(FIXTURE)]), path.clone());
        assert_eq!(service.get(true).await.unwrap().cables.len(), 2);
        assert_eq!(service.fetcher.calls(), 1);
        let saved: SubmarineCables =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved.cables.len(), 2);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn only_the_cable_host_is_allowed() {
        assert!(upstream::is_allowed(
            &reqwest::Url::parse(CABLE_URL).unwrap(),
            CABLE_HOSTS
        ));
        for url in [
            "http://www.submarinecablemap.com/api/v3/cable/cable-geo.json",
            "https://submarinecablemap.com.evil.example/x",
            "https://www.submarinecablemap.com:8443/x",
            "https://user@www.submarinecablemap.com/x",
        ] {
            assert!(
                !upstream::is_allowed(&reqwest::Url::parse(url).unwrap(), CABLE_HOSTS),
                "{url}"
            );
        }
    }

    /// Downloads the real cable map once:
    /// `cargo test smoke_real_cable_map -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "network: downloads the cable map from www.submarinecablemap.com"]
    async fn smoke_real_cable_map() {
        let path = temp_path();
        let service = CableService::new(cable_fetcher(), path.clone());
        let cables = service.get(true).await.unwrap();
        let points: usize = cables
            .cables
            .iter()
            .flat_map(|c| &c.segments)
            .map(Vec::len)
            .sum();
        println!("{} cables, {points} points", cables.cables.len());
        assert!(cables.cables.len() > 300);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
