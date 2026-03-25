import Store from "electron-store";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { getLogger } from "./logger";
import type { GeoDatabaseMeta, RecentRun, TracerouteRun } from "@common/ipc";

const log = getLogger();

type SettingsSchema = {
  geo: {
    cityDbPath?: string;
    asnDbPath?: string;
    lastUpdated?: number;
  };
  preferences: {
    reducedMotion?: boolean;
    highContrast?: boolean;
  };
  cache: {
    dnsTtlMs: number;
    geoTtlMs: number;
  };
};

type CacheSchema = {
  dns: Record<string, { value: string; expiresAt: number }>;
  geo: Record<
    string,
    {
      value: {
        latitude: number;
        longitude: number;
        city?: string;
        country?: string;
        isoCode?: string;
        confidence?: number;
        asn?: number;
        asnName?: string;
        network?: string;
      };
      expiresAt: number;
    }
  >;
  runs: TracerouteRun[];
};

type StoreAdapter<T extends Record<string, any>> = {
  get<K extends keyof T>(key: K): T[K];
  get<R = unknown>(key: string, defaultValue?: R): R;
  set<K extends keyof T>(key: K, value: T[K]): void;
  set(key: string, value: unknown): void;
  set(object: Partial<T>): void;
  delete(key: string): void;
};

const settingsStore = new Store<SettingsSchema>({
  name: "settings",
  defaults: {
    geo: {},
    preferences: {},
    cache: {
      dnsTtlMs: 1000 * 60 * 60 * 24, // 24h
      geoTtlMs: 1000 * 60 * 60 * 24 * 7 // 7d
    }
  }
}) as unknown as StoreAdapter<SettingsSchema>;

const cacheStore = new Store<CacheSchema>({
  name: "cache",
  defaults: {
    dns: {},
    geo: {},
    runs: []
  }
}) as unknown as StoreAdapter<CacheSchema>;

export function getSettingsStore(): StoreAdapter<SettingsSchema> {
  return settingsStore;
}

export function getCacheStore(): StoreAdapter<CacheSchema> {
  return cacheStore;
}

export function getRecentRuns(limit = 5): RecentRun[] {
  const runs = cacheStore.get("runs");
  return runs
    .map((run): RecentRun => ({
      id: run.summary.target + run.summary.startedAt,
      startedAt: run.summary.startedAt,
      target: run.summary.target,
      protocol: run.request.protocol
    }))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

export function addCompletedRun(run: TracerouteRun): void {
  const runs = cacheStore.get("runs");
  cacheStore.set("runs", [run, ...runs].slice(0, 10));
}

export function getCachedDns(host: string): string | undefined {
  const record = cacheStore.get<{ value: string; expiresAt: number }>(`dns.${host}`);
  if (record && record.expiresAt > Date.now()) {
    return record.value;
  }
  cacheStore.delete(`dns.${host}`);
  return undefined;
}

export function setCachedDns(host: string, value: string): void {
  const ttl = settingsStore.get<number>("cache.dnsTtlMs");
  cacheStore.set(`dns.${host}`, { value, expiresAt: Date.now() + ttl });
}

export interface GeoCacheValue {
  latitude: number;
  longitude: number;
  city?: string;
  country?: string;
  isoCode?: string;
  confidence?: number;
  asn?: number;
  asnName?: string;
  network?: string;
}

export function getCachedGeo(ip: string): GeoCacheValue | undefined {
  const record = cacheStore.get<{ value: GeoCacheValue; expiresAt: number }>(`geo.${ip}`);
  if (record && record.expiresAt > Date.now()) {
    return record.value;
  }
  cacheStore.delete(`geo.${ip}`);
  return undefined;
}

export function setCachedGeo(ip: string, value: GeoCacheValue): void {
  const ttl = settingsStore.get<number>("cache.geoTtlMs");
  cacheStore.set(`geo.${ip}`, {
    value,
    expiresAt: Date.now() + ttl
  });
}

export async function ensureAppDataDirs(): Promise<void> {
  const dataPath = app.getPath("userData");
  const dirs = [path.join(dataPath, "geo"), path.join(dataPath, "snapshots")];
  for (const dir of dirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      log.error("Failed to ensure directory", dir, error);
    }
  }
}

export function getGeoDatabaseMeta(): GeoDatabaseMeta {
  const { cityDbPath, asnDbPath, lastUpdated } = settingsStore.get("geo");
  return {
    cityDbPath,
    asnDbPath,
    updatedAt: lastUpdated
  };
}

function resolveAssetsRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "assets");
  }
  return path.join(app.getAppPath(), "assets");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function configureGeoDatabaseDefaults(): Promise<void> {
  const store = getSettingsStore();
  const geoSettings = store.get("geo");
  const assetsRoot = resolveAssetsRoot();

  const cityAssetPath = path.join(assetsRoot, "GeoLite2-City.mmdb");
  const asnAssetPath = path.join(assetsRoot, "GeoLite2-ASN.mmdb");

  let updated = geoSettings.lastUpdated;
  let cityDbPath = geoSettings.cityDbPath;
  let asnDbPath = geoSettings.asnDbPath;

  if (await fileExists(cityAssetPath)) {
    cityDbPath = cityAssetPath;
    const stats = await fs.stat(cityAssetPath);
    updated = Math.max(updated ?? 0, stats.mtimeMs);
  }

  if (await fileExists(asnAssetPath)) {
    asnDbPath = asnAssetPath;
    const stats = await fs.stat(asnAssetPath);
    updated = Math.max(updated ?? 0, stats.mtimeMs);
  }

  store.set("geo", {
    ...geoSettings,
    cityDbPath,
    asnDbPath,
    lastUpdated: updated
  });
}
