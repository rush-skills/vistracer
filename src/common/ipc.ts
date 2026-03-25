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
  confidence?: number;
}

export interface AsnDetails {
  asn?: number;
  name?: string;
  network?: string;
  country?: string;
  registry?: string;
}

export type ProviderId = "maxmind" | "team-cymru" | "rdap" | "ripe-stat" | "peeringdb";

export interface ProviderStatus {
  provider: ProviderId;
  status: "success" | "error" | "skipped";
  message?: string;
  details?: Record<string, unknown>;
}

export interface PeeringDbDetails {
  id?: number;
  name?: string;
  aka?: string;
  website?: string;
  city?: string;
  country?: string;
  ixCount?: number;
}

export interface HopLatencyStats {
  minRttMs: number | null;
  maxRttMs: number | null;
  avgRttMs: number | null;
  jitterMs: number | null;
}

export interface HopResolution {
  hopIndex: number;
  ipAddress: string | null;
  hostName?: string;
  lossPercent: number | null;
  latency: HopLatencyStats;
  geo?: GeoDetails;
  asn?: AsnDetails;
  isPrivate: boolean;
  isAnycastSuspected: boolean;
  rawLine: string;
  providers?: ProviderStatus[];
  peeringDb?: PeeringDbDetails;
}

export interface TracerouteSummary {
  target: string;
  startedAt: number;
  completedAt?: number;
  hopCount: number;
  protocolsTried: TracerouteProtocol[];
  error?: string;
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

export interface IntegrationSettings {
  teamCymru: TeamCymruSettings;
  rdap: RdapSettings;
  ripeStat: RipeStatSettings;
  peeringDb: PeeringDbSettings;
}

export const IPC_CHANNELS = {
  TRACEROUTE_RUN: "vistracer:traceroute:run",
  TRACEROUTE_CANCEL: "vistracer:traceroute:cancel",
  TRACEROUTE_PROGRESS: "vistracer:traceroute:progress",
  GEO_DB_META: "vistracer:geo:meta",
  GEO_DB_UPDATE_PATHS: "vistracer:geo:update-paths",
  GEO_DB_SELECT_FILE: "vistracer:geo:select-file",
  RECENT_RUNS: "vistracer:runs:list",
  SNAPSHOT_EXPORT: "vistracer:snapshot:export",
  SETTINGS_GET: "vistracer:settings:get",
  SETTINGS_SET: "vistracer:settings:set",
  TELEMETRY_EVENT: "vistracer:telemetry:event"
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
