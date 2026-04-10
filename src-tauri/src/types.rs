use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TracerouteRequest {
    pub target: String,
    pub protocol: String,
    #[serde(rename = "maxHops")]
    pub max_hops: u32,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: u32,
    #[serde(rename = "packetCount")]
    pub packet_count: u32,
    #[serde(rename = "forceFresh")]
    pub force_fresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoCoordinates {
    pub latitude: f64,
    pub longitude: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoDetails {
    pub latitude: f64,
    pub longitude: f64,
    pub city: Option<String>,
    pub country: Option<String>,
    #[serde(rename = "isoCode")]
    pub iso_code: Option<String>,
    pub confidence: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsnDetails {
    pub asn: Option<u32>,
    pub name: Option<String>,
    pub network: Option<String>,
    pub country: Option<String>,
    pub registry: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderStatus {
    pub provider: String,
    pub status: String,
    pub message: Option<String>,
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeeringDbDetails {
    pub id: Option<u64>,
    pub name: Option<String>,
    pub aka: Option<String>,
    pub website: Option<String>,
    pub city: Option<String>,
    pub country: Option<String>,
    #[serde(rename = "ixCount")]
    pub ix_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HopLatencyStats {
    #[serde(rename = "minRttMs")]
    pub min_rtt_ms: Option<f64>,
    #[serde(rename = "maxRttMs")]
    pub max_rtt_ms: Option<f64>,
    #[serde(rename = "avgRttMs")]
    pub avg_rtt_ms: Option<f64>,
    #[serde(rename = "jitterMs")]
    pub jitter_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HopResolution {
    #[serde(rename = "hopIndex")]
    pub hop_index: u32,
    #[serde(rename = "ipAddress")]
    pub ip_address: Option<String>,
    #[serde(rename = "hostName")]
    pub host_name: Option<String>,
    #[serde(rename = "lossPercent")]
    pub loss_percent: Option<f64>,
    pub latency: HopLatencyStats,
    pub geo: Option<GeoDetails>,
    pub asn: Option<AsnDetails>,
    #[serde(rename = "isPrivate")]
    pub is_private: bool,
    #[serde(rename = "isAnycastSuspected")]
    pub is_anycast_suspected: bool,
    #[serde(rename = "rawLine")]
    pub raw_line: String,
    pub providers: Option<Vec<ProviderStatus>>,
    #[serde(rename = "peeringDb")]
    pub peering_db: Option<PeeringDbDetails>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TracerouteSummary {
    pub target: String,
    #[serde(rename = "startedAt")]
    pub started_at: f64,
    #[serde(rename = "completedAt")]
    pub completed_at: Option<f64>,
    #[serde(rename = "hopCount")]
    pub hop_count: u32,
    #[serde(rename = "protocolsTried")]
    pub protocols_tried: Vec<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TracerouteRun {
    pub request: TracerouteRequest,
    pub summary: TracerouteSummary,
    pub hops: Vec<HopResolution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TracerouteExecutionResult {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub run: TracerouteRun,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TracerouteProgressEvent {
    #[serde(rename = "runId")]
    pub run_id: String,
    pub hop: Option<HopResolution>,
    pub completed: bool,
    pub summary: Option<TracerouteSummary>,
    pub hops: Option<Vec<HopResolution>>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentRun {
    pub id: String,
    #[serde(rename = "startedAt")]
    pub started_at: f64,
    pub target: String,
    pub protocol: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoDatabaseMeta {
    #[serde(rename = "cityDbPath")]
    pub city_db_path: Option<String>,
    #[serde(rename = "asnDbPath")]
    pub asn_db_path: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<f64>,
    #[serde(rename = "cityDbStatus")]
    pub city_db_status: String,
    #[serde(rename = "asnDbStatus")]
    pub asn_db_status: String,
    #[serde(rename = "statusMessage")]
    pub status_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoDbDownloadProgress {
    pub stage: String,
    pub edition: String,
    pub percent: Option<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotExportOptions {
    pub format: String,
    #[serde(rename = "outputPath")]
    pub output_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotExportResult {
    pub success: bool,
    pub path: Option<String>,
    pub error: Option<String>,
}
