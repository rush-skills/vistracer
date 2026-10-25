//! The opt-in satellites layer: orbital elements (GP data) of a few
//! satellite groups from CelesTrak, downloaded only after the user turned
//! the layer on and accepted its notice, and kept in `$APPCACHE/satellites/`.
//!
//! CelesTrak's usage policy (celestrak.org/usage-policy.php, read on
//! 2026-10-25) asks apps to download a data set at most once per update
//! (every 2 hours; a second download gets HTTP 403), only when it is
//! needed, and to stop querying after any answer other than HTTP 200. So:
//!
//! - The caller passes whether the group may be downloaded
//!   (`UiPreferences::satellite_group`, read from the saved settings at each
//!   call). While it may not, nothing is read or sent.
//! - A saved group is used for `SATELLITE_TTL_MS`. A group is requested at
//!   most once in `MIN_REQUEST_INTERVAL_MS`; the time of each request is
//!   saved before the request goes out, so a restart does not ask again.
//! - After an HTTP error (or a 200 that is not GP data), no group is
//!   requested for `HTTP_ERROR_PAUSE_MS`, also across restarts. A network
//!   error (no answer at all) retries that group after
//!   `NETWORK_ERROR_PAUSE_MS`.
//! - One request runs at a time, for all groups.

use crate::atomic_file::write_atomic;
use crate::upstream::{self, Fetcher, HttpFetcher};
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

/// "18:40 UTC" for a time in ms since the epoch.
fn clock_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|time| time.format("%H:%M UTC").to_string())
        .unwrap_or_else(|| "later".to_string())
}

impl SatelliteError {
    pub fn message(&self) -> String {
        match self {
            Self::NotAllowed => "Satellites are off: turn the layer and the group on in Layers and accept the notice. Nothing was downloaded.".to_string(),
            Self::UnknownGroup(group) => format!("\"{group}\" is not a satellite group of this app. Nothing was downloaded."),
            Self::Waiting { until, reason } => format!(
                "{reason} VisTracer asks CelesTrak again after {}.",
                clock_time(*until)
            ),
            Self::Download { message, retry_at } => format!(
                "Could not download the orbital elements from {}: {message}. VisTracer tries again after {}.",
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

async fn write_json<T: Serialize>(path: PathBuf, value: &T) {
    let bytes = match serde_json::to_vec(value) {
        Ok(bytes) => bytes,
        Err(err) => return log::warn!("Could not encode a satellite file: {err}"),
    };
    match tokio::task::spawn_blocking(move || write_atomic(&path, &bytes)).await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => log::warn!("Could not save a satellite file: {err}"),
        Err(err) => log::warn!("Satellite file write task failed: {err}"),
    }
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
    /// comes from the saved settings; while it is false nothing is read or sent.
    pub async fn get(
        &self,
        def: &'static SatelliteGroupDef,
        allowed: bool,
    ) -> Result<Arc<SatelliteGroup>, SatelliteError> {
        if !allowed {
            return Err(SatelliteError::NotAllowed);
        }
        let mut guard = self.state.lock().await;
        // Fields are borrowed apart below (the request log and the groups).
        let state = &mut *guard;
        let now = (self.now)();
        if !state.loaded.contains_key(def.group) {
            if let Some(saved) = read_json::<SatelliteGroup>(self.group_path(def)).await {
                state.loaded.insert(def.group, Arc::new(saved));
            }
        }
        let saved = state.loaded.get(def.group).cloned();
        if let Some(fresh) = saved
            .as_ref()
            .filter(|g| (now - g.fetched_at).max(0) < SATELLITE_TTL_MS)
        {
            return Ok(fresh.clone());
        }
        if state.log.is_none() {
            state.log = Some(read_json(self.log_path()).await.unwrap_or_default());
        }
        let log = state.log.get_or_insert_with(RequestLog::default);
        let wait = Self::next_request(log, def).filter(|(until, _)| now < *until);
        let failure = match wait {
            Some((until, reason)) => SatelliteError::Waiting { until, reason },
            None => {
                let url = group_url(def);
                debug_assert!(upstream::is_allowed(&url, SATELLITE_HOSTS));
                // Saved before the request goes out: a crash or restart
                // during the request must not lead to a second one.
                let previous = log.requested_at.insert(def.group.to_string(), now);
                write_json(self.log_path(), log).await;
                match self.fetcher.fetch(url.clone()).await {
                    Err(message) => {
                        // No answer: this does not count as a download.
                        match previous {
                            Some(at) => log.requested_at.insert(def.group.to_string(), at),
                            None => log.requested_at.remove(def.group),
                        };
                        let retry_at = now + NETWORK_ERROR_PAUSE_MS;
                        log.retry_at
                            .insert(def.group.to_string(), (retry_at, message.clone()));
                        write_json(self.log_path(), log).await;
                        log::warn!("CelesTrak request for {} failed: {message}", def.group);
                        SatelliteError::Download { message, retry_at }
                    }
                    Ok(fetched) => {
                        let parsed = if fetched.status == 200 {
                            parse_gp_csv(&fetched.body).map_err(|e| format!("not usable ({e})"))
                        } else {
                            Err(format!("HTTP {}", fetched.status))
                        };
                        log.retry_at.remove(def.group);
                        match parsed {
                            Ok(satellites) => {
                                write_json(self.log_path(), log).await;
                                let group = Arc::new(SatelliteGroup {
                                    group: def.group.to_string(),
                                    fetched_at: now,
                                    source: url.to_string(),
                                    note: None,
                                    satellites,
                                });
                                write_json(self.group_path(def), &*group).await;
                                state.loaded.insert(def.group, group.clone());
                                return Ok(group);
                            }
                            Err(problem) => {
                                // The usage policy: stop after an answer that is not
                                // HTTP 200 with data; asking again changes nothing.
                                let until = now + HTTP_ERROR_PAUSE_MS;
                                let reason = format!("CelesTrak's answer to the {} request was {problem}; its usage policy asks apps to stop after an error.", def.group);
                                log.paused_until = Some((until, reason.clone()));
                                write_json(self.log_path(), log).await;
                                log::warn!("{reason}");
                                SatelliteError::Waiting { until, reason }
                            }
                        }
                    }
                }
            }
        };
        match saved {
            Some(older) => Ok(Arc::new(SatelliteGroup {
                note: Some(format!(
                    "Showing the copy from {} hours ago. {}",
                    (now - older.fetched_at).max(0) / 3_600_000,
                    failure.message()
                )),
                ..(*older).clone()
            })),
            None => Err(failure),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::upstream::Fetched;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
    use std::sync::Mutex;

    const FIXTURE: &str = include_str!("../../fixtures/satellites/gp-sample.csv");
    const T0: i64 = 1_790_000_000_000;
    const HOUR: i64 = 3_600_000;

    struct FakeFetcher {
        replies: Mutex<Vec<Result<Fetched, String>>>,
        urls: Mutex<Vec<String>>,
        calls: AtomicUsize,
    }

    impl FakeFetcher {
        fn new(replies: Vec<Result<Fetched, String>>) -> Self {
            Self {
                replies: Mutex::new(replies),
                urls: Mutex::new(Vec::new()),
                calls: AtomicUsize::new(0),
            }
        }
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl Fetcher for FakeFetcher {
        async fn fetch(&self, url: reqwest::Url) -> Result<Fetched, String> {
            assert!(upstream::is_allowed(&url, SATELLITE_HOSTS), "{url}");
            self.urls.lock().unwrap().push(url.to_string());
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

    fn reply(status: u16, body: &str) -> Result<Fetched, String> {
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
        replies: Vec<Result<Fetched, String>>,
        dir: &std::path::Path,
        clock: &Clock,
    ) -> SatelliteService<FakeFetcher> {
        let time = clock.0.clone();
        SatelliteService::with_clock(FakeFetcher::new(replies), dir.to_path_buf(), move || {
            time.load(Ordering::SeqCst)
        })
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
            service.get(starlink(), false).await.unwrap_err(),
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
        let (a, b) = tokio::join!(first.get(starlink(), true), first.get(starlink(), true));
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
        first
            .get(group_def("gps-ops").unwrap(), true)
            .await
            .unwrap();
        assert_eq!(first.fetcher.calls(), 2);

        // After a restart, the saved copy is used until it is 12 hours old.
        clock.advance(11 * HOUR);
        let restarted = service(vec![reply(200, FIXTURE)], &dir, &clock);
        let saved = restarted.get(starlink(), true).await.unwrap();
        assert_eq!(restarted.fetcher.calls(), 0);
        assert_eq!(saved.satellites.len(), 4);
        assert_eq!(saved.fetched_at, T0);
        clock.advance(HOUR);
        let refreshed = restarted.get(starlink(), true).await.unwrap();
        assert_eq!(restarted.fetcher.calls(), 1);
        assert_eq!(refreshed.fetched_at, T0 + 12 * HOUR);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_group_is_requested_at_most_once_in_two_hours_across_restarts() {
        let dir = temp_dir();
        let clock = Clock::new();
        let first = service(vec![reply(200, FIXTURE)], &dir, &clock);
        first.get(starlink(), true).await.unwrap();
        // The saved copy is lost (cache cleared); the request log is not.
        std::fs::remove_file(dir.join("starlink.json")).unwrap();
        clock.advance(HOUR);
        let restarted = service(vec![reply(200, FIXTURE)], &dir, &clock);
        let error = restarted.get(starlink(), true).await.unwrap_err();
        assert!(matches!(error, SatelliteError::Waiting { until, .. } if until == T0 + 2 * HOUR));
        assert!(error.message().contains("one download per update"));
        assert_eq!(restarted.fetcher.calls(), 0);
        clock.advance(HOUR);
        restarted.get(starlink(), true).await.unwrap();
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
        let error = first.get(starlink(), true).await.unwrap_err();
        assert!(error.message().contains("HTTP 403"));
        assert!(error.message().contains("usage policy"));
        // No other group either, and not after a restart.
        let stations = group_def("stations").unwrap();
        assert!(matches!(
            first.get(stations, true).await.unwrap_err(),
            SatelliteError::Waiting { .. }
        ));
        assert_eq!(first.fetcher.calls(), 1);
        clock.advance(HOUR + 59 * 60_000);
        let restarted = service(vec![reply(200, FIXTURE)], &dir, &clock);
        assert!(restarted.get(stations, true).await.is_err());
        assert_eq!(restarted.fetcher.calls(), 0);
        clock.advance(60_000);
        assert_eq!(
            restarted
                .get(stations, true)
                .await
                .unwrap()
                .satellites
                .len(),
            4
        );
        assert_eq!(restarted.fetcher.calls(), 1);

        // A 200 that is not GP data stops requests the same way.
        let html = temp_dir();
        let odd = service(vec![reply(200, "<html>maintenance</html>")], &html, &clock);
        let error = odd.get(starlink(), true).await.unwrap_err();
        assert!(error.message().contains("not GP data"));
        assert!(odd.get(stations, true).await.is_err());
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
            vec![Err("connection refused".into()), reply(200, FIXTURE)],
            &dir,
            &clock,
        );
        let error = service.get(starlink(), true).await.unwrap_err();
        assert_eq!(
            error,
            SatelliteError::Download {
                message: "connection refused".into(),
                retry_at: T0 + 15 * 60_000
            }
        );
        assert!(error.message().contains("celestrak.org"));
        assert!(service.get(starlink(), true).await.is_err());
        assert_eq!(service.fetcher.calls(), 1, "no retry yet");
        // Other groups are not held back by it.
        service
            .get(group_def("gps-ops").unwrap(), true)
            .await
            .unwrap();
        assert_eq!(service.fetcher.calls(), 2);
        clock.advance(15 * 60_000);
        service.get(starlink(), true).await.unwrap();
        assert_eq!(service.fetcher.calls(), 3);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn an_old_copy_is_shown_with_a_note_when_no_new_one_can_be_had() {
        let dir = temp_dir();
        let clock = Clock::new();
        let first = service(vec![reply(200, FIXTURE)], &dir, &clock);
        first.get(starlink(), true).await.unwrap();
        clock.advance(13 * HOUR);
        let later = service(vec![reply(503, "")], &dir, &clock);
        let shown = later.get(starlink(), true).await.unwrap();
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
            service
                .get(starlink(), true)
                .await
                .unwrap()
                .satellites
                .len(),
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

    /// Downloads one small group from CelesTrak once:
    /// `cargo test smoke_real_celestrak -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "network: downloads the GPS group from celestrak.org"]
    async fn smoke_real_celestrak() {
        let dir = temp_dir();
        let service = SatelliteService::new(satellite_fetcher(), dir.clone());
        let gps = service
            .get(group_def("gps-ops").unwrap(), true)
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
