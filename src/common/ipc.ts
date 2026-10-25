export type TracerouteProtocol = "ICMP" | "UDP" | "TCP";

export interface TracerouteRequest {
  target: string;
  protocol: TracerouteProtocol;
  maxHops: number;
  timeoutMs: number;
  packetCount: number;
  forceFresh: boolean;
}

export interface GeoCoordinates {
  latitude: number;
  longitude: number;
}

export interface GeoDetails extends GeoCoordinates {
  city?: string;
  country?: string;
  isoCode?: string;
  /** GeoLite2 accuracy radius in kilometres. */
  confidence?: number;
}

export interface AsnDetails {
  asn?: number;
  name?: string;
  network?: string;
  country?: string;
  registry?: string;
}

export type ProviderId =
  | "maxmind"
  | "team-cymru"
  | "rdap"
  | "ripe-stat"
  | "peeringdb"
  | "peeringdb-ix";

/**
 * success: the provider answered (with or without a record).
 * error: the lookup failed (network, HTTP, timeout, parse).
 * skipped: not attempted (disabled, private address, no ASN, no database).
 */
export type ProviderState = "success" | "error" | "skipped";

export interface ProviderStatus {
  provider: ProviderId;
  status: ProviderState;
  message: string | null;
  cached: boolean;
}

export interface PeeringDbDetails {
  id?: number;
  name?: string;
  aka?: string;
  website?: string;
  infoType?: string;
  infoScope?: string;
  infoTraffic?: string;
  infoRatio?: string;
  policyGeneral?: string;
  irrAsSet?: string;
  ixCount?: number;
  facCount?: number;
}

export interface HopLatencyStats {
  minRttMs: number | null;
  maxRttMs: number | null;
  avgRttMs: number | null;
  jitterMs: number | null;
}

/** One address that answered probes for a hop (multipath hops have several). */
export interface HopResponder {
  ipAddress: string;
  hostName: string | null;
  rttsMs: number[];
}

export type LookupState = "pending" | "complete";

/** What produced a location estimate (mirrors `LocationSource` in src-tauri/src/types.rs). */
export type LocationSource = "ixp" | "hostname-hint" | "geolite-city" | "geolite-country";

export type LocationConfidence = "high" | "medium" | "low";

/**
 * Checked against the reference hop's estimate (itself often GeoLite2).
 * feasible: possible, radius unchanged. tightened: the RTT limits the hop to a
 * smaller area. widened: possible only beyond the stated radius. infeasible:
 * impossible relative to the reference and weaker than it; never the best
 * estimate. conflict: impossible relative to the reference but at least as
 * strong as it; kept, radius unchanged.
 */
export type RttVerdict = "feasible" | "tightened" | "widened" | "infeasible" | "conflict";

export interface RttCheck {
  verdict: RttVerdict;
  distanceKm: number;
  maxDistanceKm: number;
  originalRadiusKm: number;
  referenceHopIndex: number;
  /** Source of the reference hop's estimate. */
  referenceSource: LocationSource;
  /** Hop whose RTT set the bound: this hop or a later one. */
  boundHopIndex: number;
  boundRttMs: number;
}

export interface LocationEstimate {
  source: LocationSource;
  latitude: number;
  longitude: number;
  radiusKm: number;
  confidence: LocationConfidence;
  label: string;
  rtt: RttCheck | null;
}

export interface IxpMatch {
  ixId: number;
  name: string;
  city: string | null;
  country: string | null;
  prefix: string;
  facilityCount: number;
}

export type HintRule =
  | "carrier-code"
  | "city-region-code"
  | "city-name"
  | "airport-code"
  | "bare-airport-code";

export interface HostnameHint {
  hostName: string;
  token: string;
  rule: HintRule;
  carrier: string | null;
  iata: string;
  place: string;
}

export type AnycastEvidence = "known-prefix" | "operator-asn-rtt";

export interface AnycastInfo {
  evidence: AnycastEvidence;
  service: string;
  geoliteRuledOut: boolean;
  maxDistanceKm: number | null;
  referenceHopIndex: number | null;
}

/** `best` is drawn on the globe; anycast hops have none. */
export interface HopLocation {
  best: LocationEstimate | null;
  alternatives: LocationEstimate[];
  ixp: IxpMatch | null;
  hostnameHint: HostnameHint | null;
  anycast: AnycastInfo | null;
  isRttReference: boolean;
}

/** Rust sends every field; `Option` values arrive as `null`. */
export interface HopResolution {
  hopIndex: number;
  ipAddress: string | null;
  hostName: string | null;
  responders: HopResponder[];
  lossPercent: number | null;
  latency: HopLatencyStats;
  /** Raw GeoLite2 City record; `location` holds the estimate to draw. */
  geo?: GeoDetails | null;
  asn?: AsnDetails | null;
  isPrivate: boolean;
  location: HopLocation;
  rawLine: string;
  providers?: ProviderStatus[] | null;
  peeringDb?: PeeringDbDetails | null;
  lookupState: LookupState;
}

export interface TracerouteSummary {
  target: string;
  startedAt: number;
  completedAt?: number | null;
  hopCount: number;
  protocolsTried: TracerouteProtocol[];
  error?: string | null;
  notices: string[];
}

export interface TracerouteRun {
  request: TracerouteRequest;
  summary: TracerouteSummary;
  hops: HopResolution[];
}

export interface TracerouteExecutionResult {
  runId: string;
  run: TracerouteRun;
}

export interface TracerouteProgressEvent {
  runId: string;
  hop?: HopResolution;
  completed: boolean;
  summary?: TracerouteSummary;
  hops?: HopResolution[];
  error?: string;
}

export interface RecentRun {
  id: string;
  startedAt: number;
  target: string;
  protocol: TracerouteProtocol;
}

export type GeoDatabaseStatus = "loaded" | "missing" | "error";

export interface GeoDatabaseMeta {
  cityDbPath?: string;
  asnDbPath?: string;
  updatedAt?: number;
  cityDbStatus: GeoDatabaseStatus;
  asnDbStatus: GeoDatabaseStatus;
  statusMessage?: string;
}

export interface SnapshotExportOptions {
  format: "png" | "gif";
  outputPath?: string;
}

export interface SnapshotExportResult {
  success: boolean;
  path?: string;
  error?: string;
}

export interface TeamCymruSettings {
  enabled: boolean;
}

export interface RdapSettings {
  enabled: boolean;
  baseUrl?: string;
}

export interface RipeStatSettings {
  enabled: boolean;
  sourceApp: string;
}

export interface PeeringDbSettings {
  enabled: boolean;
  apiKey?: string;
}

/**
 * Placing hops at internet exchanges. Separate from `peeringDb`: it downloads
 * PeeringDB's public exchange list and sends nothing about the route. On by
 * default, also for settings saved before it existed.
 */
export interface IxMatchingSettings {
  enabled: boolean;
}

/** Mirrors `DEFAULT_RDAP_BASE_URL` in src-tauri/src/commands/persistence.rs. */
export const DEFAULT_RDAP_BASE_URL = "https://rdap.org/ip";

export interface IntegrationSettings {
  teamCymru: TeamCymruSettings;
  rdap: RdapSettings;
  ripeStat: RipeStatSettings;
  peeringDb: PeeringDbSettings;
  ixMatching: IxMatchingSettings;
}

export type ThemeName = "dark" | "light";

/**
 * Theme, globe layers and collapsed panels (`preferences.ui`). Mirrors
 * `UiPreferences` in src-tauri/src/commands/persistence.rs.
 */
export interface UiPreferences {
  theme: ThemeName;
  /** Layer id → shown. A missing id uses the layer's default. */
  layers: Record<string, boolean>;
  /** Panel id → collapsed. A missing id uses the panel's default. */
  collapsed: Record<string, boolean>;
  /** Layer id → the user accepted the layer's notice (licence, host). */
  consents: Record<string, boolean>;
}

/**
 * The online NASA GIBS imagery layer. Mirrors `ONLINE_IMAGERY_LAYER` in
 * persistence.rs: while it is off, the tile cache downloads nothing.
 */
export const ONLINE_IMAGERY_LAYER_ID = "online-imagery";

/**
 * The opt-in submarine cable layer; also the id of its notice in
 * `UiPreferences.consents`. Mirrors `SUBMARINE_CABLES_LAYER` in
 * persistence.rs: the backend downloads the cable map only while this layer
 * is on and its notice is accepted.
 */
export const SUBMARINE_CABLES_LAYER_ID = "submarine-cables";

export interface AppInfo {
  version: string;
  /** False while tauri.conf.json carries the updater public key placeholder. */
  updaterConfigured: boolean;
}

/** The disk cache of detailed globe tiles (`$APPCACHE/tiles`). */
export interface TileCacheInfo {
  sizeBytes: number;
  tileCount: number;
  capBytes: number;
}

export interface GeoDbDownloadProgress {
  stage: "downloading" | "extracting" | "complete" | "error";
  edition: string;
  percent?: number;
  error?: string;
}

export const IPC_CHANNELS = {
  TRACEROUTE_RUN: "vistracer:traceroute:run",
  TRACEROUTE_CANCEL: "vistracer:traceroute:cancel",
  TRACEROUTE_PROGRESS: "vistracer:traceroute:progress",
  GEO_DB_META: "vistracer:geo:meta",
  GEO_DB_UPDATE_PATHS: "vistracer:geo:update-paths",
  GEO_DB_SELECT_FILE: "vistracer:geo:select-file",
  GEO_DB_DOWNLOAD: "vistracer:geo:download",
  GEO_DB_DOWNLOAD_PROGRESS: "vistracer:geo:download-progress",
  RECENT_RUNS: "vistracer:runs:list",
  SNAPSHOT_EXPORT: "vistracer:snapshot:export",
  SETTINGS_GET: "vistracer:settings:get",
  SETTINGS_SET: "vistracer:settings:set",
  TELEMETRY_EVENT: "vistracer:telemetry:event"
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
