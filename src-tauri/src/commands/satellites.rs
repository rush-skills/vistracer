//! The opt-in satellites layer: orbital elements (GP data) of a few
//! satellite groups from CelesTrak, downloaded only after the user turned
//! the layer on and accepted its notice, and kept in `$APPCACHE/satellites/`.
//!
//! CelesTrak's usage policy (celestrak.org/usage-policy.php, read on
//! 2026-10-25) asks apps to download a data set at most once per update
//! (every 2 hours; a second download gets HTTP 403), only when it is
//! needed, and to stop querying after any answer other than HTTP 200. So:
//!
//! - The caller passes a check of whether the group may be downloaded
//!   (`UiPreferences::satellite_group` on the saved settings). It runs when
//!   the call starts, again after the call waited for another request, and
//!   right before the request goes out; while it says no, nothing is read
//!   or sent.
//! - A saved group is used for `SATELLITE_TTL_MS`. A group is requested at
//!   most once in `MIN_REQUEST_INTERVAL_MS`; the time of each request is
//!   saved before the request goes out, so a restart does not ask again.
//! - After an HTTP error (or a 200 that is not GP data), no group is
//!   requested for `HTTP_ERROR_PAUSE_MS`, also across restarts. A failure
//!   that may have reached CelesTrak (a timeout, a broken answer) counts as
//!   a download of that group; only a connection that failed (no request
//!   sent) retries the group after `NETWORK_ERROR_PAUSE_MS`.
//! - When the request log cannot be saved, no request goes out.
//! - One request runs at a time, for all groups.

use crate::atomic_file::write_atomic;
use crate::upstream::{self, FetchError, Fetcher, HttpFetcher};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub const SATELLITE_HOSTS: &[&str] = &["celestrak.org"];
const GP_URL: &str = "https://celestrak.org/NORAD/elements/gp.php";
/// Starlink, the largest group, was 1.70 MB in CSV on 2026-10-25.
const MAX_GROUP_BYTES: usize = 8 * 1024 * 1024;
const SATELLITE_TIMEOUT: Duration = Duration::from_secs(30);
/// A saved group is used this long. GP data changes 2 to 3 times a day.
pub const SATELLITE_TTL_MS: i64 = 12 * 3_600_000;
/// CelesTrak updates GP data every 2 hours and answers a second download
/// of the same data within that time with HTTP 403.
const MIN_REQUEST_INTERVAL_MS: i64 = 2 * 3_600_000;
/// CelesTrak asks apps to stop after an HTTP error; it lifts its temporary
/// blocks within 2 hours.
const HTTP_ERROR_PAUSE_MS: i64 = 2 * 3_600_000;
/// No answer at all (offline, DNS, timeout): the same group again after this.
const NETWORK_ERROR_PAUSE_MS: i64 = 15 * 60_000;
/// Saved times further in the future than this are wrong (the system clock
/// was ahead when they were saved): a copy that new is stale, and a request
/// or pause time that new is counted again from now
/// (`RequestLog::correct_clock`).
const CLOCK_TOLERANCE_MS: i64 = 5 * 60_000;
/// More objects than any group has; bounds what one answer can hold.
const MAX_SATELLITES: usize = 20_000;
const MAX_NAME_LEN: usize = 100;
const MAX_OBJECT_ID_LEN: usize = 20;

/// A group of the layer: its switch in the layer registry (src/renderer/lib/
/// layers.ts) and CelesTrak's `GROUP` name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SatelliteGroupDef {
    pub layer: &'static str,
    pub group: &'static str,
    /// The switch's default, as in the registry.
    pub default_on: bool,
}

pub const SATELLITE_GROUPS: &[SatelliteGroupDef] = &[
    SatelliteGroupDef {
        layer: "satellites-starlink",
        group: "starlink",
        default_on: true,
    },
    SatelliteGroupDef {
        layer: "satellites-oneweb",
        group: "oneweb",
        default_on: false,
    },
    SatelliteGroupDef {
        layer: "satellites-gps",
        group: "gps-ops",
        default_on: true,
    },
    SatelliteGroupDef {
        layer: "satellites-stations",
        group: "stations",
        default_on: true,
    },
    SatelliteGroupDef {
        layer: "satellites-geo",
        group: "geo",
        default_on: false,
    },
];

/// The group of a CelesTrak `GROUP` name; other names are never requested.
pub fn group_def(group: &str) -> Option<&'static SatelliteGroupDef> {
    SATELLITE_GROUPS.iter().find(|def| def.group == group)
}

/// One element set (OMM mean elements for SGP4), checked at the edge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrbitalElements {
    pub norad_id: u32,
    pub name: String,
    /// International designator, e.g. "1998-067A"; empty when unknown.
    pub object_id: String,
    /// UTC, ISO 8601 without a zone, as CelesTrak sends it.
    pub epoch: String,
    /// Revolutions per day.
    pub mean_motion: f64,
    pub eccentricity: f64,
    /// Degrees.
    pub inclination: f64,
    pub raan: f64,
    pub arg_of_pericenter: f64,
    pub mean_anomaly: f64,
    pub bstar: f64,
    pub mean_motion_dot: f64,
    pub mean_motion_ddot: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SatelliteGroup {
    pub group: String,
    /// When the data was downloaded, ms since the epoch.
    pub fetched_at: i64,
    pub source: String,
    /// Set when a newer copy could not be downloaded and this one is older.
    #[serde(default)]
    pub note: Option<String>,
    pub satellites: Vec<OrbitalElements>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SatelliteError {
    /// The layer or the group is off, or the notice was not accepted.
    NotAllowed,
    /// Not one of `SATELLITE_GROUPS`.
    UnknownGroup(String),
    /// No saved copy, and no request may go out before `until` (ms).
    Waiting { until: i64, reason: String },
    /// No saved copy, and the request failed.
    Download { message: String, retry_at: i64 },
}

/// "2026-10-26 18:40 UTC" for a time in ms since the epoch.
fn clock_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|time| time.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_else(|| "later".to_string())
}

/// Whether a copy downloaded at `fetched_at` may be used at `now`. A copy
/// dated in the future (beyond the tolerance) is not: the clock was wrong.
fn is_fresh(fetched_at: i64, now: i64) -> bool {
    let age = now - fetched_at;
    (-CLOCK_TOLERANCE_MS..SATELLITE_TTL_MS).contains(&age)
}

/// How the note names an older copy.
fn copy_age(fetched_at: i64, now: i64) -> String {
    if fetched_at - now > CLOCK_TOLERANCE_MS {
        format!(
            "the saved copy dated {} (the system clock was ahead when it was saved)",
            clock_time(fetched_at)
        )
    } else {
        format!(
            "the copy from {} hours ago",
            (now - fetched_at).max(0) / 3_600_000
        )
    }
}

impl SatelliteError {
    pub fn message(&self) -> String {
        match self {
            Self::NotAllowed => "Satellites are off: turn the layer and the group on in Layers and accept the notice. Nothing was downloaded.".to_string(),
            Self::UnknownGroup(group) => format!("\"{group}\" is not a satellite group of this app. Nothing was downloaded."),
            Self::Waiting { until, reason } => format!(
                "{reason} VisTracer does not ask CelesTrak again before {}.",
                clock_time(*until)
            ),
            Self::Download { message, retry_at } => format!(
                "Could not download the orbital elements from {}: {message}. VisTracer does not ask again before {}.",
                SATELLITE_HOSTS[0],
                clock_time(*retry_at)
            ),
        }
    }
}

/// Fields of CelesTrak's CSV layout (an RFC 4180 line): quoted fields may
/// hold commas and doubled quotes.
fn csv_fields(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, quoted) {
            ('"', true) if chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            ('"', true) => quoted = false,
            ('"', false) if field.is_empty() => quoted = true,
            (',', false) => fields.push(std::mem::take(&mut field)),
            _ => field.push(c),
        }
    }
    fields.push(field);
    fields
}

fn number(text: &str) -> Option<f64> {
    text.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

fn in_range(text: &str, low: f64, high: f64) -> Option<f64> {
    number(text).filter(|v| (low..=high).contains(v))
}

fn plain_text(text: &str, max_len: usize) -> Option<String> {
    let text = text.trim();
    (text.chars().count() <= max_len && !text.chars().any(char::is_control))
        .then(|| text.to_string())
}

/// `YYYY-MM-DDTHH:MM:SS[.ffffff]` in UTC, from 1957 (the first satellite).
fn epoch(text: &str) -> Option<String> {
    let text = text.trim();
    let parsed = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    (1957..=2200)
        .contains(&chrono::Datelike::year(&parsed))
        .then(|| text.to_string())
}

const REQUIRED_COLUMNS: [&str; 13] = [
    "OBJECT_NAME",
    "OBJECT_ID",
    "EPOCH",
    "MEAN_MOTION",
    "ECCENTRICITY",
    "INCLINATION",
    "RA_OF_ASC_NODE",
    "ARG_OF_PERICENTER",
    "MEAN_ANOMALY",
    "NORAD_CAT_ID",
    "BSTAR",
    "MEAN_MOTION_DOT",
    "MEAN_MOTION_DDOT",
];

/// Parses CelesTrak's GP data in CSV (`FORMAT=csv`). Columns are found by
/// their header names. A row with a bad or missing value, a NORAD id seen
/// before, or an ephemeris type other than SGP4 (0) is skipped. No valid
/// row at all, or no GP header, is an error.
pub fn parse_gp_csv(body: &[u8]) -> Result<Vec<OrbitalElements>, String> {
    let text = std::str::from_utf8(body).map_err(|_| "the answer is not UTF-8 text")?;
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    let header = csv_fields(lines.next().ok_or("the answer is empty")?);
    let column: HashMap<&str, usize> = header
        .iter()
        .enumerate()
        .map(|(index, name)| (name.trim(), index))
        .collect();
    if let Some(missing) = REQUIRED_COLUMNS
        .iter()
        .find(|name| !column.contains_key(*name))
    {
        return Err(format!(
            "the answer is not GP data in CSV (no {missing} column)"
        ));
    }
    let ephemeris = column.get("EPHEMERIS_TYPE").copied();
    let mut seen = HashSet::new();
    let mut satellites = Vec::new();
    let mut skipped = 0usize;
    for line in lines {
        let fields = csv_fields(line);
        let get = |name: &str| fields.get(column[name]).map(String::as_str);
        let parsed = (|| {
            if fields.len() != header.len() {
                return None;
            }
            if let Some(index) = ephemeris {
                if fields[index].trim() != "0" {
                    return None;
                }
            }
            let name = plain_text(get("OBJECT_NAME")?, MAX_NAME_LEN).filter(|n| !n.is_empty())?;
            Some(OrbitalElements {
                norad_id: get("NORAD_CAT_ID")?
                    .trim()
                    .parse::<u32>()
                    .ok()
                    .filter(|id| *id > 0)?,
                name,
                object_id: plain_text(get("OBJECT_ID")?, MAX_OBJECT_ID_LEN)?,
                epoch: epoch(get("EPOCH")?)?,
                mean_motion: number(get("MEAN_MOTION")?).filter(|v| *v > 0.0 && *v <= 20.0)?,
                eccentricity: number(get("ECCENTRICITY")?).filter(|v| (0.0..1.0).contains(v))?,
                inclination: in_range(get("INCLINATION")?, 0.0, 180.0)?,
                raan: in_range(get("RA_OF_ASC_NODE")?, 0.0, 360.0)?,
                arg_of_pericenter: in_range(get("ARG_OF_PERICENTER")?, 0.0, 360.0)?,
                mean_anomaly: in_range(get("MEAN_ANOMALY")?, 0.0, 360.0)?,
                bstar: in_range(get("BSTAR")?, -1.0, 1.0)?,
                mean_motion_dot: in_range(get("MEAN_MOTION_DOT")?, -1.0, 1.0)?,
                mean_motion_ddot: in_range(get("MEAN_MOTION_DDOT")?, -1.0, 1.0)?,
            })
        })();
        match parsed {
            Some(elements) if seen.insert(elements.norad_id) => {
                if satellites.len() < MAX_SATELLITES {
                    satellites.push(elements);
                } else {
                    skipped += 1;
                }
            }
            _ => skipped += 1,
        }
    }
    if skipped > 0 {
        log::info!("Skipped {skipped} rows of the CelesTrak answer (malformed, duplicate or over {MAX_SATELLITES}).");
    }
    if satellites.is_empty() {
        return Err("the answer has no valid element set".to_string());
    }
    Ok(satellites)
}

/// When each group was requested, and the pauses after failures. Saved
/// before each request goes out, so the limits hold across restarts.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RequestLog {
    /// Group → last request that got an answer, ms since the epoch.
    requested_at: BTreeMap<String, i64>,
    /// Group → no new request before this (after a network error), and why.
    retry_at: BTreeMap<String, (i64, String)>,
    /// No request to CelesTrak before this (after an HTTP error), and why.
    paused_until: Option<(i64, String)>,
}

impl RequestLog {
    /// Times saved while the system clock was ahead are counted again from
    /// `now`, once: a request time becomes now, a pause its full length from
    /// now. So a wait never lasts longer than its own length and does not
    /// start again on the next call. True when a time changed.
    fn correct_clock(&mut self, now: i64) -> bool {
        let mut changed = false;
        let mut cap = |at: &mut i64, length: i64| {
            if *at > now + length + CLOCK_TOLERANCE_MS {
                *at = now + length;
                changed = true;
            }
        };
        for at in self.requested_at.values_mut() {
            cap(at, 0);
        }
        for (until, _) in self.retry_at.values_mut() {
            cap(until, NETWORK_ERROR_PAUSE_MS);
        }
        if let Some((until, _)) = self.paused_until.as_mut() {
            cap(until, HTTP_ERROR_PAUSE_MS);
        }
        changed
    }
}

#[derive(Default)]
struct SatelliteState {
    log: Option<RequestLog>,
    loaded: HashMap<&'static str, Arc<SatelliteGroup>>,
}

pub struct SatelliteService<F> {
    fetcher: F,
    dir: PathBuf,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
    /// Held during a request, so all groups share one request at a time.
    state: tokio::sync::Mutex<SatelliteState>,
}

pub fn satellite_fetcher() -> HttpFetcher {
    HttpFetcher::new(SATELLITE_HOSTS, MAX_GROUP_BYTES, SATELLITE_TIMEOUT)
}

/// The GP query of a group, from constants and the group table only.
pub fn group_url(def: &SatelliteGroupDef) -> reqwest::Url {
    let mut url = reqwest::Url::parse(GP_URL).expect("GP_URL is a valid URL");
    url.query_pairs_mut()
        .append_pair("GROUP", def.group)
        .append_pair("FORMAT", "csv");
    url
}

async fn read_json<T: serde::de::DeserializeOwned>(path: PathBuf) -> Option<T> {
    let bytes = tokio::task::spawn_blocking(move || std::fs::read(path))
        .await
        .ok()?
        .ok()?;
    serde_json::from_slice(&bytes)
        .map_err(|e| log::warn!("Ignored a saved satellite file: {e}"))
        .ok()
}

/// Saves `value` as JSON; the error says what failed (also logged).
async fn write_json<T: Serialize>(path: PathBuf, value: &T) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(value).map_err(|e| format!("could not encode a satellite file: {e}"))?;
    let result = match tokio::task::spawn_blocking(move || write_atomic(&path, &bytes)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => Err(format!("could not save a satellite file: {err}")),
        Err(err) => Err(format!("the satellite file write task failed: {err}")),
    };
    if let Err(message) = &result {
        log::warn!("{message}");
    }
    result
}

impl<F: Fetcher> SatelliteService<F> {
    pub fn new(fetcher: F, dir: PathBuf) -> Self {
        Self::with_clock(fetcher, dir, || chrono::Utc::now().timestamp_millis())
    }

    fn with_clock(fetcher: F, dir: PathBuf, now: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        Self {
            fetcher,
            dir,
            now: Box::new(now),
            state: tokio::sync::Mutex::new(SatelliteState::default()),
        }
    }

    fn group_path(&self, def: &SatelliteGroupDef) -> PathBuf {
        self.dir.join(format!("{}.json", def.group))
    }

    fn log_path(&self) -> PathBuf {
        self.dir.join("requests.json")
    }

    /// When the next request for `def` may go out, and why not before.
    fn next_request(log: &RequestLog, def: &SatelliteGroupDef) -> Option<(i64, String)> {
        let interval = log.requested_at.get(def.group).map(|at| {
            (
                at + MIN_REQUEST_INTERVAL_MS,
                "VisTracer asked CelesTrak for this group less than 2 hours ago, and CelesTrak allows one download per update.".to_string(),
            )
        });
        [
            interval,
            log.retry_at.get(def.group).cloned(),
            log.paused_until.clone(),
        ]
        .into_iter()
        .flatten()
        .max_by_key(|(at, _)| *at)
    }

    /// The group's elements, from memory, the disk or a download. `allowed`
    /// reads the saved settings: it is asked when the call starts, after the
    /// call waited for another request, and right before the request goes
    /// out. While it says no, nothing is read or sent.
    pub async fn get(
        &self,
        def: &'static SatelliteGroupDef,
        allowed: impl Fn() -> bool,
    ) -> Result<Arc<SatelliteGroup>, SatelliteError> {
        if !allowed() {
            return Err(SatelliteError::NotAllowed);
        }
        let mut guard = self.state.lock().await;
        // Another request may have run meanwhile, and the user may have
        // turned the layer off during it.
        if !allowed() {
            return Err(SatelliteError::NotAllowed);
        }
        // Fields are borrowed apart below (the request log and the groups).
        let state = &mut *guard;
        let now = (self.now)();
        if !state.loaded.contains_key(def.group) {
            if let Some(saved) = read_json::<SatelliteGroup>(self.group_path(def)).await {
                state.loaded.insert(def.group, Arc::new(saved));
            }
        }
        let saved = state.loaded.get(def.group).cloned();
        if let Some(fresh) = saved.as_ref().filter(|g| is_fresh(g.fetched_at, now)) {
            return Ok(fresh.clone());
        }
        if state.log.is_none() {
            state.log = Some(read_json(self.log_path()).await.unwrap_or_default());
        }
        let log = state.log.get_or_insert_with(RequestLog::default);
        if log.correct_clock(now) {
            let _ = write_json(self.log_path(), log).await;
        }
        let failure = match Self::next_request(log, def).filter(|(until, _)| now < *until) {
            Some((until, reason)) => SatelliteError::Waiting { until, reason },
            None => {
                // Saved before the request goes out: a crash or restart
                // during the request must not lead to a second one, so no
                // request goes out when the log cannot be saved.
                let previous = log.requested_at.insert(def.group.to_string(), now);
                let logged = write_json(self.log_path(), log).await;
                if let Err(message) = logged {
                    restore(&mut log.requested_at, def.group, previous);
                    SatelliteError::Download {
                        message: format!("VisTracer {message}, so it sent no request"),
                        retry_at: now + NETWORK_ERROR_PAUSE_MS,
                    }
                } else if !allowed() {
                    restore(&mut log.requested_at, def.group, previous);
                    let _ = write_json(self.log_path(), log).await;
                    return Err(SatelliteError::NotAllowed);
                } else {
                    match self.download(def, log, now, previous).await {
                        Ok(group) => {
                            state.loaded.insert(def.group, group.clone());
                            return Ok(group);
                        }
                        Err(failure) => failure,
                    }
                }
            }
        };
        match saved {
            Some(older) => Ok(Arc::new(SatelliteGroup {
                note: Some(format!(
                    "Showing {}. {}",
                    copy_age(older.fetched_at, now),
                    failure.message()
                )),
                ..(*older).clone()
            })),
            None => Err(failure),
        }
    }

    /// One request for `def`, its answer and the request log after it.
    async fn download(
        &self,
        def: &'static SatelliteGroupDef,
        log: &mut RequestLog,
        now: i64,
        previous: Option<i64>,
    ) -> Result<Arc<SatelliteGroup>, SatelliteError> {
        let url = group_url(def);
        debug_assert!(upstream::is_allowed(&url, SATELLITE_HOSTS));
        let answer = self.fetcher.fetch(url.clone()).await;
        log.retry_at.remove(def.group);
        let parsed = match answer {
            Err(FetchError {
                message,
                sent: false,
            }) => {
                // No request reached CelesTrak: not a download.
                restore(&mut log.requested_at, def.group, previous);
                let retry_at = now + NETWORK_ERROR_PAUSE_MS;
                log.retry_at
                    .insert(def.group.to_string(), (retry_at, message.clone()));
                let _ = write_json(self.log_path(), log).await;
                log::warn!("CelesTrak request for {} failed: {message}", def.group);
                return Err(SatelliteError::Download { message, retry_at });
            }
            Err(FetchError {
                message,
                sent: true,
            }) => {
                // It may have reached CelesTrak: it counts as this group's
                // download, so the group waits the full interval.
                let _ = write_json(self.log_path(), log).await;
                log::warn!("CelesTrak request for {} failed: {message}", def.group);
                return Err(SatelliteError::Download {
                    message,
                    retry_at: now + MIN_REQUEST_INTERVAL_MS,
                });
            }
            Ok(fetched) if fetched.status == 200 => {
                parse_gp_csv(&fetched.body).map_err(|e| format!("not usable ({e})"))
            }
            Ok(fetched) => Err(format!("HTTP {}", fetched.status)),
        };
        match parsed {
            Ok(satellites) => {
                let _ = write_json(self.log_path(), log).await;
                let group = Arc::new(SatelliteGroup {
                    group: def.group.to_string(),
                    fetched_at: now,
                    source: url.to_string(),
                    note: None,
                    satellites,
                });
                let _ = write_json(self.group_path(def), &*group).await;
                Ok(group)
            }
            Err(problem) => {
                // The usage policy: stop after an answer that is not HTTP 200
                // with data; asking again changes nothing.
                let until = now + HTTP_ERROR_PAUSE_MS;
                let reason = format!("CelesTrak's answer to the {} request was {problem}; its usage policy asks apps to stop after an error.", def.group);
                log.paused_until = Some((until, reason.clone()));
                let _ = write_json(self.log_path(), log).await;
                log::warn!("{reason}");
                Err(SatelliteError::Waiting { until, reason })
            }
        }
    }
}

/// Puts back the request time a request that did not go out had replaced.
fn restore(requested_at: &mut BTreeMap<String, i64>, group: &str, previous: Option<i64>) {
    match previous {
        Some(at) => requested_at.insert(group.to_string(), at),
        None => requested_at.remove(group),
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::upstream::Fetched;
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
    use std::sync::Mutex;

    const FIXTURE: &str = include_str!("../../fixtures/satellites/gp-sample.csv");
    const T0: i64 = 1_790_000_000_000;
    const HOUR: i64 = 3_600_000;

    struct FakeFetcher {
        replies: Mutex<Vec<Result<Fetched, FetchError>>>,
        urls: Mutex<Vec<String>>,
        calls: AtomicUsize,
        /// Cleared during a request: the user turns the layer off meanwhile.
        switch: Option<Arc<AtomicBool>>,
    }

    impl FakeFetcher {
        fn new(replies: Vec<Result<Fetched, FetchError>>) -> Self {
            Self {
                replies: Mutex::new(replies),
                urls: Mutex::new(Vec::new()),
                calls: AtomicUsize::new(0),
                switch: None,
            }
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl Fetcher for FakeFetcher {
        async fn fetch(&self, url: reqwest::Url) -> Result<Fetched, FetchError> {
            assert!(upstream::is_allowed(&url, SATELLITE_HOSTS), "{url}");
            self.urls.lock().unwrap().push(url.to_string());
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(switch) = &self.switch {
                switch.store(false, Ordering::SeqCst);
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
            let mut replies = self.replies.lock().unwrap();
            if replies.len() > 1 {
                replies.remove(0)
            } else {
                replies[0].clone()
            }
        }
    }

    /// No request reached the host (a refused connection).
    fn not_sent(message: &str) -> Result<Fetched, FetchError> {
        Err(FetchError {
            message: message.into(),
            sent: false,
        })
    }

    /// The host may have served it (a timeout, a broken answer).
    fn broke_off(message: &str) -> Result<Fetched, FetchError> {
        Err(FetchError {
            message: message.into(),
            sent: true,
        })
    }

    const ON: fn() -> bool = || true;
    const OFF: fn() -> bool = || false;

    fn reply(status: u16, body: &str) -> Result<Fetched, FetchError> {
        Ok(Fetched {
            status,
            content_type: Some("text/plain; charset=UTF-8".into()),
            body: body.as_bytes().to_vec(),
        })
    }

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("vistracer-satellites-{}", uuid::Uuid::new_v4()))
    }

    struct Clock(Arc<AtomicI64>);

    impl Clock {
        fn new() -> Self {
            Self(Arc::new(AtomicI64::new(T0)))
        }
        fn advance(&self, ms: i64) {
            self.0.fetch_add(ms, Ordering::SeqCst);
        }
    }

    fn service(
        replies: Vec<Result<Fetched, FetchError>>,
        dir: &std::path::Path,
        clock: &Clock,
    ) -> SatelliteService<FakeFetcher> {
        let time = clock.0.clone();
        SatelliteService::with_clock(FakeFetcher::new(replies), dir.to_path_buf(), move || {
            time.load(Ordering::SeqCst)
        })
    }

    /// A service whose clock stands at `at`.
    fn service_at(
        replies: Vec<Result<Fetched, FetchError>>,
        dir: &std::path::Path,
        at: i64,
    ) -> SatelliteService<FakeFetcher> {
        SatelliteService::with_clock(FakeFetcher::new(replies), dir.to_path_buf(), move || at)
    }

    fn starlink() -> &'static SatelliteGroupDef {
        group_def("starlink").unwrap()
    }

    #[test]
    fn the_sample_parses_and_malformed_rows_are_skipped() {
        let satellites = parse_gp_csv(FIXTURE.as_bytes()).unwrap();
        let ids: Vec<u32> = satellites.iter().map(|s| s.norad_id).collect();
        // A six-digit catalogue number is fine; every row after the fourth is malformed.
        assert_eq!(ids, [5, 99901, 99902, 100001]);
        let vanguard = &satellites[0];
        assert_eq!(vanguard.name, "VANGUARD 1");
        assert_eq!(vanguard.object_id, "1958-002B");
        assert_eq!(vanguard.epoch, "2000-06-27T18:50:19.733568");
        assert_eq!(vanguard.mean_motion, 10.82419157);
        // CelesTrak writes numbers without the leading zero.
        assert_eq!(vanguard.eccentricity, 0.1859667);
        assert_eq!(vanguard.bstar, 0.28098e-4);
        assert_eq!(vanguard.mean_motion_dot, 0.23e-6);
        assert_eq!(satellites[2].name, "EXAMPLE SAT, SHELL 1");
        assert_eq!(satellites[3].epoch, "2026-10-23T22:15:00");
    }

    #[test]
    fn an_answer_that_is_not_gp_data_is_an_error() {
        assert!(parse_gp_csv(b"").unwrap_err().contains("empty"));
        assert!(parse_gp_csv(b"<html><body>Blocked</body></html>")
            .unwrap_err()
            .contains("no OBJECT_NAME column"));
        assert!(parse_gp_csv("No GP data found\n".as_bytes())
            .unwrap_err()
            .contains("not GP data"));
        let header = FIXTURE.lines().next().unwrap();
        assert!(parse_gp_csv(format!("{header}\nX,1,2,3\n").as_bytes())
            .unwrap_err()
            .contains("no valid element set"));
        assert!(parse_gp_csv(&[0xff, 0xfe]).unwrap_err().contains("UTF-8"));
        assert_eq!(csv_fields(r#"a,"b, ""c""",d"#), ["a", r#"b, "c""#, "d"]);
    }

    #[test]
    fn only_celestrak_and_the_known_groups_are_requested() {
        for def in SATELLITE_GROUPS {
            let url = group_url(def);
            assert!(upstream::is_allowed(&url, SATELLITE_HOSTS));
            assert_eq!(
                url.as_str(),
                format!(
                    "https://celestrak.org/NORAD/elements/gp.php?GROUP={}&FORMAT=csv",
                    def.group
                )
            );
            assert!(def.layer.starts_with("satellites-"));
        }
        assert!(
            group_def("active").is_none(),
            "the large Active list is never requested"
        );
        assert!(group_def("starlink&FORMAT=json").is_none());
        for url in [
            "http://celestrak.org/NORAD/elements/gp.php",
            "https://celestrak.com/NORAD/elements/gp.php",
            "https://celestrak.org.evil.example/x",
            "https://celestrak.org:8443/x",
        ] {
            assert!(
                !upstream::is_allowed(&reqwest::Url::parse(url).unwrap(), SATELLITE_HOSTS),
                "{url}"
            );
        }
        assert!(SatelliteError::UnknownGroup("active".into())
            .message()
            .contains("Nothing was downloaded"));
    }

    #[tokio::test]
    async fn nothing_is_read_or_sent_while_not_allowed() {
        let dir = temp_dir();
        let clock = Clock::new();
        let service = service(vec![reply(200, FIXTURE)], &dir, &clock);
        assert_eq!(
            service.get(starlink(), OFF).await.unwrap_err(),
            SatelliteError::NotAllowed
        );
        assert_eq!(service.fetcher.calls(), 0);
        assert!(!dir.exists(), "no file is read or written");
        assert!(SatelliteError::NotAllowed
            .message()
            .contains("Nothing was downloaded"));
    }

    #[tokio::test]
    async fn one_download_per_group_then_memory_disk_and_the_ttl() {
        let dir = temp_dir();
        let clock = Clock::new();
        let first = service(vec![reply(200, FIXTURE)], &dir, &clock);
        let (a, b) = tokio::join!(first.get(starlink(), ON), first.get(starlink(), ON));
        assert_eq!(
            first.fetcher.calls(),
            1,
            "concurrent calls share one request"
        );
        assert_eq!(a.unwrap().satellites, b.unwrap().satellites);
        assert_eq!(
            first.fetcher.urls.lock().unwrap()[0],
            "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=csv"
        );
        // Another group is its own request.
        first.get(group_def("gps-ops").unwrap(), ON).await.unwrap();
        assert_eq!(first.fetcher.calls(), 2);

        // After a restart, the saved copy is used until it is 12 hours old.
        clock.advance(11 * HOUR);
        let restarted = service(vec![reply(200, FIXTURE)], &dir, &clock);
        let saved = restarted.get(starlink(), ON).await.unwrap();
        assert_eq!(restarted.fetcher.calls(), 0);
        assert_eq!(saved.satellites.len(), 4);
        assert_eq!(saved.fetched_at, T0);
        clock.advance(HOUR);
        let refreshed = restarted.get(starlink(), ON).await.unwrap();
        assert_eq!(restarted.fetcher.calls(), 1);
        assert_eq!(refreshed.fetched_at, T0 + 12 * HOUR);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_group_is_requested_at_most_once_in_two_hours_across_restarts() {
        let dir = temp_dir();
        let clock = Clock::new();
        let first = service(vec![reply(200, FIXTURE)], &dir, &clock);
        first.get(starlink(), ON).await.unwrap();
        // The saved copy is lost (cache cleared); the request log is not.
        std::fs::remove_file(dir.join("starlink.json")).unwrap();
        clock.advance(HOUR);
        let restarted = service(vec![reply(200, FIXTURE)], &dir, &clock);
        let error = restarted.get(starlink(), ON).await.unwrap_err();
        assert!(matches!(error, SatelliteError::Waiting { until, .. } if until == T0 + 2 * HOUR));
        assert!(error.message().contains("one download per update"));
        assert_eq!(restarted.fetcher.calls(), 0);
        clock.advance(HOUR);
        restarted.get(starlink(), ON).await.unwrap();
        assert_eq!(restarted.fetcher.calls(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn an_http_error_stops_every_request_for_two_hours_across_restarts() {
        let dir = temp_dir();
        let clock = Clock::new();
        let first = service(
            vec![reply(403, "Data is updated once every 2 hours.")],
            &dir,
            &clock,
        );
        let error = first.get(starlink(), ON).await.unwrap_err();
        assert!(error.message().contains("HTTP 403"));
        assert!(error.message().contains("usage policy"));
        // No other group either, and not after a restart.
        let stations = group_def("stations").unwrap();
        assert!(matches!(
            first.get(stations, ON).await.unwrap_err(),
            SatelliteError::Waiting { .. }
        ));
        assert_eq!(first.fetcher.calls(), 1);
        clock.advance(HOUR + 59 * 60_000);
        let restarted = service(vec![reply(200, FIXTURE)], &dir, &clock);
        assert!(restarted.get(stations, ON).await.is_err());
        assert_eq!(restarted.fetcher.calls(), 0);
        clock.advance(60_000);
        assert_eq!(
            restarted.get(stations, ON).await.unwrap().satellites.len(),
            4
        );
        assert_eq!(restarted.fetcher.calls(), 1);

        // A 200 that is not GP data stops requests the same way.
        let html = temp_dir();
        let odd = service(vec![reply(200, "<html>maintenance</html>")], &html, &clock);
        let error = odd.get(starlink(), ON).await.unwrap_err();
        assert!(error.message().contains("not GP data"));
        assert!(odd.get(stations, ON).await.is_err());
        assert_eq!(odd.fetcher.calls(), 1);
        for path in [dir, html] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }

    #[tokio::test]
    async fn a_network_error_retries_that_group_after_fifteen_minutes() {
        let dir = temp_dir();
        let clock = Clock::new();
        let service = service(
            vec![not_sent("connection refused"), reply(200, FIXTURE)],
            &dir,
            &clock,
        );
        let error = service.get(starlink(), ON).await.unwrap_err();
        assert_eq!(
            error,
            SatelliteError::Download {
                message: "connection refused".into(),
                retry_at: T0 + 15 * 60_000
            }
        );
        assert!(error.message().contains("celestrak.org"));
        assert!(service.get(starlink(), ON).await.is_err());
        assert_eq!(service.fetcher.calls(), 1, "no retry yet");
        // Other groups are not held back by it.
        service
            .get(group_def("gps-ops").unwrap(), ON)
            .await
            .unwrap();
        assert_eq!(service.fetcher.calls(), 2);
        clock.advance(15 * 60_000);
        service.get(starlink(), ON).await.unwrap();
        assert_eq!(service.fetcher.calls(), 3);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn an_old_copy_is_shown_with_a_note_when_no_new_one_can_be_had() {
        let dir = temp_dir();
        let clock = Clock::new();
        let first = service(vec![reply(200, FIXTURE)], &dir, &clock);
        first.get(starlink(), ON).await.unwrap();
        clock.advance(13 * HOUR);
        let later = service(vec![reply(503, "")], &dir, &clock);
        let shown = later.get(starlink(), ON).await.unwrap();
        assert_eq!(later.fetcher.calls(), 1);
        assert_eq!(shown.satellites.len(), 4);
        let note = shown.note.as_deref().unwrap();
        assert!(note.contains("13 hours ago"), "{note}");
        assert!(note.contains("HTTP 503"), "{note}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_damaged_saved_copy_is_replaced() {
        let dir = temp_dir();
        let clock = Clock::new();
        write_atomic(&dir.join("starlink.json"), b"{ not json").unwrap();
        write_atomic(&dir.join("requests.json"), b"[1, 2").unwrap();
        let service = service(vec![reply(200, FIXTURE)], &dir, &clock);
        assert_eq!(
            service.get(starlink(), ON).await.unwrap().satellites.len(),
            4
        );
        assert_eq!(service.fetcher.calls(), 1);
        let saved: SatelliteGroup =
            serde_json::from_slice(&std::fs::read(dir.join("starlink.json")).unwrap()).unwrap();
        assert_eq!(saved.satellites.len(), 4);
        let log: RequestLog =
            serde_json::from_slice(&std::fs::read(dir.join("requests.json")).unwrap()).unwrap();
        assert_eq!(log.requested_at.get("starlink"), Some(&T0));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_group_waiting_for_another_request_is_not_sent_once_the_layer_is_off() {
        let dir = temp_dir();
        let clock = Clock::new();
        let on = Arc::new(AtomicBool::new(true));
        let mut fetcher = FakeFetcher::new(vec![reply(200, FIXTURE)]);
        // The user turns the layer off while Starlink downloads.
        fetcher.switch = Some(on.clone());
        let time = clock.0.clone();
        let service =
            SatelliteService::with_clock(fetcher, dir.clone(), move || time.load(Ordering::SeqCst));
        let allowed = || on.load(Ordering::SeqCst);
        let (starlink_result, gps) = tokio::join!(
            service.get(starlink(), allowed),
            service.get(group_def("gps-ops").unwrap(), allowed)
        );
        assert!(starlink_result.is_ok());
        assert_eq!(gps.unwrap_err(), SatelliteError::NotAllowed);
        assert_eq!(
            service.fetcher.calls(),
            1,
            "only the request already under way"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn the_switch_is_read_again_right_before_the_request() {
        let dir = temp_dir();
        let clock = Clock::new();
        let service = service(vec![reply(200, FIXTURE)], &dir, &clock);
        // On when the call starts and after the lock, off just before the request.
        let reads = AtomicUsize::new(0);
        let allowed = || reads.fetch_add(1, Ordering::SeqCst) < 2;
        assert_eq!(
            service.get(starlink(), allowed).await.unwrap_err(),
            SatelliteError::NotAllowed
        );
        assert_eq!(service.fetcher.calls(), 0);
        // The request that did not go out is not in the log.
        let log: RequestLog =
            serde_json::from_slice(&std::fs::read(dir.join("requests.json")).unwrap()).unwrap();
        assert!(log.requested_at.is_empty());
        service.get(starlink(), ON).await.unwrap();
        assert_eq!(service.fetcher.calls(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn an_answer_that_broke_off_counts_as_the_groups_download() {
        let dir = temp_dir();
        let clock = Clock::new();
        let service = service(
            vec![broke_off("operation timed out"), reply(200, FIXTURE)],
            &dir,
            &clock,
        );
        let error = service.get(starlink(), ON).await.unwrap_err();
        // CelesTrak may have served it: a retry inside 2 hours would get HTTP 403.
        assert_eq!(
            error,
            SatelliteError::Download {
                message: "operation timed out".into(),
                retry_at: T0 + 2 * HOUR
            }
        );
        clock.advance(HOUR);
        assert!(service.get(starlink(), ON).await.is_err());
        assert_eq!(service.fetcher.calls(), 1);
        clock.advance(HOUR);
        service.get(starlink(), ON).await.unwrap();
        assert_eq!(service.fetcher.calls(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn no_request_goes_out_when_the_request_log_cannot_be_saved() {
        // A file where the cache folder should be: nothing can be written.
        let dir = temp_dir();
        std::fs::write(&dir, b"not a folder").unwrap();
        let clock = Clock::new();
        let service = service(vec![reply(200, FIXTURE)], &dir, &clock);
        let error = service.get(starlink(), ON).await.unwrap_err();
        assert!(
            error.message().contains("so it sent no request"),
            "{}",
            error.message()
        );
        assert_eq!(service.fetcher.calls(), 0);
        std::fs::remove_file(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_copy_dated_in_the_future_is_stale() {
        // The system clock ran a day ahead when the copy was saved, then
        // was set right.
        let dir = temp_dir();
        let clock = Clock::new();
        let ahead = |fetched_at: i64| SatelliteGroup {
            group: "starlink".into(),
            fetched_at,
            source: "saved".into(),
            note: None,
            satellites: parse_gp_csv(FIXTURE.as_bytes()).unwrap(),
        };
        let path = dir.join("starlink.json");
        // A minute of drift is no reason to ask again.
        write_atomic(&path, &serde_json::to_vec(&ahead(T0 + 60_000)).unwrap()).unwrap();
        let drift = service(vec![reply(200, FIXTURE)], &dir, &clock);
        assert_eq!(
            drift.get(starlink(), ON).await.unwrap().fetched_at,
            T0 + 60_000
        );
        assert_eq!(drift.fetcher.calls(), 0);

        write_atomic(&path, &serde_json::to_vec(&ahead(T0 + 24 * HOUR)).unwrap()).unwrap();
        let fixed = service(vec![reply(200, FIXTURE)], &dir, &clock);
        assert_eq!(fixed.get(starlink(), ON).await.unwrap().fetched_at, T0);
        assert_eq!(fixed.fetcher.calls(), 1);

        // When no new copy may be had, the note says what is wrong with the old one.
        write_atomic(&path, &serde_json::to_vec(&ahead(T0 + 24 * HOUR)).unwrap()).unwrap();
        let refused = service(vec![reply(403, "")], &dir, &clock);
        clock.advance(2 * HOUR);
        let shown = refused.get(starlink(), ON).await.unwrap();
        let note = shown.note.as_deref().unwrap();
        assert!(
            note.contains("dated 2026-09-22 14:13 UTC (the system clock was ahead"),
            "{note}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_request_or_pause_dated_in_the_future_waits_no_longer_than_its_length() {
        let dir = temp_dir();
        let clock = Clock::new();
        let day = 24 * HOUR;
        let log = RequestLog {
            requested_at: BTreeMap::from([("gps-ops".to_string(), T0 + day)]),
            retry_at: BTreeMap::from([("stations".to_string(), (T0 + day, "timed out".into()))]),
            paused_until: None,
        };
        write_atomic(
            &dir.join("requests.json"),
            &serde_json::to_vec(&log).unwrap(),
        )
        .unwrap();
        let service = service(vec![reply(200, FIXTURE)], &dir, &clock);
        // Counted from now: 2 hours, not a day and 2 hours; the message has the date.
        let gps = service
            .get(group_def("gps-ops").unwrap(), ON)
            .await
            .unwrap_err();
        assert!(matches!(gps, SatelliteError::Waiting { until, .. } if until == T0 + 2 * HOUR));
        assert!(
            gps.message().contains("before 2026-09-21 16:13 UTC"),
            "{}",
            gps.message()
        );
        let stations = service
            .get(group_def("stations").unwrap(), ON)
            .await
            .unwrap_err();
        assert!(
            matches!(stations, SatelliteError::Waiting { until, .. } if until == T0 + 15 * 60_000)
        );
        assert_eq!(service.fetcher.calls(), 0);
        // The correction is saved: an hour later, after a restart, the wait
        // still ends at the same time (it does not start again).
        let restarted = service_at(vec![reply(200, FIXTURE)], &dir, T0 + HOUR);
        assert!(matches!(
            restarted.get(group_def("gps-ops").unwrap(), ON).await.unwrap_err(),
            SatelliteError::Waiting { until, .. } if until == T0 + 2 * HOUR
        ));
        clock.advance(2 * HOUR);
        service
            .get(group_def("gps-ops").unwrap(), ON)
            .await
            .unwrap();
        assert_eq!(service.fetcher.calls(), 1);

        // A pause after an HTTP error: at most 2 hours from now.
        let paused = temp_dir();
        let log = RequestLog {
            paused_until: Some((T0 + 3 * day, "HTTP 403".into())),
            ..RequestLog::default()
        };
        write_atomic(
            &paused.join("requests.json"),
            &serde_json::to_vec(&log).unwrap(),
        )
        .unwrap();
        let later = service_at(vec![reply(200, FIXTURE)], &paused, T0);
        assert!(matches!(
            later.get(starlink(), ON).await.unwrap_err(),
            SatelliteError::Waiting { until, .. } if until == T0 + 2 * HOUR
        ));
        for path in [dir, paused] {
            std::fs::remove_dir_all(path).unwrap();
        }
    }

    /// Downloads one small group from CelesTrak once:
    /// `cargo test smoke_real_celestrak -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "network: downloads the GPS group from celestrak.org"]
    async fn smoke_real_celestrak() {
        let dir = temp_dir();
        let service = SatelliteService::new(satellite_fetcher(), dir.clone());
        let gps = service
            .get(group_def("gps-ops").unwrap(), ON)
            .await
            .map_err(|e| e.message())
            .unwrap();
        println!(
            "{} GPS satellites, first {} epoch {}",
            gps.satellites.len(),
            gps.satellites[0].name,
            gps.satellites[0].epoch
        );
        assert!(gps.satellites.len() >= 24);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
