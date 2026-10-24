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
use super::retry::{with_retry, RetryPolicy};
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
/// An older list is used while a refresh runs or after it failed.
const IX_MAX_STALE_MS: i64 = 7 * 24 * 3_600_000;
const IX_FAILURE_BACKOFF: Duration = Duration::from_secs(15 * 60);
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
    last_failure: Option<(Instant, String)>,
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
            let age = state.loaded.as_ref().map(|l| now - l.stored_at_ms);
            if let Some(loaded) = state
                .loaded
                .as_ref()
                .filter(|_| age.is_some_and(|a| (0..IX_TTL_MS).contains(&a)))
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
                .filter(|(at, _)| at.elapsed() < IX_FAILURE_BACKOFF)
                .map(|(_, message)| message.clone());
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
            (Some(loaded), _) if now_ms() - loaded.stored_at_ms < IX_TTL_MS => Ok(IxLoad {
                index: loaded.index.clone(),
                downloaded_now: true,
                note: None,
            }),
            (_, Some((_, failure))) => Err(IxUnavailable::Failed(failure.clone())),
            _ => Err(IxUnavailable::Busy),
        }
    }

    async fn download(self: Arc<Self>, api_key: Option<String>) {
        let result = tokio::time::timeout(IX_DOWNLOAD_BUDGET, self.fetch(api_key.as_deref()))
            .await
            .unwrap_or_else(|_| Err("the download took too long".to_string()));
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
                Err(message) => {
                    log::warn!("PeeringDB IX list download failed: {message}");
                    state.last_failure = Some((Instant::now(), message));
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
    /// and the PeeringDB slot.
    async fn fetch(&self, api_key: Option<&str>) -> Result<IxDataset, String> {
        let headers = peeringdb_headers(api_key).map_err(|e| e.describe())?;
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
                return Err("other PeeringDB lookups kept the provider busy".to_string());
            };
            let result = tokio::time::timeout(
                self.request_budget,
                with_retry(&self.retry, &label, || {
                    get_json(&self.client, &url, headers.clone())
                }),
            )
            .await;
            match result {
                Ok(Ok(Some(body))) => bodies.push(body),
                Ok(Ok(None)) => return Err(format!("{object} list not found (HTTP 404)")),
                Ok(Err((err, attempts))) => {
                    let plural = if attempts == 1 { "" } else { "s" };
                    return Err(format!(
                        "{object} list: {} after {attempts} attempt{plural}",
                        err.describe()
                    ));
                }
                Err(_) => return Err(format!("{object} list timed out")),
            }
        }
        let [ixpfx, ixlan, ix, ixfac, fac] =
            <[Value; 5]>::try_from(bodies).map_err(|_| "incomplete IX download".to_string())?;
        build_dataset(&IxResponses {
            ixpfx,
            ixlan,
            ix,
            ixfac,
            fac,
        })
    }

    #[cfg(test)]
    pub fn mark_downloading(&self) {
        self.state().downloading = true;
    }
}
