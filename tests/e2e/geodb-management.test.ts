/**
 * E2E tests for GeoIP database management flow.
 * Tests the download, configure, and status check lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri APIs
const mockInvoke = vi.fn();
const eventListeners = new Map<string, Array<(event: { payload: unknown }) => void>>();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (event: string, callback: (event: { payload: unknown }) => void) => {
      if (!eventListeners.has(event)) {
        eventListeners.set(event, []);
      }
      eventListeners.get(event)!.push(callback);
      return Promise.resolve(() => {
        const listeners = eventListeners.get(event);
        if (listeners) {
          const idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        }
      });
    }
  ),
}));

function emitEvent(event: string, payload: unknown) {
  const listeners = eventListeners.get(event) ?? [];
  for (const listener of listeners) {
    listener({ payload });
  }
}

import type { RendererApi } from "../../src/common/bridge";
import type { GeoDbDownloadProgress } from "../../src/common/ipc";

describe("GeoIP Database Management", () => {
  let api: RendererApi;

  beforeEach(async () => {
    mockInvoke.mockReset();
    eventListeners.clear();
    vi.resetModules();

    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: (...args: unknown[]) => mockInvoke(...args),
    }));
    vi.doMock("@tauri-apps/api/event", () => ({
      listen: vi.fn(
        (event: string, callback: (event: { payload: unknown }) => void) => {
          if (!eventListeners.has(event)) {
            eventListeners.set(event, []);
          }
          eventListeners.get(event)!.push(callback);
          return Promise.resolve(() => {
            const listeners = eventListeners.get(event);
            if (listeners) {
              const idx = listeners.indexOf(callback);
              if (idx >= 0) listeners.splice(idx, 1);
            }
          });
        }
      ),
    }));

    const bridge = await import("../../src/common/bridge");
    api = (window as { visTracer: RendererApi }).visTracer ?? bridge.default;
  });

  describe("Database download flow", () => {
    it("downloads databases with progress events", async () => {
      const progressEvents: GeoDbDownloadProgress[] = [];

      // Subscribe to progress
      const unsubscribe = api.subscribeGeoDbDownloadProgress((progress) => {
        progressEvents.push(progress);
      });

      // Wait for listener to be registered
      await vi.waitFor(() => {
        expect(eventListeners.has("vistracer:geo:download-progress")).toBe(true);
      });

      // Mock the download command
      mockInvoke.mockResolvedValueOnce({
        cityPath: "/data/db/GeoLite2-City.mmdb",
        asnPath: "/data/db/GeoLite2-ASN.mmdb",
      });

      // Start download (async)
      const downloadPromise = api.downloadGeoDatabases("test-license-key");

      // Simulate progress events from the backend
      emitEvent("vistracer:geo:download-progress", {
        stage: "downloading",
        edition: "GeoLite2-City",
        percent: 0,
      });

      emitEvent("vistracer:geo:download-progress", {
        stage: "downloading",
        edition: "GeoLite2-City",
        percent: 50,
      });

      emitEvent("vistracer:geo:download-progress", {
        stage: "downloading",
        edition: "GeoLite2-City",
        percent: 100,
      });

      emitEvent("vistracer:geo:download-progress", {
        stage: "extracting",
        edition: "GeoLite2-City",
      });

      emitEvent("vistracer:geo:download-progress", {
        stage: "complete",
        edition: "GeoLite2-City",
        percent: 100,
      });

      emitEvent("vistracer:geo:download-progress", {
        stage: "downloading",
        edition: "GeoLite2-ASN",
        percent: 0,
      });

      emitEvent("vistracer:geo:download-progress", {
        stage: "complete",
        edition: "GeoLite2-ASN",
        percent: 100,
      });

      const result = await downloadPromise;

      expect(result.cityPath).toBe("/data/db/GeoLite2-City.mmdb");
      expect(result.asnPath).toBe("/data/db/GeoLite2-ASN.mmdb");
      expect(progressEvents.length).toBeGreaterThanOrEqual(5);
      expect(progressEvents[0].stage).toBe("downloading");
      expect(progressEvents[0].edition).toBe("GeoLite2-City");

      unsubscribe();
    });

    it("handles download errors", async () => {
      mockInvoke.mockRejectedValueOnce(
        new Error("MaxMind download failed (401): Unauthorized")
      );

      await expect(api.downloadGeoDatabases("invalid-key")).rejects.toThrow(
        "401"
      );
    });
  });

  describe("File browser integration", () => {
    it("selects a file via the system dialog", async () => {
      mockInvoke.mockResolvedValueOnce("/home/user/GeoLite2-City.mmdb");

      const path = await api.selectGeoDbFile();

      expect(path).toBe("/home/user/GeoLite2-City.mmdb");
      expect(mockInvoke).toHaveBeenCalledWith("select_geo_db_file");
    });

    it("handles dialog cancellation", async () => {
      mockInvoke.mockResolvedValueOnce(null);

      const path = await api.selectGeoDbFile();

      expect(path).toBeUndefined();
    });
  });

  describe("Database status lifecycle", () => {
    it("reports missing databases initially", async () => {
      mockInvoke.mockResolvedValueOnce({
        cityDbPath: null,
        asnDbPath: null,
        updatedAt: null,
        cityDbStatus: "missing",
        asnDbStatus: "missing",
        statusMessage: "GeoIP databases not found.",
      });

      const meta = await api.getGeoDatabaseMeta();

      expect(meta.cityDbStatus).toBe("missing");
      expect(meta.asnDbStatus).toBe("missing");
    });

    it("reports loaded databases after configuration", async () => {
      // Step 1: Update paths
      mockInvoke.mockResolvedValueOnce(undefined); // update paths call
      await api.updateGeoDatabasePaths("/db/city.mmdb", "/db/asn.mmdb");

      // Step 2: Check status
      mockInvoke.mockResolvedValueOnce({
        cityDbPath: "/db/city.mmdb",
        asnDbPath: "/db/asn.mmdb",
        updatedAt: Date.now(),
        cityDbStatus: "loaded",
        asnDbStatus: "loaded",
        statusMessage: null,
      });

      const meta = await api.getGeoDatabaseMeta();

      expect(meta.cityDbStatus).toBe("loaded");
      expect(meta.asnDbStatus).toBe("loaded");
      expect(meta.statusMessage).toBeNull();
    });

    it("reports error when database file is invalid", async () => {
      mockInvoke.mockResolvedValueOnce({
        cityDbPath: "/nonexistent/city.mmdb",
        asnDbPath: null,
        updatedAt: null,
        cityDbStatus: "error",
        asnDbStatus: "missing",
        statusMessage: "City database not found.",
      });

      const meta = await api.getGeoDatabaseMeta();

      expect(meta.cityDbStatus).toBe("error");
      expect(meta.asnDbStatus).toBe("missing");
    });
  });
});
