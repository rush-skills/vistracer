//! External enrichment providers (Team Cymru, RDAP, RIPEstat, PeeringDB).
//!
//! Each lookup goes through the TTL cache, a per-provider concurrency
//! limit, and retry with backoff. A failed provider never blocks the hop:
//! it reports an error status and the merge uses the data that arrived.

use super::enrichment_cache::{write_atomic, CachedProvider, EnrichmentCache};
use super::geo::GeoLiteResult;
use super::persistence::IntegrationSettings;
use super::retry::{with_retry, ProviderError, RetryPolicy};
use crate::net::is_publicly_routable;
use crate::types::{
    AsnDetails, GeoDetails, PeeringDbDetails, ProviderId, ProviderState, ProviderStatus,
};
use reqwest::header::{HeaderMap, ACCEPT, AUTHORIZATION, RETRY_AFTER};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CymruRecord {
    pub asn: Option<u32>,
    pub prefix: Option<String>,
    pub country: Option<String>,
    pub registry: Option<String>,
    pub as_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdapRecord {
    pub name: Option<String>,
    pub handle: Option<String>,
    pub country: Option<String>,
    pub cidr: Option<String>,
    pub org_name: Option<String>,
    pub registry: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RipeOrigin {
    pub asn: u32,
    pub holder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RipeStatRecord {
    pub prefix: Option<String>,
    pub announced: bool,
    pub origins: Vec<RipeOrigin>,
}

/// The merged result of every provider for one address.
#[derive(Debug, Clone, PartialEq)]
pub struct Enrichment {
    pub geo: Option<GeoDetails>,
    pub asn: Option<AsnDetails>,
    pub peering_db: Option<PeeringDbDetails>,
    pub providers: Vec<ProviderStatus>,
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty() && trimmed != "NA").then(|| trimmed.to_string())
}

fn json_str(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).and_then(non_empty)
}

/// Parses Team Cymru verbose whois output:
/// `AS | IP | BGP Prefix | CC | Registry | Allocated | AS Name`.
pub fn parse_team_cymru(text: &str, ip: IpAddr) -> Option<CymruRecord> {
    let target = ip.to_string();
    let rows: Vec<Vec<&str>> = text
        .lines()
        .filter(|line| line.contains('|'))
        .map(|line| line.split('|').map(str::trim).collect::<Vec<_>>())
        .filter(|fields| fields.len() >= 7)
        .collect();
    let row = rows
        .iter()
        .find(|fields| fields[1] == target)
        .or_else(|| rows.first())?;

    let record = CymruRecord {
        asn: row[0].parse().ok(),
        prefix: non_empty(row[2]),
        country: non_empty(row[3]),
        registry: non_empty(row[4]).filter(|registry| registry != "other"),
        as_name: non_empty(row[6]),
    };
    (record.asn.is_some() || record.prefix.is_some()).then_some(record)
}

fn registry_from_whois_host(host: &str) -> Option<String> {
    let host = host.to_lowercase();
    [
        ("arin", "arin"),
        ("ripe", "ripencc"),
        ("apnic", "apnic"),
        ("lacnic", "lacnic"),
        ("afrinic", "afrinic"),
    ]
    .iter()
    .find(|(needle, _)| host.contains(needle))
    .map(|(_, registry)| registry.to_string())
}

fn vcard_field(entity: &Value, field: &str) -> Option<String> {
    entity
        .get("vcardArray")?
        .get(1)?
        .as_array()?
        .iter()
        .find(|item| item.get(0).and_then(Value::as_str) == Some(field))
        .and_then(|item| item.get(3))
        .and_then(Value::as_str)
        .and_then(non_empty)
}

fn rdap_registrant_name(data: &Value) -> Option<String> {
    let registrants: Vec<&Value> = data
        .get("entities")?
        .as_array()?
        .iter()
        .filter(|entity| {
            entity
                .get("roles")
                .and_then(Value::as_array)
                .is_some_and(|roles| roles.iter().any(|r| r.as_str() == Some("registrant")))
        })
        .collect();
    registrants
        .iter()
        .find(|entity| vcard_field(entity, "kind").as_deref() == Some("org"))
        .or_else(|| registrants.first())
        .and_then(|entity| vcard_field(entity, "fn"))
}

/// Parses an RDAP "ip network" object (RFC 9083).
pub fn parse_rdap(data: &Value) -> Option<RdapRecord> {
    if data.get("errorCode").is_some() {
        return None;
    }
    let cidr = data
        .get("cidr0_cidrs")
        .and_then(Value::as_array)
        .and_then(|cidrs| cidrs.first())
        .and_then(|entry| {
            let prefix = entry
                .get("v4prefix")
                .or_else(|| entry.get("v6prefix"))?
                .as_str()?;
            let length = entry.get("length")?.as_u64()?;
            Some(format!("{prefix}/{length}"))
        });
    let record = RdapRecord {
        name: json_str(data, "name"),
        handle: json_str(data, "handle"),
        country: json_str(data, "country"),
        cidr,
        org_name: rdap_registrant_name(data),
        registry: json_str(data, "port43").and_then(|host| registry_from_whois_host(&host)),
    };
    let empty = record.name.is_none() && record.handle.is_none() && record.cidr.is_none();
    (!empty).then_some(record)
}

/// Parses the RIPEstat `prefix-overview` data call.
pub fn parse_ripe_stat(body: &Value) -> Result<Option<RipeStatRecord>, ProviderError> {
    if let Some(status) = body.get("status").and_then(Value::as_str) {
        if status != "ok" {
            return Err(ProviderError::Parse(format!(
                "RIPEstat status \"{status}\""
            )));
        }
    }
    let Some(data) = body.get("data") else {
        return Err(ProviderError::Parse(
            "RIPEstat response has no data".to_string(),
        ));
    };
    let announced = data
        .get("announced")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let origins: Vec<RipeOrigin> = data
        .get("asns")
        .and_then(Value::as_array)
        .map(|asns| {
            asns.iter()
                .filter_map(|origin| {
                    Some(RipeOrigin {
                        asn: u32::try_from(origin.get("asn")?.as_u64()?).ok()?,
                        holder: json_str(origin, "holder"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let prefix = json_str(data, "resource").filter(|resource| resource.contains('/'));
    if !announced && origins.is_empty() {
        return Ok(None);
    }
    Ok(Some(RipeStatRecord {
        prefix,
        announced,
        origins,
    }))
}

/// Parses a PeeringDB `/api/net?asn=` response.
pub fn parse_peeringdb(body: &Value) -> Option<PeeringDbDetails> {
    let entry = body.get("data")?.as_array()?.first()?;
    Some(PeeringDbDetails {
        id: entry.get("id").and_then(Value::as_u64),
        name: json_str(entry, "name"),
        aka: json_str(entry, "aka"),
        website: json_str(entry, "website"),
        info_type: json_str(entry, "info_type"),
        info_scope: json_str(entry, "info_scope"),
        info_traffic: json_str(entry, "info_traffic"),
        info_ratio: json_str(entry, "info_ratio"),
        policy_general: json_str(entry, "policy_general"),
        irr_as_set: json_str(entry, "irr_as_set"),
        ix_count: entry.get("ix_count").and_then(Value::as_u64),
        fac_count: entry.get("fac_count").and_then(Value::as_u64),
    })
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone, Copy)]
pub struct MergeInputs<'a> {
    pub geolite_asn: Option<&'a AsnDetails>,
    pub cymru: Option<&'a CymruRecord>,
    pub rdap: Option<&'a RdapRecord>,
    pub ripe: Option<&'a RipeStatRecord>,
    pub peering_db: Option<&'a PeeringDbDetails>,
}

/// Team Cymru and RIPEstat report the live BGP origin, so they win over
/// the GeoLite2 snapshot.
pub fn choose_asn(inputs: &MergeInputs) -> Option<u32> {
    inputs
        .cymru
        .and_then(|c| c.asn)
        .or_else(|| inputs.ripe.and_then(|r| r.origins.first().map(|o| o.asn)))
        .or_else(|| inputs.geolite_asn.and_then(|g| g.asn))
}

/// Merges ASN details field by field. The name comes first from a source
/// that agrees on the chosen ASN (GeoLite2, RIPEstat, Team Cymru), then from
/// PeeringDB (looked up by that ASN), and last from the RDAP registrant,
/// which holds the IP block and can differ from the AS holder.
pub fn merge_asn(inputs: &MergeInputs) -> Option<AsnDetails> {
    let asn = choose_asn(inputs);
    let agrees = |candidate: Option<u32>| asn.is_some() && candidate == asn;

    let name = inputs
        .geolite_asn
        .filter(|g| agrees(g.asn))
        .and_then(|g| g.name.clone())
        .or_else(|| {
            inputs
                .ripe
                .and_then(|r| r.origins.iter().find(|o| agrees(Some(o.asn))))
                .and_then(|o| o.holder.clone())
        })
        .or_else(|| {
            inputs
                .cymru
                .filter(|c| agrees(c.asn))
                .and_then(|c| c.as_name.clone())
        })
        .or_else(|| inputs.peering_db.and_then(|p| p.name.clone()))
        .or_else(|| {
            inputs
                .rdap
                .and_then(|r| r.org_name.clone().or_else(|| r.name.clone()))
        });

    let network = inputs
        .ripe
        .filter(|r| r.announced)
        .and_then(|r| r.prefix.clone())
        .or_else(|| inputs.cymru.and_then(|c| c.prefix.clone()))
        .or_else(|| inputs.rdap.and_then(|r| r.cidr.clone()));

    let details = AsnDetails {
        asn,
        name,
        network,
        country: inputs
            .cymru
            .and_then(|c| c.country.clone())
            .or_else(|| inputs.rdap.and_then(|r| r.country.clone())),
        registry: inputs
            .cymru
            .and_then(|c| c.registry.clone())
            .or_else(|| inputs.rdap.and_then(|r| r.registry.clone())),
    };
    (details != AsnDetails::default()).then_some(details)
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ProviderEndpoints {
    pub team_cymru_whois: String,
    pub ripe_stat_base: String,
    pub peering_db_base: String,
}

impl Default for ProviderEndpoints {
    fn default() -> Self {
        Self {
            team_cymru_whois: "whois.cymru.com:43".to_string(),
            ripe_stat_base: "https://stat.ripe.net".to_string(),
            peering_db_base: "https://www.peeringdb.com".to_string(),
        }
    }
}

/// Concurrent requests allowed per provider, shared by all runs. PeeringDB
/// gets one slot: hops in the same ASN then wait for the first answer and
/// read it from the cache instead of sending duplicate requests.
struct ProviderLimits {
    team_cymru: Semaphore,
    rdap: Semaphore,
    ripe_stat: Semaphore,
    peering_db: Semaphore,
}

impl Default for ProviderLimits {
    fn default() -> Self {
        Self {
            team_cymru: Semaphore::new(2),
            rdap: Semaphore::new(2),
            ripe_stat: Semaphore::new(4),
            peering_db: Semaphore::new(1),
        }
    }
}

/// After `threshold` failed lookups in a row, a provider is skipped for
/// `cooldown`. Without this, a provider that times out holds every hop of a
/// run for the full budget, one or two hops at a time.
#[derive(Debug, Clone)]
pub struct BreakerPolicy {
    pub threshold: u32,
    pub cooldown: Duration,
}

impl Default for BreakerPolicy {
    fn default() -> Self {
        Self {
            threshold: 3,
            cooldown: Duration::from_secs(60),
        }
    }
}

#[derive(Debug, Default)]
struct BreakerState {
    consecutive_failures: u32,
    open_until: Option<Instant>,
}

pub struct EnrichmentConfig {
    pub client: reqwest::Client,
    pub endpoints: ProviderEndpoints,
    pub retry: RetryPolicy,
    pub breaker: BreakerPolicy,
    /// Upper bound for the wait for a provider slot, and separately for the
    /// request itself, retries included.
    pub provider_budget: Duration,
    pub ttl: Duration,
    pub cache_path: Option<PathBuf>,
}

impl EnrichmentConfig {
    pub fn production(cache_path: PathBuf, ttl: Duration) -> Self {
        let client = reqwest::Client::builder()
            .user_agent(format!(
                "VisTracer/{} (+https://github.com/rush-skills/vistracer)",
                env!("CARGO_PKG_VERSION")
            ))
            .connect_timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_default();
        Self {
            client,
            endpoints: ProviderEndpoints::default(),
            retry: RetryPolicy::default(),
            breaker: BreakerPolicy::default(),
            provider_budget: Duration::from_secs(25),
            ttl,
            cache_path: Some(cache_path),
        }
    }
}

pub struct EnrichmentService {
    client: reqwest::Client,
    endpoints: ProviderEndpoints,
    retry: RetryPolicy,
    breaker: BreakerPolicy,
    breakers: Mutex<HashMap<ProviderId, BreakerState>>,
    provider_budget: Duration,
    ttl_ms: i64,
    cache_path: Option<PathBuf>,
    cache: Mutex<EnrichmentCache>,
    limits: ProviderLimits,
}

struct ProviderOutcome<T> {
    record: Option<T>,
    status: ProviderStatus,
}

impl<T> ProviderOutcome<T> {
    fn skipped(provider: ProviderId, message: &str) -> Self {
        Self {
            record: None,
            status: ProviderStatus::new(provider, ProviderState::Skipped, message),
        }
    }

    fn answered(provider: ProviderId, record: Option<T>, cached: bool) -> Self {
        let message = match (record.is_some(), cached) {
            (true, false) => "Lookup complete.",
            (false, false) => "No record found.",
            (true, true) => "Loaded from cache.",
            (false, true) => "No record found (cached).",
        };
        let mut status = ProviderStatus::new(provider, ProviderState::Success, message);
        status.cached = cached;
        Self { record, status }
    }

    fn failed(provider: ProviderId, message: String) -> Self {
        Self {
            record: None,
            status: ProviderStatus::new(provider, ProviderState::Error, message),
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn parse_retry_after(headers: &HeaderMap) -> Option<Duration> {
    headers
        .get(RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
}

const WHOIS_RESPONSE_LIMIT: u64 = 64 * 1024;
const PRIVATE_ADDRESS_MESSAGE: &str =
    "Private or non-routable address; not sent to external providers.";
const DISABLED_MESSAGE: &str = "Disabled in Integration settings.";

impl EnrichmentService {
    pub fn new(config: EnrichmentConfig) -> Self {
        let ttl_ms = i64::try_from(config.ttl.as_millis()).unwrap_or(i64::MAX);
        let cache = match &config.cache_path {
            Some(path) => EnrichmentCache::load(path, now_ms(), ttl_ms),
            None => EnrichmentCache::default(),
        };
        Self {
            client: config.client,
            endpoints: config.endpoints,
            retry: config.retry,
            breaker: config.breaker,
            breakers: Mutex::new(HashMap::new()),
            provider_budget: config.provider_budget,
            ttl_ms,
            cache_path: config.cache_path,
            cache: Mutex::new(cache),
            limits: ProviderLimits::default(),
        }
    }

    /// Writes changed cache entries to disk. Errors are logged; a lost
    /// cache only costs extra lookups.
    pub fn persist(&self) {
        let Some(path) = &self.cache_path else {
            return;
        };
        // Serialise under the lock; write after it is released so lookups
        // are not blocked by disk I/O.
        let snapshot = {
            let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            cache.snapshot_if_dirty(now_ms(), self.ttl_ms)
        };
        let bytes = match snapshot {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return,
            Err(err) => {
                log::warn!("Failed to serialise enrichment cache: {err}");
                return;
            }
        };
        if let Err(err) = write_atomic(path, &bytes) {
            log::warn!("Failed to write enrichment cache {}: {err}", path.display());
            self.cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .mark_dirty();
        }
    }

    fn cache_get<T: CachedProvider>(&self, key: &str) -> Option<Option<T>> {
        let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.get::<T>(key, now_ms(), self.ttl_ms)
    }

    fn cache_insert<T: CachedProvider>(&self, key: &str, record: Option<T>) {
        let mut cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        cache.insert(key, record, now_ms());
    }

    fn breaker_open_message(&self, provider: ProviderId) -> Option<String> {
        let breakers = self.breakers.lock().unwrap_or_else(|e| e.into_inner());
        let open_until = breakers.get(&provider)?.open_until?;
        let remaining = open_until.checked_duration_since(Instant::now())?;
        Some(format!(
            "Skipped: failed {} times in a row. Retrying in {} s.",
            self.breaker.threshold,
            remaining.as_secs().max(1)
        ))
    }

    fn record_result(&self, provider: ProviderId, success: bool) {
        let mut breakers = self.breakers.lock().unwrap_or_else(|e| e.into_inner());
        let state = breakers.entry(provider).or_default();
        if success {
            *state = BreakerState::default();
            return;
        }
        state.consecutive_failures += 1;
        if state.consecutive_failures >= self.breaker.threshold {
            state.open_until = Some(Instant::now() + self.breaker.cooldown);
            state.consecutive_failures = 0;
            log::warn!(
                "{provider:?}: {} failures in a row, pausing lookups for {:?}",
                self.breaker.threshold,
                self.breaker.cooldown
            );
        }
    }

    async fn cached_lookup<T, F, Fut>(
        &self,
        key: &str,
        force_fresh: bool,
        limit: &Semaphore,
        fetch: F,
    ) -> ProviderOutcome<T>
    where
        T: CachedProvider,
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<Option<T>, ProviderError>>,
    {
        let provider = T::PROVIDER;
        if !force_fresh {
            if let Some(hit) = self.cache_get::<T>(key) {
                return ProviderOutcome::answered(provider, hit, true);
            }
        }
        if let Some(message) = self.breaker_open_message(provider) {
            return ProviderOutcome::failed(provider, message);
        }

        let label = format!("{provider:?} {key}");
        // Waiting for a slot says nothing about the provider's health, so a
        // wait that runs out is reported as "not queried" and does not count
        // toward the breaker.
        let Ok(permit) = tokio::time::timeout(self.provider_budget, limit.acquire()).await else {
            log::debug!("{label}: no free slot within {:?}", self.provider_budget);
            return ProviderOutcome::skipped(
                provider,
                &format!(
                    "Not queried: other lookups kept this provider busy for {} s.",
                    self.provider_budget.as_secs()
                ),
            );
        };
        // Another hop may have filled the cache or tripped the breaker while
        // this one waited.
        if !force_fresh {
            if let Some(hit) = self.cache_get::<T>(key) {
                return ProviderOutcome::answered(provider, hit, true);
            }
        }
        if let Some(message) = self.breaker_open_message(provider) {
            return ProviderOutcome::failed(provider, message);
        }

        let result =
            tokio::time::timeout(self.provider_budget, with_retry(&self.retry, &label, fetch))
                .await;
        drop(permit);
        match result {
            Ok(Ok(record)) => {
                self.cache_insert(key, record.clone());
                self.record_result(provider, true);
                ProviderOutcome::answered(provider, record, false)
            }
            Ok(Err((err, attempts))) => {
                self.record_result(provider, false);
                let plural = if attempts == 1 { "" } else { "s" };
                let message = format!("{} after {attempts} attempt{plural}.", err.describe());
                log::warn!("{label}: {message}");
                ProviderOutcome::failed(provider, message)
            }
            Err(_) => {
                self.record_result(provider, false);
                log::warn!("{label}: lookup exceeded {:?}", self.provider_budget);
                ProviderOutcome::failed(provider, "Timed out.".to_string())
            }
        }
    }

    async fn get_json(
        &self,
        url: &str,
        headers: HeaderMap,
    ) -> Result<Option<Value>, ProviderError> {
        let response = self.client.get(url).headers(headers).send().await?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(ProviderError::from_status(
                status.as_u16(),
                parse_retry_after(response.headers()),
            ));
        }
        let body = response
            .json::<Value>()
            .await
            .map_err(|e| ProviderError::Parse(e.to_string()))?;
        Ok(Some(body))
    }

    async fn fetch_team_cymru(&self, ip: IpAddr) -> Result<Option<CymruRecord>, ProviderError> {
        let network = |e: std::io::Error| ProviderError::Network(e.to_string());
        let mut stream = tokio::net::TcpStream::connect(&self.endpoints.team_cymru_whois)
            .await
            .map_err(network)?;
        stream
            .write_all(format!("begin\nverbose\n{ip}\nend\n").as_bytes())
            .await
            .map_err(network)?;
        let mut response = Vec::new();
        stream
            .take(WHOIS_RESPONSE_LIMIT)
            .read_to_end(&mut response)
            .await
            .map_err(network)?;
        let text = String::from_utf8_lossy(&response);
        // An empty reply is a dropped connection, not "no record"; it must
        // not be cached.
        if text.trim().is_empty() {
            return Err(ProviderError::Network(
                "Team Cymru closed the connection without an answer".to_string(),
            ));
        }
        if !text.contains("Bulk mode") && !text.contains('|') {
            let first_line: String = text
                .lines()
                .next()
                .unwrap_or_default()
                .chars()
                .take(120)
                .collect();
            return Err(ProviderError::Parse(first_line));
        }
        Ok(parse_team_cymru(&text, ip))
    }

    async fn fetch_rdap(
        &self,
        ip: IpAddr,
        base_url: &str,
    ) -> Result<Option<RdapRecord>, ProviderError> {
        let url = format!("{}/{ip}", base_url.trim_end_matches('/'));
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT,
            "application/rdap+json, application/json"
                .parse()
                .expect("static header"),
        );
        Ok(self
            .get_json(&url, headers)
            .await?
            .as_ref()
            .and_then(parse_rdap))
    }

    async fn fetch_ripe_stat(
        &self,
        ip: IpAddr,
        source_app: &str,
    ) -> Result<Option<RipeStatRecord>, ProviderError> {
        let url = format!(
            "{}/data/prefix-overview/data.json?resource={ip}&sourceapp={}",
            self.endpoints.ripe_stat_base.trim_end_matches('/'),
            urlencoding::encode(source_app)
        );
        match self.get_json(&url, HeaderMap::new()).await? {
            Some(body) => parse_ripe_stat(&body),
            None => Ok(None),
        }
    }

    async fn fetch_peeringdb(
        &self,
        asn: u32,
        api_key: Option<&str>,
    ) -> Result<Option<PeeringDbDetails>, ProviderError> {
        let url = format!(
            "{}/api/net?asn={asn}",
            self.endpoints.peering_db_base.trim_end_matches('/')
        );
        let mut headers = HeaderMap::new();
        if let Some(key) = api_key {
            let value = format!("Api-Key {key}")
                .parse()
                .map_err(|_| ProviderError::Client(400))?;
            headers.insert(AUTHORIZATION, value);
        }
        Ok(self
            .get_json(&url, headers)
            .await?
            .as_ref()
            .and_then(parse_peeringdb))
    }

    pub async fn enrich(
        &self,
        ip: IpAddr,
        geolite: GeoLiteResult,
        settings: &IntegrationSettings,
        force_fresh: bool,
    ) -> Enrichment {
        if !is_publicly_routable(ip) {
            let providers = [
                ProviderId::MaxMind,
                ProviderId::TeamCymru,
                ProviderId::Rdap,
                ProviderId::RipeStat,
                ProviderId::PeeringDb,
            ]
            .into_iter()
            .map(|id| ProviderStatus::new(id, ProviderState::Skipped, PRIVATE_ADDRESS_MESSAGE))
            .collect();
            return Enrichment {
                geo: None,
                asn: None,
                peering_db: None,
                providers,
            };
        }

        let key = ip.to_string();
        let cymru = async {
            if !settings.team_cymru.enabled {
                return ProviderOutcome::skipped(ProviderId::TeamCymru, DISABLED_MESSAGE);
            }
            self.cached_lookup(&key, force_fresh, &self.limits.team_cymru, || {
                self.fetch_team_cymru(ip)
            })
            .await
        };
        let rdap = async {
            if !settings.rdap.enabled {
                return ProviderOutcome::skipped(ProviderId::Rdap, DISABLED_MESSAGE);
            }
            let base_url = settings.rdap.base_url();
            // Answers from one RDAP server must not be served after the user
            // switches to another.
            let rdap_key = format!("{base_url}|{key}");
            self.cached_lookup(&rdap_key, force_fresh, &self.limits.rdap, || {
                self.fetch_rdap(ip, base_url)
            })
            .await
        };
        let ripe = async {
            if !settings.ripe_stat.enabled {
                return ProviderOutcome::skipped(ProviderId::RipeStat, DISABLED_MESSAGE);
            }
            let source_app = settings.ripe_stat.source_app.as_str();
            self.cached_lookup(&key, force_fresh, &self.limits.ripe_stat, || {
                self.fetch_ripe_stat(ip, source_app)
            })
            .await
        };
        let (cymru, rdap, ripe) = tokio::join!(cymru, rdap, ripe);

        let asn = choose_asn(&MergeInputs {
            geolite_asn: geolite.asn.as_ref(),
            cymru: cymru.record.as_ref(),
            ripe: ripe.record.as_ref(),
            ..MergeInputs::default()
        });
        let peering_db = match (settings.peering_db.enabled, asn) {
            (false, _) => ProviderOutcome::skipped(ProviderId::PeeringDb, DISABLED_MESSAGE),
            (true, None) => {
                ProviderOutcome::skipped(ProviderId::PeeringDb, "No ASN known for this address.")
            }
            (true, Some(asn)) => {
                let api_key = settings.peering_db.api_key.as_deref();
                self.cached_lookup(
                    &asn.to_string(),
                    force_fresh,
                    &self.limits.peering_db,
                    || self.fetch_peeringdb(asn, api_key),
                )
                .await
            }
        };

        let merged = merge_asn(&MergeInputs {
            geolite_asn: geolite.asn.as_ref(),
            cymru: cymru.record.as_ref(),
            rdap: rdap.record.as_ref(),
            ripe: ripe.record.as_ref(),
            peering_db: peering_db.record.as_ref(),
        });

        Enrichment {
            providers: vec![
                geolite.status(),
                cymru.status,
                rdap.status,
                ripe.status,
                peering_db.status,
            ],
            geo: geolite.geo,
            asn: merged,
            peering_db: peering_db.record,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::persistence::IntegrationSettings;
    use std::collections::HashMap;
    use std::net::SocketAddr;
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, BufReader};
    use tokio::net::TcpListener;

    const CYMRU: &str = include_str!("../../fixtures/providers/team-cymru-verbose.txt");
    const RDAP_ARIN: &str = include_str!("../../fixtures/providers/rdap-arin-8.8.8.8.json");
    const RDAP_RIPE: &str = include_str!("../../fixtures/providers/rdap-ripe-193.0.6.139.json");
    const RIPESTAT: &str =
        include_str!("../../fixtures/providers/ripestat-prefix-overview-8.8.8.8.json");
    const PEERINGDB: &str = include_str!("../../fixtures/providers/peeringdb-net-15169.json");

    fn json(text: &str) -> Value {
        serde_json::from_str(text).expect("fixture is valid JSON")
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    // ---- parsers ----------------------------------------------------------

    #[test]
    fn parses_team_cymru_rows_for_v4_v6_and_unknown() {
        let google = parse_team_cymru(CYMRU, ip("8.8.8.8")).unwrap();
        assert_eq!(
            google,
            CymruRecord {
                asn: Some(15169),
                prefix: Some("8.8.8.0/24".into()),
                country: Some("US".into()),
                registry: Some("arin".into()),
                as_name: Some("GOOGLE - Google LLC, US".into()),
            }
        );

        let v6 = parse_team_cymru(CYMRU, ip("2001:4860:4860::8888")).unwrap();
        assert_eq!(v6.prefix.as_deref(), Some("2001:4860::/32"));

        assert_eq!(parse_team_cymru(CYMRU, ip("10.0.0.1")), None);
        assert_eq!(
            parse_team_cymru("Error: no ASN or IP match", ip("8.8.8.8")),
            None
        );
    }

    #[test]
    fn parses_rdap_arin_and_ripe_shapes() {
        let arin = parse_rdap(&json(RDAP_ARIN)).unwrap();
        assert_eq!(arin.name.as_deref(), Some("GOGL"));
        assert_eq!(arin.handle.as_deref(), Some("NET-8-8-8-0-2"));
        assert_eq!(arin.cidr.as_deref(), Some("8.8.8.0/24"));
        assert_eq!(arin.org_name.as_deref(), Some("Google LLC"));
        assert_eq!(arin.registry.as_deref(), Some("arin"));
        assert_eq!(arin.country, None);

        let ripe = parse_rdap(&json(RDAP_RIPE)).unwrap();
        assert_eq!(ripe.country.as_deref(), Some("NL"));
        assert_eq!(ripe.cidr.as_deref(), Some("193.0.0.0/21"));
        assert_eq!(ripe.registry.as_deref(), Some("ripencc"));
        assert_eq!(
            ripe.org_name.as_deref(),
            Some("Reseaux IP Europeens Network Coordination Centre (RIPE NCC)")
        );

        assert_eq!(
            parse_rdap(&json(r#"{"errorCode":404,"title":"Not Found"}"#)),
            None
        );
    }

    #[test]
    fn parses_ripestat_prefix_overview() {
        let record = parse_ripe_stat(&json(RIPESTAT)).unwrap().unwrap();
        assert_eq!(record.prefix.as_deref(), Some("8.8.8.0/24"));
        assert!(record.announced);
        assert_eq!(
            record.origins,
            [RipeOrigin {
                asn: 15169,
                holder: Some("GOOGLE - Google LLC".into())
            }]
        );

        let unannounced =
            json(r#"{"status":"ok","data":{"announced":false,"asns":[],"resource":"192.0.2.1"}}"#);
        assert_eq!(parse_ripe_stat(&unannounced), Ok(None));
        assert!(parse_ripe_stat(&json(r#"{"status":"error","messages":[]}"#)).is_err());
    }

    #[test]
    fn parses_peeringdb_network() {
        let net = parse_peeringdb(&json(PEERINGDB)).unwrap();
        assert_eq!(net.id, Some(433));
        assert_eq!(net.name.as_deref(), Some("Google LLC"));
        assert_eq!(net.info_type.as_deref(), Some("Content"));
        assert_eq!(net.info_scope.as_deref(), Some("Global"));
        assert_eq!(net.policy_general.as_deref(), Some("Selective"));
        assert_eq!(net.irr_as_set.as_deref(), Some("RADB::AS-GOOGLE"));
        assert_eq!(net.ix_count, Some(160));
        assert_eq!(net.fac_count, Some(135));
        // Empty strings in the API become None, not "".
        assert_eq!(net.info_traffic, None);

        assert_eq!(parse_peeringdb(&json(r#"{"data":[],"meta":{}}"#)), None);
    }

    // ---- merge ------------------------------------------------------------

    fn cymru(asn: u32, name: &str) -> CymruRecord {
        CymruRecord {
            asn: Some(asn),
            prefix: Some("8.8.8.0/24".into()),
            country: Some("US".into()),
            registry: Some("arin".into()),
            as_name: Some(name.into()),
        }
    }

    #[test]
    fn merge_prefers_live_bgp_asn_and_matching_name() {
        let geolite = AsnDetails {
            asn: Some(64500),
            name: Some("STALE-SNAPSHOT".into()),
            ..AsnDetails::default()
        };
        let cymru = cymru(15169, "GOOGLE - Google LLC, US");
        let merged = merge_asn(&MergeInputs {
            geolite_asn: Some(&geolite),
            cymru: Some(&cymru),
            ..MergeInputs::default()
        })
        .unwrap();
        assert_eq!(merged.asn, Some(15169));
        // GeoLite2 disagrees on the ASN, so its name is not used.
        assert_eq!(merged.name.as_deref(), Some("GOOGLE - Google LLC, US"));
        assert_eq!(merged.network.as_deref(), Some("8.8.8.0/24"));
        assert_eq!(merged.registry.as_deref(), Some("arin"));
    }

    #[test]
    fn merge_uses_geolite_name_when_asn_agrees() {
        let geolite = AsnDetails {
            asn: Some(15169),
            name: Some("GOOGLE".into()),
            ..AsnDetails::default()
        };
        let cymru = cymru(15169, "GOOGLE - Google LLC, US");
        let ripe = parse_ripe_stat(&json(RIPESTAT)).unwrap().unwrap();
        let merged = merge_asn(&MergeInputs {
            geolite_asn: Some(&geolite),
            cymru: Some(&cymru),
            ripe: Some(&ripe),
            ..MergeInputs::default()
        })
        .unwrap();
        assert_eq!(merged.name.as_deref(), Some("GOOGLE"));
    }

    #[test]
    fn merge_falls_back_to_rdap_when_no_asn_source_answers() {
        let rdap = parse_rdap(&json(RDAP_RIPE)).unwrap();
        let merged = merge_asn(&MergeInputs {
            rdap: Some(&rdap),
            ..MergeInputs::default()
        })
        .unwrap();
        assert_eq!(merged.asn, None);
        assert_eq!(merged.network.as_deref(), Some("193.0.0.0/21"));
        assert_eq!(merged.country.as_deref(), Some("NL"));
        assert_eq!(merged.registry.as_deref(), Some("ripencc"));
        assert!(merged.name.unwrap().contains("RIPE NCC"));
    }

    #[test]
    fn merge_of_nothing_is_none() {
        assert_eq!(merge_asn(&MergeInputs::default()), None);
    }

    // ---- service against local mock servers -------------------------------

    type Response = (u16, Vec<(&'static str, &'static str)>, String);

    const DELAY_HEADER: &str = "x-test-delay-ms";

    #[derive(Clone, Default)]
    struct Hits(Arc<std::sync::Mutex<HashMap<String, Vec<String>>>>);

    impl Hits {
        fn count(&self, route: &str) -> usize {
            self.0.lock().unwrap().get(route).map_or(0, Vec::len)
        }
        fn requests(&self, route: &str) -> Vec<String> {
            self.0
                .lock()
                .unwrap()
                .get(route)
                .cloned()
                .unwrap_or_default()
        }
    }

    /// Minimal HTTP/1.1 server. Each route serves its responses in order and
    /// repeats the last one.
    async fn mock_http(routes: Vec<(&'static str, Vec<Response>)>) -> (SocketAddr, Hits) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hits = Hits::default();
        let routes = Arc::new(routes);
        let server_hits = hits.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let routes = routes.clone();
                let hits = server_hits.clone();
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stream);
                    let mut head = String::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).await.unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        head.push_str(&line);
                    }
                    let path = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let (status, headers, body) =
                        match routes.iter().find(|(prefix, _)| path.starts_with(prefix)) {
                            Some((prefix, responses)) => {
                                let mut map = hits.0.lock().unwrap();
                                let seen = map.entry(prefix.to_string()).or_default();
                                seen.push(head.to_lowercase());
                                responses[(seen.len() - 1).min(responses.len() - 1)].clone()
                            }
                            None => (404, vec![], "{}".to_string()),
                        };
                    // A DELAY_HEADER entry makes the mock answer slowly; it is
                    // not sent to the client.
                    if let Some((_, ms)) = headers.iter().find(|(k, _)| *k == DELAY_HEADER) {
                        tokio::time::sleep(Duration::from_millis(ms.parse().unwrap())).await;
                    }
                    let extra: String = headers
                        .iter()
                        .filter(|(k, _)| *k != DELAY_HEADER)
                        .map(|(k, v)| format!("{k}: {v}\r\n"))
                        .collect();
                    let response = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",
                        body.len()
                    );
                    let mut stream = reader.into_inner();
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        (addr, hits)
    }

    async fn mock_whois(reply: &'static str) -> (SocketAddr, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let server_count = count.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                server_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stream);
                    let mut line = String::new();
                    while reader.read_line(&mut line).await.unwrap_or(0) > 0 && line.trim() != "end"
                    {
                        line.clear();
                    }
                    let mut stream = reader.into_inner();
                    let _ = stream.write_all(reply.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        (addr, count)
    }

    fn service(
        http: SocketAddr,
        whois: SocketAddr,
        cache_path: Option<PathBuf>,
    ) -> EnrichmentService {
        service_with_budget(http, whois, cache_path, Duration::from_secs(10))
    }

    fn service_with_budget(
        http: SocketAddr,
        whois: SocketAddr,
        cache_path: Option<PathBuf>,
        provider_budget: Duration,
    ) -> EnrichmentService {
        EnrichmentService::new(EnrichmentConfig {
            client: reqwest::Client::builder().no_proxy().build().unwrap(),
            endpoints: ProviderEndpoints {
                team_cymru_whois: whois.to_string(),
                ripe_stat_base: format!("http://{http}"),
                peering_db_base: format!("http://{http}"),
            },
            retry: RetryPolicy {
                max_attempts: 3,
                base_delay: Duration::from_millis(1),
                max_delay: Duration::from_millis(5),
                attempt_timeout: Duration::from_secs(2),
            },
            breaker: BreakerPolicy {
                threshold: 3,
                cooldown: Duration::from_millis(300),
            },
            provider_budget,
            ttl: Duration::from_secs(3600),
            cache_path,
        })
    }

    fn settings(http: SocketAddr) -> IntegrationSettings {
        let mut settings = IntegrationSettings::default();
        settings.rdap.base_url = Some(format!("http://{http}/rdap/ip"));
        settings.peering_db.enabled = true;
        settings.peering_db.api_key = Some("test-key".into());
        settings
    }

    fn status(enrichment: &Enrichment, id: ProviderId) -> &ProviderStatus {
        enrichment
            .providers
            .iter()
            .find(|p| p.provider == id)
            .unwrap()
    }

    fn no_geolite() -> GeoLiteResult {
        GeoLiteResult {
            geo: None,
            asn: None,
            databases_loaded: false,
        }
    }

    #[tokio::test]
    async fn enrich_retries_merges_and_then_serves_from_cache() {
        let (http, hits) = mock_http(vec![
            (
                "/rdap/ip/8.8.8.8",
                vec![(200, vec![], RDAP_ARIN.to_string())],
            ),
            (
                "/data/prefix-overview",
                vec![
                    (503, vec![], "{}".into()),
                    (200, vec![], RIPESTAT.to_string()),
                ],
            ),
            (
                "/api/net",
                vec![
                    (429, vec![("Retry-After", "0")], "{}".into()),
                    (200, vec![], PEERINGDB.to_string()),
                ],
            ),
        ])
        .await;
        let (whois, whois_hits) = mock_whois(CYMRU).await;
        let service = service(http, whois, None);
        let settings = settings(http);

        let first = service
            .enrich(ip("8.8.8.8"), no_geolite(), &settings, false)
            .await;
        let asn = first.asn.clone().unwrap();
        assert_eq!(asn.asn, Some(15169));
        assert_eq!(asn.name.as_deref(), Some("GOOGLE - Google LLC"));
        assert_eq!(asn.network.as_deref(), Some("8.8.8.0/24"));
        assert_eq!(asn.country.as_deref(), Some("US"));
        assert_eq!(
            first.peering_db.as_ref().and_then(|p| p.name.as_deref()),
            Some("Google LLC")
        );
        for id in [
            ProviderId::TeamCymru,
            ProviderId::Rdap,
            ProviderId::RipeStat,
            ProviderId::PeeringDb,
        ] {
            let s = status(&first, id);
            assert_eq!(s.status, ProviderState::Success, "{id:?}: {:?}", s.message);
            assert!(!s.cached);
        }
        assert_eq!(
            status(&first, ProviderId::MaxMind).status,
            ProviderState::Skipped
        );
        assert_eq!(
            hits.count("/data/prefix-overview"),
            2,
            "RIPEstat 503 was retried"
        );
        assert_eq!(hits.count("/api/net"), 2, "PeeringDB 429 was retried");
        assert!(hits.requests("/api/net")[0].contains("authorization: api-key test-key"));
        assert!(hits.requests("/data/prefix-overview")[0].contains("sourceapp=vistracer"));

        let second = service
            .enrich(ip("8.8.8.8"), no_geolite(), &settings, false)
            .await;
        assert_eq!(second.asn, first.asn);
        assert!(second
            .providers
            .iter()
            .filter(|p| p.provider != ProviderId::MaxMind)
            .all(|p| p.cached));
        assert_eq!(hits.count("/rdap/ip/8.8.8.8"), 1);
        assert_eq!(whois_hits.load(std::sync::atomic::Ordering::SeqCst), 1);

        let forced = service
            .enrich(ip("8.8.8.8"), no_geolite(), &settings, true)
            .await;
        assert!(forced.providers.iter().all(|p| !p.cached));
        assert_eq!(hits.count("/rdap/ip/8.8.8.8"), 2);
    }

    #[tokio::test]
    async fn failing_provider_degrades_gracefully() {
        let (http, hits) = mock_http(vec![
            ("/rdap/ip", vec![(500, vec![], "{}".into())]),
            (
                "/data/prefix-overview",
                vec![(200, vec![], RIPESTAT.to_string())],
            ),
            ("/api/net", vec![(200, vec![], PEERINGDB.to_string())]),
        ])
        .await;
        let (whois, _) = mock_whois(CYMRU).await;
        let service = service(http, whois, None);

        let geolite = GeoLiteResult {
            geo: Some(GeoDetails {
                latitude: 37.751,
                longitude: -97.822,
                city: None,
                country: Some("United States".into()),
                iso_code: Some("US".into()),
                confidence: Some(1000.0),
            }),
            asn: Some(AsnDetails {
                asn: Some(15169),
                name: Some("GOOGLE".into()),
                ..AsnDetails::default()
            }),
            databases_loaded: true,
        };
        let result = service
            .enrich(ip("8.8.8.8"), geolite, &settings(http), false)
            .await;

        let rdap = status(&result, ProviderId::Rdap);
        assert_eq!(rdap.status, ProviderState::Error);
        assert_eq!(
            rdap.message.as_deref(),
            Some("Server error (HTTP 500) after 3 attempts.")
        );
        assert_eq!(hits.count("/rdap/ip"), 3);
        assert!(
            result.geo.is_some(),
            "GeoLite2 data survives a provider failure"
        );
        assert_eq!(
            result.asn.as_ref().and_then(|a| a.name.as_deref()),
            Some("GOOGLE")
        );
        assert_eq!(
            status(&result, ProviderId::MaxMind).status,
            ProviderState::Success
        );
    }

    #[tokio::test]
    async fn repeated_failures_pause_the_provider_then_retry() {
        let (http, hits) = mock_http(vec![
            ("/rdap/ip", vec![(500, vec![], "{}".into())]),
            (
                "/data/prefix-overview",
                vec![(200, vec![], RIPESTAT.to_string())],
            ),
        ])
        .await;
        let (whois, _) = mock_whois(CYMRU).await;
        let service = service(http, whois, None);
        let mut settings = settings(http);
        settings.peering_db.enabled = false;

        for addr in ["8.8.8.8", "8.8.4.4", "1.1.1.1"] {
            let result = service
                .enrich(ip(addr), no_geolite(), &settings, false)
                .await;
            assert_eq!(
                status(&result, ProviderId::Rdap).status,
                ProviderState::Error
            );
        }
        assert_eq!(hits.count("/rdap/ip"), 9, "3 lookups x 3 attempts");

        let paused = service
            .enrich(ip("9.9.9.9"), no_geolite(), &settings, false)
            .await;
        let rdap = status(&paused, ProviderId::Rdap);
        assert_eq!(rdap.status, ProviderState::Error);
        assert!(rdap
            .message
            .as_deref()
            .unwrap()
            .starts_with("Skipped: failed 3 times"));
        assert_eq!(hits.count("/rdap/ip"), 9, "no request while paused");
        assert_eq!(
            status(&paused, ProviderId::RipeStat).status,
            ProviderState::Success
        );

        tokio::time::sleep(Duration::from_millis(350)).await;
        service
            .enrich(ip("9.9.9.9"), no_geolite(), &settings, false)
            .await;
        assert_eq!(
            hits.count("/rdap/ip"),
            12,
            "lookups resume after the cooldown"
        );
    }

    fn rdap_only(http: SocketAddr) -> IntegrationSettings {
        let mut settings = settings(http);
        settings.team_cymru.enabled = false;
        settings.ripe_stat.enabled = false;
        settings.peering_db.enabled = false;
        settings
    }

    #[tokio::test]
    async fn waiting_for_a_provider_slot_is_not_a_provider_failure() {
        // RDAP allows 2 requests at a time and each answer takes 600 ms, so
        // of 6 parallel lookups the last 2 wait longer than the 1 s budget.
        let (http, hits) = mock_http(vec![(
            "/rdap/ip",
            vec![(200, vec![(DELAY_HEADER, "600")], RDAP_ARIN.to_string())],
        )])
        .await;
        let (whois, _) = mock_whois(CYMRU).await;
        let service = service_with_budget(http, whois, None, Duration::from_secs(1));
        let settings = rdap_only(http);
        let lookup = |addr: &'static str| service.enrich(ip(addr), no_geolite(), &settings, false);

        let results = tokio::join!(
            lookup("8.8.8.1"),
            lookup("8.8.8.2"),
            lookup("8.8.8.3"),
            lookup("8.8.8.4"),
            lookup("8.8.8.5"),
            lookup("8.8.8.6")
        );
        let rdap: Vec<&ProviderStatus> = [
            &results.0, &results.1, &results.2, &results.3, &results.4, &results.5,
        ]
        .into_iter()
        .map(|r| status(r, ProviderId::Rdap))
        .collect();
        let answered = rdap
            .iter()
            .filter(|s| s.status == ProviderState::Success)
            .count();
        let waited: Vec<_> = rdap
            .iter()
            .filter(|s| s.status == ProviderState::Skipped)
            .collect();
        assert_eq!(answered, 4, "{rdap:?}");
        assert_eq!(waited.len(), 2, "{rdap:?}");
        assert!(waited.iter().all(|s| s
            .message
            .as_deref()
            .unwrap()
            .starts_with("Not queried: other lookups")));
        assert_eq!(hits.count("/rdap/ip"), 4);

        // The breaker stayed closed: the next lookup reaches the server.
        let next = service
            .enrich(ip("8.8.8.7"), no_geolite(), &settings, false)
            .await;
        assert_eq!(
            status(&next, ProviderId::Rdap).status,
            ProviderState::Success
        );
        assert_eq!(hits.count("/rdap/ip"), 5);
    }

    #[tokio::test]
    async fn rdap_cache_is_keyed_by_base_url() {
        let (http, hits) = mock_http(vec![
            ("/first/ip", vec![(200, vec![], RDAP_ARIN.to_string())]),
            ("/second/ip", vec![(200, vec![], RDAP_RIPE.to_string())]),
        ])
        .await;
        let (whois, _) = mock_whois(CYMRU).await;
        let service = service(http, whois, None);
        let mut settings = rdap_only(http);

        settings.rdap.base_url = Some(format!("http://{http}/first/ip"));
        service
            .enrich(ip("8.8.8.8"), no_geolite(), &settings, false)
            .await;
        settings.rdap.base_url = Some(format!("http://{http}/second/ip"));
        let switched = service
            .enrich(ip("8.8.8.8"), no_geolite(), &settings, false)
            .await;
        assert!(!status(&switched, ProviderId::Rdap).cached);
        assert_eq!(hits.count("/second/ip"), 1);

        settings.rdap.base_url = Some(format!("http://{http}/first/ip"));
        let back = service
            .enrich(ip("8.8.8.8"), no_geolite(), &settings, false)
            .await;
        assert!(status(&back, ProviderId::Rdap).cached);
        assert_eq!(hits.count("/first/ip"), 1);
    }

    #[tokio::test]
    async fn failed_cache_write_keeps_changes_for_the_next_persist() {
        let (http, _) = mock_http(vec![(
            "/rdap/ip",
            vec![(200, vec![], RDAP_ARIN.to_string())],
        )])
        .await;
        let (whois, _) = mock_whois(CYMRU).await;
        let blocker =
            std::env::temp_dir().join(format!("vistracer-blocker-{}", uuid::Uuid::new_v4()));
        std::fs::write(&blocker, "a file, so its child path cannot be a directory").unwrap();
        let service = service(
            http,
            whois,
            Some(blocker.join("cache").join("enrichment-cache.json")),
        );

        service
            .enrich(ip("8.8.8.8"), no_geolite(), &rdap_only(http), false)
            .await;
        service.persist();

        let mut cache = service.cache.lock().unwrap();
        assert!(cache
            .snapshot_if_dirty(now_ms(), service.ttl_ms)
            .unwrap()
            .is_some());
        drop(cache);
        std::fs::remove_file(&blocker).unwrap();
    }

    #[tokio::test]
    async fn empty_whois_reply_is_an_error_and_not_cached() {
        let (http, _) = mock_http(vec![]).await;
        let (whois, whois_hits) = mock_whois("").await;
        let service = service(http, whois, None);
        let mut settings = settings(http);
        settings.rdap.enabled = false;
        settings.ripe_stat.enabled = false;
        settings.peering_db.enabled = false;

        let first = service
            .enrich(ip("8.8.8.8"), no_geolite(), &settings, false)
            .await;
        let cymru = status(&first, ProviderId::TeamCymru);
        assert_eq!(cymru.status, ProviderState::Error);
        assert!(cymru
            .message
            .as_deref()
            .unwrap()
            .contains("without an answer"));
        assert_eq!(whois_hits.load(std::sync::atomic::Ordering::SeqCst), 3);

        service
            .enrich(ip("8.8.8.8"), no_geolite(), &settings, false)
            .await;
        assert_eq!(
            whois_hits.load(std::sync::atomic::Ordering::SeqCst),
            6,
            "nothing was cached"
        );
    }

    #[tokio::test]
    async fn private_and_disabled_lookups_send_nothing() {
        let (http, hits) = mock_http(vec![]).await;
        let (whois, whois_hits) = mock_whois(CYMRU).await;
        let service = service(http, whois, None);

        let private = service
            .enrich(ip("192.168.1.1"), no_geolite(), &settings(http), false)
            .await;
        assert!(private
            .providers
            .iter()
            .all(|p| p.status == ProviderState::Skipped));

        let mut disabled = settings(http);
        disabled.team_cymru.enabled = false;
        disabled.rdap.enabled = false;
        disabled.ripe_stat.enabled = false;
        disabled.peering_db.enabled = false;
        let result = service
            .enrich(ip("8.8.8.8"), no_geolite(), &disabled, false)
            .await;
        assert!(result
            .providers
            .iter()
            .filter(|p| p.provider != ProviderId::MaxMind)
            .all(|p| p.status == ProviderState::Skipped
                && p.message.as_deref() == Some(DISABLED_MESSAGE)));
        assert_eq!(result.asn, None);

        assert_eq!(hits.0.lock().unwrap().len(), 0);
        assert_eq!(whois_hits.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn persisted_cache_is_reused_by_a_new_service() {
        let (http, hits) = mock_http(vec![
            ("/rdap/ip", vec![(404, vec![], "{}".into())]),
            (
                "/data/prefix-overview",
                vec![(200, vec![], RIPESTAT.to_string())],
            ),
        ])
        .await;
        let (whois, whois_hits) = mock_whois(CYMRU).await;
        let dir = std::env::temp_dir().join(format!("vistracer-enrich-{}", uuid::Uuid::new_v4()));
        let path = dir.join("enrichment-cache.json");
        let mut settings = settings(http);
        settings.peering_db.enabled = false;

        let first = service(http, whois, Some(path.clone()));
        let fresh = first
            .enrich(ip("8.8.8.8"), no_geolite(), &settings, false)
            .await;
        assert_eq!(
            status(&fresh, ProviderId::Rdap).message.as_deref(),
            Some("No record found.")
        );
        first.persist();
        assert!(path.exists());

        let second = service(http, whois, Some(path));
        let cached = second
            .enrich(ip("8.8.8.8"), no_geolite(), &settings, false)
            .await;
        assert_eq!(cached.asn, fresh.asn);
        assert_eq!(
            status(&cached, ProviderId::Rdap).message.as_deref(),
            Some("No record found (cached).")
        );
        assert_eq!(hits.count("/rdap/ip"), 1);
        assert_eq!(hits.count("/data/prefix-overview"), 1);
        assert_eq!(whois_hits.load(std::sync::atomic::Ordering::SeqCst), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
