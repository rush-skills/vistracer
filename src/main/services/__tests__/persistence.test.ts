import { describe, expect, it, vi, beforeEach } from "vitest";

const stores = vi.hoisted(() => new Map<string, Map<string, unknown>>());

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp", getAppPath: () => "/tmp", isPackaged: false }
}));

vi.mock("electron-store", () => {
  return {
    default: class {
      #data: Map<string, unknown>;
      constructor(opts?: { name?: string; defaults?: Record<string, unknown> }) {
        const name = opts?.name ?? "default";
        if (!stores.has(name)) {
          stores.set(name, new Map());
        }
        this.#data = stores.get(name)!;
        // Apply defaults
        if (opts?.defaults) {
          for (const [key, value] of Object.entries(opts.defaults)) {
            if (!this.#data.has(key)) {
              this.#data.set(key, value);
            }
          }
        }
      }
      get(key: string, def?: unknown) {
        // Support dotted paths
        const parts = key.split(".");
        let current: unknown = this.#data.get(parts[0]);
        for (let i = 1; i < parts.length; i++) {
          if (current == null || typeof current !== "object") return def;
          current = (current as Record<string, unknown>)[parts[i]];
        }
        return current ?? def;
      }
      set(keyOrObj: string | Record<string, unknown>, val?: unknown) {
        if (typeof keyOrObj === "object") {
          for (const [k, v] of Object.entries(keyOrObj)) {
            this.#data.set(k, v);
          }
          return;
        }
        // Support dotted paths for set
        const parts = keyOrObj.split(".");
        if (parts.length === 1) {
          this.#data.set(keyOrObj, val);
          return;
        }
        // For dotted set, get root object and modify nested
        let root = this.#data.get(parts[0]);
        if (root == null || typeof root !== "object") {
          root = {};
          this.#data.set(parts[0], root);
        }
        let current = root as Record<string, unknown>;
        for (let i = 1; i < parts.length - 1; i++) {
          if (current[parts[i]] == null || typeof current[parts[i]] !== "object") {
            current[parts[i]] = {};
          }
          current = current[parts[i]] as Record<string, unknown>;
        }
        current[parts[parts.length - 1]] = val;
      }
      delete(key: string) {
        const parts = key.split(".");
        if (parts.length === 1) {
          this.#data.delete(key);
          return;
        }
        const root = this.#data.get(parts[0]);
        if (root == null || typeof root !== "object") return;
        let current = root as Record<string, unknown>;
        for (let i = 1; i < parts.length - 1; i++) {
          if (current[parts[i]] == null || typeof current[parts[i]] !== "object") return;
          current = current[parts[i]] as Record<string, unknown>;
        }
        delete current[parts[parts.length - 1]];
      }
    }
  };
});

import { getCachedDns, setCachedDns, getCachedGeo, setCachedGeo } from "../persistence";

describe("DNS cache", () => {
  beforeEach(() => {
    stores.clear();
  });

  it("round-trips a cached DNS entry", () => {
    setCachedDns("1.2.3.4", "router.example.com");
    expect(getCachedDns("1.2.3.4")).toBe("router.example.com");
  });

  it("returns undefined for expired entries", () => {
    setCachedDns("1.2.3.4", "router.example.com");
    // Fast-forward time past the TTL (default 24h)
    const realNow = Date.now;
    Date.now = () => realNow() + 1000 * 60 * 60 * 25; // 25 hours later
    try {
      expect(getCachedDns("1.2.3.4")).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });

  it("deletes expired entries from store", () => {
    setCachedDns("1.2.3.4", "router.example.com");
    const realNow = Date.now;
    Date.now = () => realNow() + 1000 * 60 * 60 * 25;
    try {
      getCachedDns("1.2.3.4"); // Should trigger delete
      // Reset time and verify it's really gone
    } finally {
      Date.now = realNow;
    }
    // Even with normal time, the entry should have been deleted
    expect(getCachedDns("1.2.3.4")).toBeUndefined();
  });
});

describe("Geo cache", () => {
  beforeEach(() => {
    stores.clear();
  });

  it("strips provider entries with error status before caching", () => {
    setCachedGeo("8.8.8.8", {
      latitude: 37.386,
      longitude: -122.0838,
      providers: [
        { provider: "maxmind", status: "success" },
        { provider: "rdap", status: "error", message: "timeout" },
        { provider: "ripe-stat", status: "success" }
      ]
    });
    const cached = getCachedGeo("8.8.8.8");
    expect(cached).toBeDefined();
    expect(cached!.providers).toHaveLength(2);
    expect(cached!.providers!.every(p => p.status !== "error")).toBe(true);
  });

  it("returns undefined for expired geo entries", () => {
    setCachedGeo("8.8.8.8", { latitude: 37, longitude: -122 });
    const realNow = Date.now;
    Date.now = () => realNow() + 1000 * 60 * 60 * 24 * 8; // 8 days (TTL is 7d)
    try {
      expect(getCachedGeo("8.8.8.8")).toBeUndefined();
    } finally {
      Date.now = realNow;
    }
  });
});
