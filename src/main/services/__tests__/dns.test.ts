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
        if (opts?.defaults) {
          for (const [key, value] of Object.entries(opts.defaults)) {
            if (!this.#data.has(key)) {
              this.#data.set(key, value);
            }
          }
        }
      }
      get(key: string, def?: unknown) {
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
        const parts = keyOrObj.split(".");
        if (parts.length === 1) {
          this.#data.set(keyOrObj, val);
          return;
        }
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

const mockReverse = vi.hoisted(() => vi.fn<(ip: string) => Promise<string[]>>());
vi.mock("node:dns", () => ({
  promises: {
    reverse: (...args: unknown[]) => mockReverse(args[0] as string)
  }
}));

import { resolveReverseDns } from "../dns";
import { setCachedDns } from "../persistence";

describe("resolveReverseDns", () => {
  beforeEach(() => {
    stores.clear();
    mockReverse.mockReset();
  });

  it("returns cached value when available (no DNS call)", async () => {
    setCachedDns("1.2.3.4", "cached.example.com");

    const result = await resolveReverseDns("1.2.3.4");

    expect(result).toBe("cached.example.com");
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it("calls dns.reverse on cache miss", async () => {
    mockReverse.mockResolvedValue(["fresh.example.com"]);

    const result = await resolveReverseDns("5.6.7.8");

    expect(result).toBe("fresh.example.com");
    expect(mockReverse).toHaveBeenCalledWith("5.6.7.8");
  });

  it("caches successful lookups", async () => {
    mockReverse.mockResolvedValue(["cached-after.example.com"]);

    await resolveReverseDns("9.10.11.12");
    mockReverse.mockReset();

    // Second call should use cache
    const result = await resolveReverseDns("9.10.11.12");
    expect(result).toBe("cached-after.example.com");
    expect(mockReverse).not.toHaveBeenCalled();
  });

  it("returns undefined on DNS failure (does not throw)", async () => {
    mockReverse.mockRejectedValue(new Error("ENOTFOUND"));

    const result = await resolveReverseDns("99.99.99.99");

    expect(result).toBeUndefined();
  });

  it("bypasses cache when forceRefresh is true", async () => {
    setCachedDns("1.2.3.4", "old.example.com");
    mockReverse.mockResolvedValue(["new.example.com"]);

    const result = await resolveReverseDns("1.2.3.4", { forceRefresh: true });

    expect(result).toBe("new.example.com");
    expect(mockReverse).toHaveBeenCalledWith("1.2.3.4");
  });
});
