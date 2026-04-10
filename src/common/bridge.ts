import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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

/**
 * Creates the RendererApi backed by Tauri IPC invoke/listen.
 */
function createTauriApi(): RendererApi {
  return {
    runTraceroute: (request) => invoke<TracerouteExecutionResult>("traceroute_run", { request }),

    cancelTraceroute: (runId) => invoke<void>("traceroute_cancel", { runId }),

    getRecentRuns: () => invoke<RecentRun[]>("get_recent_runs"),

    getGeoDatabaseMeta: () => invoke<GeoDatabaseMeta>("get_geo_database_meta"),

    updateGeoDatabasePaths: (cityPath, asnPath) =>
      invoke<void>("update_geo_database_paths", { cityPath, asnPath }),

    selectGeoDbFile: () => invoke<string | null>("select_geo_db_file").then((v) => v ?? undefined),

    downloadGeoDatabases: (licenseKey) =>
      invoke<{ cityPath: string; asnPath: string }>("download_geo_db", { licenseKey }),

    subscribeGeoDbDownloadProgress: (listener) => {
      let unlisten: UnlistenFn | null = null;
      listen<GeoDbDownloadProgress>("vistracer:geo:download-progress", (event) => {
        listener(event.payload);
      }).then((fn_) => {
        unlisten = fn_;
      });
      return () => {
        unlisten?.();
      };
    },

    exportSnapshot: () => {
      // Snapshot export uses renderer-side canvas capture
      return Promise.resolve({
        success: false,
        error: "Snapshot export is handled client-side in Tauri builds."
      });
    },

    getSettings: <T = unknown>(key: string) =>
      invoke<T | null>("get_settings", { key }).then((v) => v ?? undefined) as Promise<T | undefined>,

    setSettings: <T = unknown>(key: string, value: T) =>
      invoke<void>("set_settings", { key, value }),

    subscribeTracerouteProgress: (listener) => {
      let unlisten: UnlistenFn | null = null;
      listen<TracerouteProgressEvent>("vistracer:traceroute:progress", (event) => {
        listener(event.payload);
      }).then((fn_) => {
        unlisten = fn_;
      });
      return () => {
        unlisten?.();
      };
    },

    emitTelemetry: (eventName, payload) => {
      invoke("emit_telemetry", { eventName, payload }).catch(() => {
        // Fire and forget
      });
    }
  };
}

// Initialize and expose the API on window.visTracer
const api = createTauriApi();
(window as VisTracerWindow).visTracer = api;

export default api;
