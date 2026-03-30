import Store from "electron-store";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { getLogger } from "./logger";
import type {
  GeoDatabaseMeta,
  PeeringDbDetails,
  ProviderStatus,
  RecentRun,
  TracerouteRun
} from "@common/ipc";

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
    onboarding?: {
      skipOnLaunch?: boolean;
      lastCompletedAt?: number;
      lastDismissedAt?: number;
    };
  };
  cache: {
    dnsTtlMs: number;
    geoTtlMs: number;
  };
  integrations: {
    teamCymru: {
      enabled: boolean;
    };
    rdap: {
      enabled: boolean;
      baseUrl?: string;
    };
    ripeStat: {
      enabled: boolean;
      sourceApp: string;
    };
    peeringDb: {
      enabled: boolean;
      apiKey?: string;
    };
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

type StoreAdapter<T extends Record<string, unknown>> = {
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
    preferences: {
      onboarding: {}
    },
    cache: {
      dnsTtlMs: 1000 * 60 * 60 * 24, // 24h
      geoTtlMs: 1000 * 60 * 60 * 24 * 7 // 7d
    },
    integrations: {
      teamCymru: { enabled: true },
      rdap: { enabled: true, baseUrl: "https://rdap.org/ip" },
      ripeStat: { enabled: true, sourceApp: "VisTracer" },
      peeringDb: { enabled: false }
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
  latitude?: number;
  longitude?: number;
  city?: string;
  country?: string;
  isoCode?: string;
  confidence?: number;
  asn?: number;
  asnName?: string;
  network?: string;
  asnCountry?: string;
  asnRegistry?: string;
  providers?: ProviderStatus[];
  peeringDb?: PeeringDbDetails;
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

  // Filter out error statuses before caching - we don't want to persist errors
  const cleanedValue = {
    ...value,
    providers: value.providers?.filter(p => p.status !== "error")
  };

  cacheStore.set(`geo.${ip}`, {
    value: cleanedValue,
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

export async function getGeoDatabaseMeta(): Promise<GeoDatabaseMeta> {
  const { cityDbPath, asnDbPath, lastUpdated } = settingsStore.get("geo");

  // Check if databases actually exist
  const cityExists = cityDbPath ? await fileExists(cityDbPath) : false;
  const asnExists = asnDbPath ? await fileExists(asnDbPath) : false;

  const cityDbStatus: GeoDatabaseMeta["cityDbStatus"] = cityDbPath
    ? cityExists
      ? "loaded"
      : "error"
    : "missing";

  const asnDbStatus: GeoDatabaseMeta["asnDbStatus"] = asnDbPath
    ? asnExists
      ? "loaded"
      : "error"
    : "missing";

  let statusMessage: string | undefined;
  if (!cityExists && !asnExists) {
    statusMessage =
      "GeoIP databases not found. Fallback services will attempt lookups but accuracy may vary.";
  } else if (!cityExists) {
    statusMessage =
      "City database not found. Location accuracy will rely on fallback providers and may be limited.";
  } else if (!asnExists) {
    statusMessage =
      "ASN database not found. ASN details will rely on fallback providers and may lag behind.";
  }

  return {
    cityDbPath,
    asnDbPath,
    updatedAt: lastUpdated,
    cityDbStatus,
    asnDbStatus,
    statusMessage
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

  log.info("Geo database configuration", {
    cityDbPath,
    cityExists: await fileExists(cityAssetPath),
    asnDbPath,
    asnExists: await fileExists(asnAssetPath)
  });
}

export async function updateGeoDatabasePaths(cityPath?: string, asnPath?: string): Promise<void> {
  const store = getSettingsStore();
  const geoSettings = store.get("geo");

  store.set("geo", {
    ...geoSettings,
    cityDbPath: cityPath,
    asnDbPath: asnPath,
    lastUpdated: Date.now()
  });

  log.info("Updated geo database paths", { cityPath, asnPath });
}
