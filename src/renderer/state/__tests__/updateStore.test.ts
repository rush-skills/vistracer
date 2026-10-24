import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { UPDATES_DISABLED_REASON, useUpdateStore } from "@renderer/state/updateStore";

const getAppInfo = vi.fn();
Object.defineProperty(window, "visTracer", {
  value: { getAppInfo },
  writable: true
});

const fakeUpdate = (downloadAndInstall = vi.fn().mockResolvedValue(undefined)) =>
  ({ version: "1.1.0", body: "Fixes", downloadAndInstall }) as unknown as Update;

describe("updateStore", () => {
  beforeEach(() => {
    vi.mocked(check).mockReset();
    vi.mocked(relaunch).mockReset();
    getAppInfo.mockReset();
    getAppInfo.mockResolvedValue({ version: "1.0.0", updaterConfigured: true });
    useUpdateStore.setState({ status: { kind: "idle" }, dismissed: false, currentVersion: undefined });
  });

  it("does not contact the update server while the public key is a placeholder", async () => {
    getAppInfo.mockResolvedValue({ version: "1.0.0", updaterConfigured: false });
    await useUpdateStore.getState().check();
    expect(check).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().status).toEqual({ kind: "disabled", reason: UPDATES_DISABLED_REASON });
    expect(useUpdateStore.getState().currentVersion).toBe("1.0.0");
  });

  it("reports an available update and installs it, then relaunches", async () => {
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined);
    vi.mocked(check).mockResolvedValue(fakeUpdate(downloadAndInstall));

    await useUpdateStore.getState().check();
    expect(useUpdateStore.getState().status).toEqual({ kind: "available", version: "1.1.0", notes: "Fixes" });

    await useUpdateStore.getState().install();
    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("reports up to date when the server has nothing newer", async () => {
    vi.mocked(check).mockResolvedValue(null);
    await useUpdateStore.getState().check();
    expect(useUpdateStore.getState().status).toEqual({ kind: "up-to-date" });
  });

  it("fails quietly when offline or when latest.json is missing", async () => {
    vi.mocked(check).mockRejectedValue(new Error("Could not fetch a valid release JSON from the remote"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(useUpdateStore.getState().check()).resolves.toBeUndefined();
    expect(useUpdateStore.getState().status.kind).toBe("error");
    warn.mockRestore();
  });

  it("keeps the app running when a download fails signature checks", async () => {
    const downloadAndInstall = vi.fn().mockRejectedValue("signature verification failed");
    vi.mocked(check).mockResolvedValue(fakeUpdate(downloadAndInstall));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await useUpdateStore.getState().check();
    await useUpdateStore.getState().install();

    expect(relaunch).not.toHaveBeenCalled();
    expect(useUpdateStore.getState().status).toEqual({
      kind: "install-failed",
      version: "1.1.0",
      message: "signature verification failed"
    });
    warn.mockRestore();
  });

  it("ignores a second check while one is running", async () => {
    let finish: (value: null) => void = () => undefined;
    vi.mocked(check).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const first = useUpdateStore.getState().check();
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(1));
    await useUpdateStore.getState().check();
    finish(null);
    await first;
    expect(check).toHaveBeenCalledTimes(1);
  });
});
