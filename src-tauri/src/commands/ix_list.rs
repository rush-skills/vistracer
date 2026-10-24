//! The PeeringDB IX peering LAN list: downloaded in a background task,
//! kept in the provider cache for a day, and matched locally per address.
//!
//! A lookup never waits for a refresh when any list up to
//! `IX_MAX_STALE_MS` old exists; it uses that list and the refresh runs on
//! its own. Only the first download (no list at all) makes lookups wait,
//! for at most the provider budget. The download is a detached task, so a
//! cancelled run does not throw away the lists already fetched.

use super::enrichment_cache::ProviderCache;
use super::integrations::{get_json, peeringdb_headers};
use super::retry::{with_retry, ProviderError, RetryPolicy};
use crate::geoloc::ixp::{build_dataset, IxDataset, IxIndex, IxResponses};
use serde_json::Value;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tokio::sync::{watch, Semaphore};

pub(crate) const IX_CACHE_KEY: &str = "ix-lans";
/// PeeringDB limits repeated anonymous requests for responses above 100 kB
/// to one per hour, so the list is downloaded at most once a day and "Force
/// fresh lookups" does not download it again.
const IX_TTL_MS: i64 = 24 * 3_600_000;
/// An older list is used while a refresh runs or after it failed. The
/// provider cache keeps entries at least this long (`ProviderCache::new`).
pub(crate) const IX_MAX_STALE_MS: i64 = 7 * 24 * 3_600_000;
const IX_FAILURE_BACKOFF: Duration = Duration::from_secs(15 * 60);
/// A 429 means PeeringDB's one-per-hour rule; asking again sooner fails.
const IX_RATE_LIMIT_BACKOFF: Duration = Duration::from_secs(3600);
/// Five requests, each with its own budget and retries, plus the spacing.
const IX_DOWNLOAD_BUDGET: Duration = Duration::from_secs(150);
const IX_OBJECTS: [(&str, &str); 5] = [
    ("ixpfx", "ixlan_id,prefix"),
    ("ixlan", "id,ix_id"),
    ("ix", "id,name,city,country"),
    ("ixfac", "ix_id,fac_id"),
    ("fac", "id,latitude,longitude"),
];

#[derive(Default)]
struct IxState {
    loaded: Option<LoadedIx>,
    downloading: bool,
    last_failure: Option<IxFailure>,
}

/// A failed download, and when PeeringDB may be asked again.
struct IxFailure {
    message: String,
    retry_at: Instant,
}

struct FetchError {
    message: String,
    backoff: Duration,
}

impl FetchError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            backoff: IX_FAILURE_BACKOFF,
        }
    }
}

struct LoadedIx {
    index: Arc<IxIndex>,
    stored_at_ms: i64,
}

/// Waiting for the first download is not a provider failure.
pub enum IxUnavailable {
    Busy,
    Failed(String),
}

pub struct IxLoad {
    pub index: Arc<IxIndex>,
    pub downloaded_now: bool,
    /// Set when an older list is used.
    pub note: Option<String>,
}

pub struct IxStore {
    client: reqwest::Client,
    base_url: String,
    retry: RetryPolicy,
    request_budget: Duration,
    spacing: Duration,
    /// The PeeringDB slot, shared with the per-ASN lookups.
    slot: Arc<Semaphore>,
    cache: Arc<ProviderCache>,
    state: Mutex<IxState>,
    /// Bumped after every finished download.
    done: watch::Sender<u64>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl IxStore {
    pub fn new(
        client: reqwest::Client,
        base_url: String,
        retry: RetryPolicy,
        request_budget: Duration,
        spacing: Duration,
        slot: Arc<Semaphore>,
        cache: Arc<ProviderCache>,
    ) -> Self {
        Self {
            client,
            base_url,
            retry,
            request_budget,
            spacing,
            slot,
            cache,
            state: Mutex::new(IxState::default()),
            done: watch::channel(0).0,
        }
    }

    fn state(&self) -> MutexGuard<'_, IxState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The IX index for a lookup. See the module documentation.
    pub async fn index(self: &Arc<Self>, api_key: Option<&str>) -> Result<IxLoad, IxUnavailable> {
        let mut done = {
            let mut state = self.state();
            let now = now_ms();
            if state.loaded.is_none() {
                if let Some((Some(dataset), stored_at_ms)) = self
                    .cache
                    .get_stored::<IxDataset>(IX_CACHE_KEY, IX_MAX_STALE_MS)
                {
                    state.loaded = Some(LoadedIx {
                        index: Arc::new(IxIndex::new(dataset)),
                        stored_at_ms,
                    });
                }
            }
            // A clock that moved back gives a negative age; count it as new.
            let age = state.loaded.as_ref().map(|l| (now - l.stored_at_ms).max(0));
            if let Some(loaded) = state
                .loaded
                .as_ref()
                .filter(|_| age.is_some_and(|a| a < IX_TTL_MS))
            {
                return Ok(IxLoad {
                    index: loaded.index.clone(),
                    downloaded_now: false,
                    note: None,
                });
            }

            let recent_failure = state
                .last_failure
                .as_ref()
                .filter(|failure| Instant::now() < failure.retry_at)
                .map(|failure| failure.message.clone());
            if !state.downloading && recent_failure.is_none() {
                state.downloading = true;
                tokio::spawn(Arc::clone(self).download(api_key.map(str::to_string)));
            }
            if let (Some(loaded), Some(age)) = (state.loaded.as_ref(), age) {
                if age < IX_MAX_STALE_MS {
                    let hours = age / 3_600_000;
                    let note = match &recent_failure {
                        Some(failure) => format!(
                            "Using the IX list from {hours} h ago; refresh failed: {failure}."
                        ),
                        None => format!(
                            "Using the IX list from {hours} h ago while a newer one downloads."
                        ),
                    };
                    return Ok(IxLoad {
                        index: loaded.index.clone(),
                        downloaded_now: false,
                        note: Some(note),
                    });
                }
            }
            if let Some(failure) = recent_failure {
                return Err(IxUnavailable::Failed(failure));
            }
            self.done.subscribe()
        };

        // No usable list yet: wait for the download that is running.
        if !matches!(
            tokio::time::timeout(self.request_budget, done.changed()).await,
            Ok(Ok(()))
        ) {
            return Err(IxUnavailable::Busy);
        }
        let state = self.state();
        match (&state.loaded, &state.last_failure) {
            (Some(loaded), _) if (now_ms() - loaded.stored_at_ms).max(0) < IX_TTL_MS => {
                Ok(IxLoad {
                    index: loaded.index.clone(),
                    downloaded_now: true,
                    note: None,
                })
            }
            (_, Some(failure)) => Err(IxUnavailable::Failed(failure.message.clone())),
            _ => Err(IxUnavailable::Busy),
        }
    }

    async fn download(self: Arc<Self>, api_key: Option<String>) {
        let result = tokio::time::timeout(IX_DOWNLOAD_BUDGET, self.fetch(api_key.as_deref()))
            .await
            .unwrap_or_else(|_| Err(FetchError::new("the download took too long")));
        let downloaded = result.is_ok();
        {
            let mut state = self.state();
            state.downloading = false;
            match result {
                Ok(dataset) => {
                    self.cache.insert(IX_CACHE_KEY, Some(dataset.clone()));
                    let index = Arc::new(IxIndex::new(dataset));
                    log::info!(
                        "Loaded {} IX peering LAN prefixes from PeeringDB",
                        index.prefix_count()
                    );
                    state.loaded = Some(LoadedIx {
                        index,
                        stored_at_ms: now_ms(),
                    });
                    state.last_failure = None;
                }
                Err(FetchError { message, backoff }) => {
                    log::warn!("PeeringDB IX list download failed: {message}");
                    state.last_failure = Some(IxFailure {
                        message,
                        retry_at: Instant::now() + backoff,
                    });
                }
            }
        }
        if downloaded {
            // Write at once: if the app quits before the run ends, a new
            // download within the hour would be rate limited.
            let cache = self.cache.clone();
            let _ = tokio::task::spawn_blocking(move || cache.persist()).await;
        }
        self.done.send_modify(|generation| *generation += 1);
    }

    /// Downloads the five PeeringDB lists one at a time, each with retries
    /// and the PeeringDB slot. A 429 is final: no retry, and no new download
    /// for at least an hour.
    async fn fetch(&self, api_key: Option<&str>) -> Result<IxDataset, FetchError> {
        let headers = peeringdb_headers(api_key).map_err(|e| FetchError::new(e.describe()))?;
        let base = self.base_url.trim_end_matches('/');
        let mut bodies = Vec::with_capacity(IX_OBJECTS.len());
        for (position, (object, fields)) in IX_OBJECTS.iter().enumerate() {
            if position > 0 {
                tokio::time::sleep(self.spacing).await;
            }
            let url = format!("{base}/api/{object}?fields={fields}");
            let label = format!("PeeringDB {object} list");
            let Ok(Ok(_permit)) =
                tokio::time::timeout(self.request_budget, self.slot.acquire()).await
            else {
                return Err(FetchError::new(
                    "other PeeringDB lookups kept the provider busy",
                ));
            };
            // A 429 ends the attempt as a success value, so `with_retry`
            // does not repeat it within seconds.
            let fetch_once = || {
                let headers = headers.clone();
                let url = url.as_str();
                async move {
                    match get_json(&self.client, url, headers).await {
                        Err(ProviderError::RateLimited { retry_after }) => Ok(Err(retry_after)),
                        other => other.map(Ok),
                    }
                }
            };
            let result = tokio::time::timeout(
                self.request_budget,
                with_retry(&self.retry, &label, fetch_once),
            )
            .await;
            match result {
                Ok(Ok(Ok(Some(body)))) => bodies.push(body),
                Ok(Ok(Ok(None))) => {
                    return Err(FetchError::new(format!(
                        "{object} list not found (HTTP 404)"
                    )))
                }
                Ok(Ok(Err(retry_after))) => {
                    let backoff = IX_RATE_LIMIT_BACKOFF.max(retry_after.unwrap_or_default());
                    return Err(FetchError {
                        message: format!(
                            "{object} list: rate limited by PeeringDB (HTTP 429); next attempt in {} min",
                            backoff.as_secs().div_ceil(60)
                        ),
                        backoff,
                    });
                }
                Ok(Err((err, attempts))) => {
                    let plural = if attempts == 1 { "" } else { "s" };
                    return Err(FetchError::new(format!(
                        "{object} list: {} after {attempts} attempt{plural}",
                        err.describe()
                    )));
                }
                Err(_) => return Err(FetchError::new(format!("{object} list timed out"))),
            }
        }
        let [ixpfx, ixlan, ix, ixfac, fac] = <[Value; 5]>::try_from(bodies)
            .map_err(|_| FetchError::new("incomplete IX download"))?;
        build_dataset(&IxResponses {
            ixpfx,
            ixlan,
            ix,
            ixfac,
            fac,
        })
        .map_err(FetchError::new)
    }

    #[cfg(test)]
    pub fn mark_downloading(&self) {
        self.state().downloading = true;
    }
}
