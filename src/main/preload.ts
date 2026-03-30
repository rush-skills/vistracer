import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";

// Inline IPC channel constants to avoid module loading issues in sandbox
const IPC_CHANNELS = {
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

// Type definitions inline — keep in sync with src/common/ipc.ts and src/common/bridge.ts
interface TracerouteExecutionResult {
  runId: string;
  run: Record<string, unknown>;
}

interface TracerouteProgressEvent {
  runId: string;
  hop?: Record<string, unknown>;
  completed: boolean;
  summary?: Record<string, unknown>;
  hops?: Record<string, unknown>[];
  error?: string;
}

interface GeoDbDownloadProgress {
  stage: "downloading" | "extracting" | "complete" | "error";
  edition: string;
  percent?: number;
  error?: string;
}

interface RendererApi {
  runTraceroute: (request: Record<string, unknown>) => Promise<TracerouteExecutionResult>;
  cancelTraceroute: (runId: string) => Promise<void>;
  getRecentRuns: () => Promise<Record<string, unknown>[]>;
  getGeoDatabaseMeta: () => Promise<Record<string, unknown>>;
  updateGeoDatabasePaths: (cityPath?: string, asnPath?: string) => Promise<void>;
  selectGeoDbFile: () => Promise<string | undefined>;
  downloadGeoDatabases: (licenseKey: string) => Promise<{ cityPath: string; asnPath: string }>;
  subscribeGeoDbDownloadProgress: (listener: (progress: GeoDbDownloadProgress) => void) => () => void;
  exportSnapshot: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getSettings: <T = unknown>(key: string) => Promise<T | undefined>;
  setSettings: <T = unknown>(key: string, value: T) => Promise<void>;
  subscribeTracerouteProgress: (
    listener: (progress: TracerouteProgressEvent) => void
  ) => () => void;
  emitTelemetry: (eventName: string, payload?: Record<string, unknown>) => void;
}

const rendererApi: RendererApi = {
  runTraceroute: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRACEROUTE_RUN, request) as Promise<TracerouteExecutionResult>,
  cancelTraceroute: (runId) => ipcRenderer.invoke(IPC_CHANNELS.TRACEROUTE_CANCEL, runId),
  getRecentRuns: () => ipcRenderer.invoke(IPC_CHANNELS.RECENT_RUNS),
  getGeoDatabaseMeta: () => ipcRenderer.invoke(IPC_CHANNELS.GEO_DB_META),
  updateGeoDatabasePaths: (cityPath, asnPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.GEO_DB_UPDATE_PATHS, { cityPath, asnPath }),
  selectGeoDbFile: () => ipcRenderer.invoke(IPC_CHANNELS.GEO_DB_SELECT_FILE),
  downloadGeoDatabases: (licenseKey) =>
    ipcRenderer.invoke(IPC_CHANNELS.GEO_DB_DOWNLOAD, { licenseKey }),
  subscribeGeoDbDownloadProgress: (listener) => {
    const channel = IPC_CHANNELS.GEO_DB_DOWNLOAD_PROGRESS;
    const handler = (_event: IpcRendererEvent, data: GeoDbDownloadProgress) => listener(data);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
  exportSnapshot: (options) => ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_EXPORT, options),
  getSettings: (key) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET, key),
  setSettings: (key, value) => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, { key, value }),
  subscribeTracerouteProgress: (listener) => {
    const channel = IPC_CHANNELS.TRACEROUTE_PROGRESS;
    const handler = (_event: IpcRendererEvent, data: TracerouteProgressEvent) => listener(data);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  },
  emitTelemetry: (eventName, payload) => {
    ipcRenderer.send(IPC_CHANNELS.TELEMETRY_EVENT, { eventName, payload });
  }
};

contextBridge.exposeInMainWorld("visTracer", rendererApi);
