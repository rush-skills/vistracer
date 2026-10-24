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

/// What produced a location estimate. RTT checks and anycast detection do
/// not produce coordinates: they filter and annotate these estimates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocationSource {
    /// The address is on a PeeringDB IX peering LAN.
    Ixp,
    /// A location code or city name in the reverse-DNS name.
    HostnameHint,
    GeoliteCity,
    /// A GeoLite2 record without a city: the country centroid.
    GeoliteCountry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocationConfidence {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RttVerdict {
    /// Possible, and the RTT does not change the radius.
    Feasible,
    /// Possible; the RTT limits the hop to a smaller area around the estimate.
    Tightened,
    /// Possible only outside the stated radius, so the radius grows.
    Widened,
    /// Physically impossible for the measured RTT. Never chosen as best.
    Infeasible,
}

/// Result of the speed-of-light check of one estimate against the
/// reference hop (see `geoloc::rtt`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RttCheck {
    pub verdict: RttVerdict,
    /// Great-circle distance from the reference location to the estimate.
    pub distance_km: f64,
    /// Furthest the hop can be from the reference location.
    pub max_distance_km: f64,
    /// Radius of the estimate before the check.
    pub original_radius_km: f64,
    pub reference_hop_index: u32,
    /// Hop whose RTT set the bound: this hop or a later one on the path.
    pub bound_hop_index: u32,
    pub bound_rtt_ms: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationEstimate {
    pub source: LocationSource,
    pub latitude: f64,
    pub longitude: f64,
    pub radius_km: f64,
    pub confidence: LocationConfidence,
    /// Place name for display, for example "Frankfurt, DE".
    pub label: String,
    /// `None` when there is no reference hop or no RTT to check against.
    pub rtt: Option<RttCheck>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IxpMatch {
    pub ix_id: u64,
    pub name: String,
    pub city: Option<String>,
    pub country: Option<String>,
    /// The IX peering LAN prefix that contains the address.
    pub prefix: String,
    /// Facilities with coordinates that the IX location is computed from.
    pub facility_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HintRule {
    /// A code from the naming table of a known carrier, e.g. Arelion `ffm`.
    CarrierCode,
    /// A 6-letter city and region code, e.g. NTT `lsanca`.
    CityRegionCode,
    /// A full city name, e.g. Lumen `Frankfurt1`.
    CityName,
    /// An IATA airport or metro code with a site number, e.g. `fra03`.
    AirportCode,
    /// A bare 3-letter IATA code. Kept only when another source agrees on
    /// the country.
    BareAirportCode,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostnameHint {
    pub host_name: String,
    /// The part of the host name that matched, e.g. `fra03`.
    pub token: String,
    pub rule: HintRule,
    /// Carrier whose naming scheme matched, when the domain is known.
    pub carrier: Option<String>,
    /// IATA code of the airport whose coordinates stand in for the place.
    pub iata: String,
    pub place: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AnycastEvidence {
    /// The address is in a documented anycast prefix (bundled list).
    KnownPrefix,
    /// The origin ASN announces its address space from many sites, and the
    /// RTT rules out the GeoLite2 location.
    OperatorAsnRtt,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnycastInfo {
    pub evidence: AnycastEvidence,
    pub service: String,
    /// True when the RTT rules out the GeoLite2 location.
    pub geolite_ruled_out: bool,
    /// Furthest the site that answered can be from the reference hop.
    pub max_distance_km: Option<f64>,
    pub reference_hop_index: Option<u32>,
}

/// All location estimates for a hop. `best` is drawn on the globe;
/// `alternatives` holds every other candidate, best-ranked first. An
/// anycast hop has no `best`: no single point is true for it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HopLocation {
    pub best: Option<LocationEstimate>,
    pub alternatives: Vec<LocationEstimate>,
    pub ixp: Option<IxpMatch>,
    pub hostname_hint: Option<HostnameHint>,
    pub anycast: Option<AnycastInfo>,
    /// Other hops of the run are RTT-checked against this hop's location.
    pub is_rtt_reference: bool,
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
