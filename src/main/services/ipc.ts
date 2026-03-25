import { app, BrowserWindow, ipcMain, IpcMainInvokeEvent } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import {
  GeoDatabaseMeta,
  IPC_CHANNELS,
  RecentRun,
  SnapshotExportOptions,
  SnapshotExportResult,
  TracerouteExecutionResult,
  TracerouteProgressEvent,
  TracerouteRequest
} from "@common/ipc";
import { runTraceroute, cancelTraceroute, TracerouteError } from "./traceroute";
import {
  addCompletedRun,
  getGeoDatabaseMeta,
  getRecentRuns,
  getSettingsStore
} from "./persistence";
import { getLogger } from "./logger";

const log = getLogger();

function forwardProgress(
  event: Electron.IpcMainInvokeEvent,
  callback: (progress: TracerouteProgressEvent) => void
) {
  return (progress: TracerouteProgressEvent) => {
    callback(progress);
    event.sender.send(IPC_CHANNELS.TRACEROUTE_PROGRESS, progress);
  };
}

async function handleSnapshotExport(
  event: IpcMainInvokeEvent,
  options: SnapshotExportOptions
): Promise<SnapshotExportResult> {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) {
    return { success: false, error: "No active window available for export." };
  }

  const format = options.format ?? "png";
  if (format !== "png") {
    return { success: false, error: `Export format ${format} is not supported yet.` };
  }

  try {
    const image = await window.webContents.capturePage();
    const buffer = image.toPNG();
    const snapshotsDir = path.join(app.getPath("userData"), "snapshots");
    await fs.mkdir(snapshotsDir, { recursive: true });

    const fileName =
      options.outputPath ??
      path.join(
        snapshotsDir,
        `vistracer-${new Date().toISOString().replace(/[:.]/g, "-")}.${format}`
      );

    await fs.writeFile(fileName, buffer);
    return { success: true, path: fileName };
  } catch (error) {
    log.error("Snapshot export failed", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown snapshot export error."
    };
  }
}

export function setupIpcHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.TRACEROUTE_RUN,
    async (event, request: TracerouteRequest): Promise<TracerouteExecutionResult> => {
      let runId: string | null = null;
      let completed = false;

      const forward = forwardProgress(event, (progress) => {
        runId = progress.runId;
        if (progress.completed) {
          completed = true;
        }
      });

      try {
        const result = await runTraceroute(request, forward);
        addCompletedRun(result.run);
        return result;
      } catch (error) {
        const isCancelled = error instanceof TracerouteError && error.code === "cancelled";
        const message =
          error instanceof TracerouteError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Traceroute failed unexpectedly.";

        if (runId && !completed) {
          const failedEvent: TracerouteProgressEvent = {
            runId,
            completed: true,
            error: message,
            summary: {
              target: request.target,
              startedAt: Date.now(),
              hopCount: 0,
              protocolsTried: [request.protocol],
              error: message
            },
            hops: []
          };
          event.sender.send(IPC_CHANNELS.TRACEROUTE_PROGRESS, failedEvent);
        }

        // Log as warning if cancelled, error if actual failure
        if (isCancelled) {
          log.info("Traceroute cancelled by user", { runId });
        } else {
          log.error("Traceroute execution failed", error);
        }

        throw error;
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.TRACEROUTE_CANCEL, async (_event, runId: string) => {
    cancelTraceroute(runId);
  });

  ipcMain.handle(IPC_CHANNELS.RECENT_RUNS, async (): Promise<RecentRun[]> => {
    return getRecentRuns();
  });

  ipcMain.handle(IPC_CHANNELS.GEO_DB_META, async (): Promise<GeoDatabaseMeta> => {
    return getGeoDatabaseMeta();
  });

  ipcMain.handle(
    IPC_CHANNELS.SNAPSHOT_EXPORT,
    async (event, options: SnapshotExportOptions): Promise<SnapshotExportResult> => {
      return handleSnapshotExport(event, options);
    }
  );

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, async (_event, key: string) => {
    return getSettingsStore().get(key as never);
  });

  ipcMain.handle(
    IPC_CHANNELS.SETTINGS_SET,
    async (_event, payload: { key: string; value: unknown }) => {
      const store = getSettingsStore();
      store.set(payload.key as never, payload.value as never);
    }
  );

  ipcMain.on(IPC_CHANNELS.TELEMETRY_EVENT, (_event, payload) => {
    log.debug("Telemetry event", payload);
  });
}
