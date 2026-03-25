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

export interface GeoDatabaseMeta {
  cityDbPath?: string;
  asnDbPath?: string;
  updatedAt?: number;
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

export const IPC_CHANNELS = {
  TRACEROUTE_RUN: "vistracer:traceroute:run",
  TRACEROUTE_CANCEL: "vistracer:traceroute:cancel",
  TRACEROUTE_PROGRESS: "vistracer:traceroute:progress",
  GEO_DB_META: "vistracer:geo:meta",
  RECENT_RUNS: "vistracer:runs:list",
  SNAPSHOT_EXPORT: "vistracer:snapshot:export",
  SETTINGS_GET: "vistracer:settings:get",
  SETTINGS_SET: "vistracer:settings:set",
  TELEMETRY_EVENT: "vistracer:telemetry:event"
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
