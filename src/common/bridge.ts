import type {
  GeoDatabaseMeta,
  GeoDbDownloadProgress,
  RecentRun,
  SnapshotExportOptions,
  SnapshotExportResult,
  TracerouteExecutionResult,
  TracerouteProgressEvent,
  TracerouteRequest
} from "./ipc";

export interface RendererApi {
  runTraceroute: (request: TracerouteRequest) => Promise<TracerouteExecutionResult>;
  cancelTraceroute: (runId: string) => Promise<void>;
  getRecentRuns: () => Promise<RecentRun[]>;
  getGeoDatabaseMeta: () => Promise<GeoDatabaseMeta>;
  updateGeoDatabasePaths: (cityPath?: string, asnPath?: string) => Promise<void>;
  selectGeoDbFile: () => Promise<string | undefined>;
  downloadGeoDatabases: (licenseKey: string) => Promise<{ cityPath: string; asnPath: string }>;
  subscribeGeoDbDownloadProgress: (
    listener: (progress: GeoDbDownloadProgress) => void
  ) => () => void;
  exportSnapshot: (options: SnapshotExportOptions) => Promise<SnapshotExportResult>;
  getSettings: <T = unknown>(key: string) => Promise<T | undefined>;
  setSettings: <T = unknown>(key: string, value: T) => Promise<void>;
  subscribeTracerouteProgress: (
    listener: (progress: TracerouteProgressEvent) => void
  ) => () => void;
  emitTelemetry: (eventName: string, payload?: Record<string, unknown>) => void;
}

export interface VisTracerWindow extends Window {
  visTracer: RendererApi;
}
