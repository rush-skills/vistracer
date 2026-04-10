/**
 * E2E tests for the Tauri bridge layer.
 * Tests that the bridge correctly translates between the RendererApi interface
 * and Tauri's invoke/listen calls.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @tauri-apps/api/core
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock @tauri-apps/api/event
const mockListeners = new Map<string, (event: { payload: unknown }) => void>();
const mockUnlistenFns = new Map<string, () => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, callback: (event: { payload: unknown }) => void) => {
    mockListeners.set(event, callback);
    const unlisten = () => {
      mockListeners.delete(event);
    };
    mockUnlistenFns.set(event, unlisten);
    return Promise.resolve(unlisten);
  }),
}));

// Import bridge after mocks are set up
import type { RendererApi } from "../../src/common/bridge";

describe("Tauri Bridge Layer", () => {
  let api: RendererApi;

  beforeEach(async () => {
    mockInvoke.mockReset();
    mockListeners.clear();
    mockUnlistenFns.clear();

    // Clear module cache and re-import to get fresh bridge
    vi.resetModules();

    // Re-mock after reset
    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: (...args: unknown[]) => mockInvoke(...args),
    }));
    vi.doMock("@tauri-apps/api/event", () => ({
      listen: vi.fn((event: string, callback: (event: { payload: unknown }) => void) => {
        mockListeners.set(event, callback);
        const unlisten = () => {
          mockListeners.delete(event);
        };
        mockUnlistenFns.set(event, unlisten);
        return Promise.resolve(unlisten);
      }),
    }));

    const bridge = await import("../../src/common/bridge");
    api = (window as { visTracer: RendererApi }).visTracer ?? bridge.default;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runTraceroute", () => {
    it("invokes traceroute_run with the correct request payload", async () => {
      const expectedResult = {
        runId: "test-uuid",
        run: {
          request: {
            target: "8.8.8.8",
            protocol: "ICMP",
            maxHops: 30,
            timeoutMs: 4000,
            packetCount: 3,
            forceFresh: false,
          },
          summary: {
            target: "8.8.8.8",
            startedAt: Date.now(),
            hopCount: 2,
            protocolsTried: ["ICMP"],
          },
          hops: [],
        },
      };

      mockInvoke.mockResolvedValueOnce(expectedResult);

      const request = {
        target: "8.8.8.8",
        protocol: "ICMP" as const,
        maxHops: 30,
        timeoutMs: 4000,
        packetCount: 3,
        forceFresh: false,
      };

      const result = await api.runTraceroute(request);

      expect(mockInvoke).toHaveBeenCalledWith("traceroute_run", { request });
      expect(result.runId).toBe("test-uuid");
    });

    it("propagates errors from the backend", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("traceroute binary not found"));

      await expect(
        api.runTraceroute({
          target: "example.com",
          protocol: "ICMP",
          maxHops: 30,
          timeoutMs: 4000,
          packetCount: 3,
          forceFresh: false,
        })
      ).rejects.toThrow();
    });
  });

  describe("cancelTraceroute", () => {
    it("invokes traceroute_cancel with run ID", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await api.cancelTraceroute("run-123");

      expect(mockInvoke).toHaveBeenCalledWith("traceroute_cancel", { runId: "run-123" });
    });
  });

  describe("getRecentRuns", () => {
    it("returns recent runs from backend", async () => {
      const runs = [
        { id: "r1", startedAt: 1000, target: "8.8.8.8", protocol: "ICMP" },
        { id: "r2", startedAt: 2000, target: "1.1.1.1", protocol: "UDP" },
      ];
      mockInvoke.mockResolvedValueOnce(runs);

      const result = await api.getRecentRuns();

      expect(mockInvoke).toHaveBeenCalledWith("get_recent_runs");
      expect(result).toEqual(runs);
      expect(result).toHaveLength(2);
    });
  });

  describe("getGeoDatabaseMeta", () => {
    it("returns database metadata", async () => {
      const meta = {
        cityDbPath: "/path/to/city.mmdb",
        asnDbPath: "/path/to/asn.mmdb",
        updatedAt: Date.now(),
        cityDbStatus: "loaded",
        asnDbStatus: "loaded",
        statusMessage: null,
      };
      mockInvoke.mockResolvedValueOnce(meta);

      const result = await api.getGeoDatabaseMeta();

      expect(mockInvoke).toHaveBeenCalledWith("get_geo_database_meta");
      expect(result.cityDbStatus).toBe("loaded");
    });
  });

  describe("updateGeoDatabasePaths", () => {
    it("invokes update with both paths", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await api.updateGeoDatabasePaths("/city.mmdb", "/asn.mmdb");

      expect(mockInvoke).toHaveBeenCalledWith("update_geo_database_paths", {
        cityPath: "/city.mmdb",
        asnPath: "/asn.mmdb",
      });
    });

    it("handles undefined paths", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await api.updateGeoDatabasePaths(undefined, undefined);

      expect(mockInvoke).toHaveBeenCalledWith("update_geo_database_paths", {
        cityPath: undefined,
        asnPath: undefined,
      });
    });
  });

  describe("selectGeoDbFile", () => {
    it("returns selected file path", async () => {
      mockInvoke.mockResolvedValueOnce("/path/to/selected.mmdb");

      const result = await api.selectGeoDbFile();

      expect(mockInvoke).toHaveBeenCalledWith("select_geo_db_file");
      expect(result).toBe("/path/to/selected.mmdb");
    });

    it("returns undefined when dialog is cancelled", async () => {
      mockInvoke.mockResolvedValueOnce(null);

      const result = await api.selectGeoDbFile();

      expect(result).toBeUndefined();
    });
  });

  describe("downloadGeoDatabases", () => {
    it("invokes download with license key", async () => {
      const expected = { cityPath: "/db/city.mmdb", asnPath: "/db/asn.mmdb" };
      mockInvoke.mockResolvedValueOnce(expected);

      const result = await api.downloadGeoDatabases("test-license-key");

      expect(mockInvoke).toHaveBeenCalledWith("download_geo_db", {
        licenseKey: "test-license-key",
      });
      expect(result.cityPath).toBe("/db/city.mmdb");
    });
  });

  describe("subscribeTracerouteProgress", () => {
    it("sets up event listener and returns unsubscribe function", async () => {
      const listener = vi.fn();

      const unsubscribe = api.subscribeTracerouteProgress(listener);

      // Simulate an event being emitted
      await vi.waitFor(() => {
        expect(mockListeners.has("vistracer:traceroute:progress")).toBe(true);
      });

      const progressEvent = {
        runId: "run-1",
        hop: {
          hopIndex: 1,
          ipAddress: "10.0.0.1",
          hostName: null,
          lossPercent: 0,
          latency: { minRttMs: 1, maxRttMs: 2, avgRttMs: 1.5, jitterMs: 1 },
          isPrivate: true,
          isAnycastSuspected: false,
          rawLine: "1  10.0.0.1  1.5 ms",
        },
        completed: false,
      };

      // Trigger the listener
      const handler = mockListeners.get("vistracer:traceroute:progress");
      handler?.({ payload: progressEvent });

      expect(listener).toHaveBeenCalledWith(progressEvent);

      // Unsubscribe
      unsubscribe();
    });
  });

  describe("subscribeGeoDbDownloadProgress", () => {
    it("sets up event listener for download progress", async () => {
      const listener = vi.fn();

      api.subscribeGeoDbDownloadProgress(listener);

      await vi.waitFor(() => {
        expect(mockListeners.has("vistracer:geo:download-progress")).toBe(true);
      });

      const progress = {
        stage: "downloading",
        edition: "GeoLite2-City",
        percent: 50,
      };

      const handler = mockListeners.get("vistracer:geo:download-progress");
      handler?.({ payload: progress });

      expect(listener).toHaveBeenCalledWith(progress);
    });
  });

  describe("getSettings", () => {
    it("returns settings value for a key", async () => {
      const settings = {
        teamCymru: { enabled: true },
        rdap: { enabled: true, baseUrl: "https://rdap.org/ip" },
        ripeStat: { enabled: true, sourceApp: "VisTracer" },
        peeringDb: { enabled: false },
      };
      mockInvoke.mockResolvedValueOnce(settings);

      const result = await api.getSettings("integrations");

      expect(mockInvoke).toHaveBeenCalledWith("get_settings", { key: "integrations" });
      expect(result).toEqual(settings);
    });

    it("returns undefined for null values", async () => {
      mockInvoke.mockResolvedValueOnce(null);

      const result = await api.getSettings("nonexistent");

      expect(result).toBeUndefined();
    });
  });

  describe("setSettings", () => {
    it("invokes set_settings with key and value", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      const value = { skipOnLaunch: true };
      await api.setSettings("preferences.onboarding", value);

      expect(mockInvoke).toHaveBeenCalledWith("set_settings", {
        key: "preferences.onboarding",
        value,
      });
    });
  });

  describe("emitTelemetry", () => {
    it("fires telemetry event without waiting", () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      // Should not throw even if fire-and-forget
      api.emitTelemetry("test-event", { key: "value" });

      expect(mockInvoke).toHaveBeenCalledWith("emit_telemetry", {
        eventName: "test-event",
        payload: { key: "value" },
      });
    });
  });

  describe("exportSnapshot", () => {
    it("returns client-side export notice for Tauri", async () => {
      const result = await api.exportSnapshot({ format: "png" });

      // In Tauri, snapshot export is handled client-side
      expect(result.success).toBe(false);
      expect(result.error).toContain("client-side");
    });
  });
});
