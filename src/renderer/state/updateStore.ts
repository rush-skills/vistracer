import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "disabled"; reason: string }
  | { kind: "up-to-date" }
  | { kind: "available"; version: string; notes?: string }
  | { kind: "installing"; version: string }
  | { kind: "install-failed"; version: string; message: string }
  | { kind: "error"; message: string };

interface UpdateStore {
  currentVersion?: string;
  status: UpdateStatus;
  dismissed: boolean;
  check: () => Promise<void>;
  install: () => Promise<void>;
  dismiss: () => void;
}

const CHECK_TIMEOUT_MS = 15_000;

export const UPDATES_DISABLED_REASON =
  "Automatic updates are off in this build because it has no update signing key.";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown error";

// The Update handle stays outside React state: it wraps a native resource
// and is only needed to install.
let pendingUpdate: Update | null = null;

/**
 * Update checks never throw: an offline machine, a missing latest.json or a
 * build without a signing key only change the status. Signature checks run
 * in the Rust plugin, so an unsigned or tampered download is never installed.
 */
export const useUpdateStore = create<UpdateStore>((set, get) => ({
  status: { kind: "idle" },
  dismissed: false,
  check: async () => {
    if (get().status.kind === "checking" || get().status.kind === "installing") {
      return;
    }
    set({ status: { kind: "checking" } });
    try {
      const info = await window.visTracer.getAppInfo();
      set({ currentVersion: info.version });
      if (!info.updaterConfigured) {
        set({ status: { kind: "disabled", reason: UPDATES_DISABLED_REASON } });
        return;
      }
      const update = await check({ timeout: CHECK_TIMEOUT_MS });
      pendingUpdate = update;
      set({
        status: update
          ? { kind: "available", version: update.version, notes: update.body }
          : { kind: "up-to-date" },
        dismissed: false
      });
    } catch (error) {
      console.warn("Update check failed", error);
      set({ status: { kind: "error", message: `Could not check for updates: ${errorMessage(error)}` } });
    }
  },
  install: async () => {
    const { status } = get();
    if (status.kind !== "available" || !pendingUpdate) {
      return;
    }
    set({ status: { kind: "installing", version: status.version } });
    try {
      await pendingUpdate.downloadAndInstall();
      await relaunch();
    } catch (error) {
      console.warn("Update install failed", error);
      set({
        status: { kind: "install-failed", version: status.version, message: errorMessage(error) }
      });
    }
  },
  dismiss: () => set({ dismissed: true })
}));
