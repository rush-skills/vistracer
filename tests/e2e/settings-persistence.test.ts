/**
 * E2E tests for settings persistence via the Tauri bridge.
 * Tests getSettings/setSettings round-trip behavior.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri APIs
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import type { RendererApi } from "../../src/common/bridge";

describe("Settings Persistence", () => {
  let api: RendererApi;

  beforeEach(async () => {
    mockInvoke.mockReset();
    vi.resetModules();

    vi.doMock("@tauri-apps/api/core", () => ({
      invoke: (...args: unknown[]) => mockInvoke(...args),
    }));
    vi.doMock("@tauri-apps/api/event", () => ({
      listen: vi.fn(() => Promise.resolve(() => {})),
    }));

    const bridge = await import("../../src/common/bridge");
    api = (window as { visTracer: RendererApi }).visTracer ?? bridge.default;
  });

  describe("Integration settings round-trip", () => {
    it("reads default integration settings", async () => {
      const defaults = {
        teamCymru: { enabled: true },
        rdap: { enabled: true, baseUrl: "https://rdap.org/ip" },
        ripeStat: { enabled: true, sourceApp: "VisTracer" },
        peeringDb: { enabled: false },
      };
      mockInvoke.mockResolvedValueOnce(defaults);

      const result = await api.getSettings("integrations");

      expect(result).toEqual(defaults);
      expect(mockInvoke).toHaveBeenCalledWith("get_settings", { key: "integrations" });
    });

    it("saves updated integration settings", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      const updated = {
        teamCymru: { enabled: false },
        rdap: { enabled: true, baseUrl: "https://custom-rdap.example.com/ip" },
        ripeStat: { enabled: false, sourceApp: "VisTracer" },
        peeringDb: { enabled: true, apiKey: "test-key-123" },
      };

      await api.setSettings("integrations", updated);

      expect(mockInvoke).toHaveBeenCalledWith("set_settings", {
        key: "integrations",
        value: updated,
      });
    });

    it("toggling a single provider preserves others", async () => {
      const original = {
        teamCymru: { enabled: true },
        rdap: { enabled: true, baseUrl: "https://rdap.org/ip" },
        ripeStat: { enabled: true, sourceApp: "VisTracer" },
        peeringDb: { enabled: false },
      };

      // Read
      mockInvoke.mockResolvedValueOnce(original);
      const settings = await api.getSettings("integrations");

      // Modify one provider
      const modified = {
        ...settings,
        peeringDb: { enabled: true, apiKey: "my-key" },
      };

      // Write
      mockInvoke.mockResolvedValueOnce(undefined);
      await api.setSettings("integrations", modified);

      // Verify the write call included all providers
      expect(mockInvoke).toHaveBeenCalledWith("set_settings", {
        key: "integrations",
        value: expect.objectContaining({
          teamCymru: { enabled: true },
          peeringDb: { enabled: true, apiKey: "my-key" },
        }),
      });
    });
  });

  describe("Onboarding preferences", () => {
    it("reads onboarding preferences", async () => {
      const prefs = { skipOnLaunch: true, lastCompletedAt: 1700000000000 };
      mockInvoke.mockResolvedValueOnce(prefs);

      const result = await api.getSettings("preferences.onboarding");

      expect(result).toEqual(prefs);
    });

    it("saves skip-on-launch preference", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await api.setSettings("preferences.onboarding", {
        skipOnLaunch: true,
        lastDismissedAt: Date.now(),
      });

      expect(mockInvoke).toHaveBeenCalledWith("set_settings", {
        key: "preferences.onboarding",
        value: expect.objectContaining({ skipOnLaunch: true }),
      });
    });
  });

  describe("GeoIP database paths", () => {
    it("reads geo database metadata", async () => {
      const meta = {
        cityDbPath: "/data/GeoLite2-City.mmdb",
        asnDbPath: "/data/GeoLite2-ASN.mmdb",
        updatedAt: 1700000000000,
        cityDbStatus: "loaded",
        asnDbStatus: "loaded",
        statusMessage: null,
      };
      mockInvoke.mockResolvedValueOnce(meta);

      const result = await api.getGeoDatabaseMeta();

      expect(result.cityDbStatus).toBe("loaded");
      expect(result.asnDbStatus).toBe("loaded");
    });

    it("updates geo database paths", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);

      await api.updateGeoDatabasePaths("/new/city.mmdb", "/new/asn.mmdb");

      expect(mockInvoke).toHaveBeenCalledWith("update_geo_database_paths", {
        cityPath: "/new/city.mmdb",
        asnPath: "/new/asn.mmdb",
      });
    });

    it("handles partial database configuration", async () => {
      const meta = {
        cityDbPath: "/data/GeoLite2-City.mmdb",
        asnDbPath: null,
        updatedAt: 1700000000000,
        cityDbStatus: "loaded",
        asnDbStatus: "missing",
        statusMessage: "ASN database not found.",
      };
      mockInvoke.mockResolvedValueOnce(meta);

      const result = await api.getGeoDatabaseMeta();

      expect(result.cityDbStatus).toBe("loaded");
      expect(result.asnDbStatus).toBe("missing");
      expect(result.statusMessage).toContain("ASN database");
    });
  });

  describe("Recent runs", () => {
    it("retrieves recent run history", async () => {
      const runs = [
        { id: "r1", startedAt: 3000, target: "8.8.8.8", protocol: "ICMP" },
        { id: "r2", startedAt: 2000, target: "1.1.1.1", protocol: "UDP" },
        { id: "r3", startedAt: 1000, target: "example.com", protocol: "TCP" },
      ];
      mockInvoke.mockResolvedValueOnce(runs);

      const result = await api.getRecentRuns();

      expect(result).toHaveLength(3);
      expect(result[0].target).toBe("8.8.8.8");
      expect(result[2].protocol).toBe("TCP");
    });

    it("handles empty run history", async () => {
      mockInvoke.mockResolvedValueOnce([]);

      const result = await api.getRecentRuns();

      expect(result).toEqual([]);
    });
  });
});
