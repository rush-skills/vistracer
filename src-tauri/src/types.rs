use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum TracerouteProtocol {
    Icmp,
    Udp,
    Tcp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TracerouteRequest {
    pub target: String,
    pub protocol: TracerouteProtocol,
    pub max_hops: u32,
    pub timeout_ms: u32,
    pub packet_count: u32,
    pub force_fresh: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoDetails {
    pub latitude: f64,
    pub longitude: f64,
    pub city: Option<String>,
    pub country: Option<String>,
    pub iso_code: Option<String>,
    /// GeoLite2 `accuracy_radius`, in kilometres.
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsnDetails {
    pub asn: Option<u32>,
    pub name: Option<String>,
    pub network: Option<String>,
    pub country: Option<String>,
    pub registry: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ProviderId {
    #[serde(rename = "maxmind")]
    MaxMind,
    #[serde(rename = "team-cymru")]
    TeamCymru,
    #[serde(rename = "rdap")]
    Rdap,
    #[serde(rename = "ripe-stat")]
    RipeStat,
    #[serde(rename = "peeringdb")]
    PeeringDb,
}

/// `Success` means the provider answered (with or without a record).
/// `Error` means the lookup failed. `Skipped` means it was not attempted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderState {
    Success,
    Error,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: ProviderId,
    pub status: ProviderState,
    pub message: Option<String>,
    pub cached: bool,
}

impl ProviderStatus {
    pub fn new(provider: ProviderId, status: ProviderState, message: impl Into<String>) -> Self {
        Self {
            provider,
            status,
            message: Some(message.into()),
            cached: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeeringDbDetails {
    pub id: Option<u64>,
    pub name: Option<String>,
    pub aka: Option<String>,
    pub website: Option<String>,
    pub info_type: Option<String>,
    pub info_scope: Option<String>,
    pub info_traffic: Option<String>,
    pub info_ratio: Option<String>,
    pub policy_general: Option<String>,
    pub irr_as_set: Option<String>,
    pub ix_count: Option<u64>,
    pub fac_count: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HopLatencyStats {
    pub min_rtt_ms: Option<f64>,
    pub max_rtt_ms: Option<f64>,
    pub avg_rtt_ms: Option<f64>,
    pub jitter_ms: Option<f64>,
}

/// One address that answered probes for a hop. Load-balanced paths
/// produce more than one responder per hop.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HopResponder {
    pub ip_address: String,
    pub host_name: Option<String>,
    pub rtts_ms: Vec<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LookupState {
    Pending,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HopResolution {
    pub hop_index: u32,
    pub ip_address: Option<String>,
    pub host_name: Option<String>,
    pub responders: Vec<HopResponder>,
    pub loss_percent: Option<f64>,
    pub latency: HopLatencyStats,
    pub geo: Option<GeoDetails>,
    pub asn: Option<AsnDetails>,
    pub is_private: bool,
    pub is_anycast_suspected: bool,
    pub raw_line: String,
    pub providers: Option<Vec<ProviderStatus>>,
    pub peering_db: Option<PeeringDbDetails>,
    pub lookup_state: LookupState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TracerouteSummary {
    pub target: String,
    pub started_at: f64,
    pub completed_at: Option<f64>,
    pub hop_count: u32,
    pub protocols_tried: Vec<TracerouteProtocol>,
    pub error: Option<String>,
    pub notices: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TracerouteRun {
    pub request: TracerouteRequest,
    pub summary: TracerouteSummary,
    pub hops: Vec<HopResolution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TracerouteExecutionResult {
    pub run_id: String,
    pub run: TracerouteRun,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TracerouteProgressEvent {
    pub run_id: String,
    pub hop: Option<HopResolution>,
    pub completed: bool,
    pub summary: Option<TracerouteSummary>,
    pub hops: Option<Vec<HopResolution>>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRun {
    pub id: String,
    pub started_at: f64,
    pub target: String,
    pub protocol: TracerouteProtocol,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GeoDatabaseStatus {
    Loaded,
    Missing,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoDatabaseMeta {
    pub city_db_path: Option<String>,
    pub asn_db_path: Option<String>,
    pub updated_at: Option<f64>,
    pub city_db_status: GeoDatabaseStatus,
    pub asn_db_status: GeoDatabaseStatus,
    pub status_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoDbDownloadProgress {
    pub stage: String,
    pub edition: String,
    pub percent: Option<u32>,
    pub error: Option<String>,
}
