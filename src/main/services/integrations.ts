import net from "node:net";
import type {
  AsnDetails,
  GeoDetails,
  IntegrationSettings,
  PeeringDbDetails,
  ProviderId,
  ProviderStatus
} from "@common/ipc";
import { getLogger } from "./logger";
import { getSettingsStore } from "./persistence";

const log = getLogger();

type ProviderResult<T> = {
  status: ProviderStatus;
  value?: T;
};

type ProviderExecutor<T> = () => Promise<T | undefined>;

const providerQueues = new Map<ProviderId, Promise<void>>();
const lastRequestTimes = new Map<ProviderId, number>();

// Cache for PeeringDB results by ASN to avoid redundant queries
const peeringDbCache = new Map<number, { data: PeeringDbDetails | undefined; timestamp: number }>();
const PEERINGDB_CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours

// Rate limit delays in milliseconds per provider
const PROVIDER_RATE_LIMITS: Partial<Record<ProviderId, number>> = {
  "peeringdb": 5000,      // 5 seconds between PeeringDB requests (VERY strict to avoid 429)
  "team-cymru": 150,      // 150ms between Team Cymru requests
  "rdap": 250,            // 250ms between RDAP requests
  "ripe-stat": 250        // 250ms between RIPE Stat requests
};

// Track consecutive 429 errors per provider for exponential backoff
const rateLimitErrors = new Map<ProviderId, number>();
const MAX_BACKOFF_MS = 30000; // Maximum 30 second backoff

// Timeout values in milliseconds per provider
const PROVIDER_TIMEOUTS: Partial<Record<ProviderId, number>> = {
  "peeringdb": 10000,     // 10 seconds for PeeringDB
  "team-cymru": 8000,     // 8 seconds for Team Cymru (socket-based)
  "rdap": 10000,          // 10 seconds for RDAP
  "ripe-stat": 10000      // 10 seconds for RIPE Stat
};

async function enforceRateLimit(provider: ProviderId): Promise<void> {
  const minDelay = PROVIDER_RATE_LIMITS[provider];
  if (!minDelay) {
    return;
  }

  // Apply exponential backoff if we've had recent 429 errors
  const errorCount = rateLimitErrors.get(provider) ?? 0;
  const backoffMultiplier = Math.pow(2, errorCount); // 1x, 2x, 4x, 8x, etc.
  const backoffDelay = Math.min(minDelay * backoffMultiplier, MAX_BACKOFF_MS);

  const lastRequest = lastRequestTimes.get(provider);
  if (lastRequest) {
    const elapsed = Date.now() - lastRequest;
    const remaining = backoffDelay - elapsed;
    if (remaining > 0) {
      if (errorCount > 0) {
        log.warn(`[rate-limit] Exponential backoff (${errorCount} errors): delaying ${provider} request by ${remaining}ms`);
      } else {
        log.info(`[rate-limit] Delaying ${provider} request by ${remaining}ms to respect rate limit`);
      }
      await new Promise(resolve => setTimeout(resolve, remaining));
    }
  }
  lastRequestTimes.set(provider, Date.now());
}

async function withProviderQueue<T>(provider: ProviderId, fn: () => Promise<T>): Promise<T> {
  const previous = providerQueues.get(provider) ?? Promise.resolve();
  let release: (() => void) | undefined;

  const next = new Promise<void>((resolve) => {
    release = resolve;
  });

  providerQueues.set(
    provider,
    previous
      .catch(() => undefined)
      .then(() => next)
      .catch(() => undefined)
  );

  await previous.catch(() => undefined);

  try {
    // Enforce rate limiting before making the request
    await enforceRateLimit(provider);
    return await fn();
  } finally {
    release?.();
  }
}

async function executeProvider<T>(
  provider: ProviderId,
  enabled: boolean,
  executor: ProviderExecutor<T>,
  ipAddress: string,
  skipMessage?: string
): Promise<ProviderResult<T | undefined>> {
  if (!enabled) {
    const message = `[enrich] ${provider} skipped for ${ipAddress} — disabled in settings.`;
    log.info(message);
    return {
      status: { provider, status: "skipped", message: skipMessage ?? "Disabled in settings." }
    };
  }

  try {
    const startMessage = `[enrich] ${provider} lookup starting for ${ipAddress}`;
    log.info(startMessage);
    const value = await withProviderQueue(provider, () => executor());

    // Success - reset any rate limit error counter
    rateLimitErrors.delete(provider);

    if (value == null) {
      // No data found is normal, not an error - don't log or show as error
      log.info(`[enrich] ${provider} lookup finished for ${ipAddress} (no data found).`);
      return {
        status: { provider, status: "success", message: "No data found for this IP." }
      };
    }

    log.info(`[enrich] ${provider} lookup finished for ${ipAddress} (success).`);
    return {
      status: { provider, status: "success", details: value },
      value
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `Unexpected ${provider} error during lookup.`;

    // Check if it's a rate limit error
    const isRateLimitError = error instanceof Error && (
      error.message.includes("HTTP 429") ||
      error.message.includes("Rate limited") ||
      error.message.includes("rate limit")
    );

    // If rate limit error, increment counter for exponential backoff
    if (isRateLimitError) {
      const currentCount = rateLimitErrors.get(provider) ?? 0;
      rateLimitErrors.set(provider, currentCount + 1);
      log.warn(`[rate-limit] ${provider} rate limit error count: ${currentCount + 1}`);
    }

    // Check if it's a network-related error
    const isNetworkError = error instanceof Error && (
      error.message.includes("ENOTFOUND") ||
      error.message.includes("ECONNREFUSED") ||
      error.message.includes("ETIMEDOUT") ||
      error.message.includes("timeout") ||
      error.message.includes("fetch failed") ||
      error.message.includes("network")
    );

    const errorType = isRateLimitError ? "RATE LIMIT" : (isNetworkError ? "NETWORK ERROR" : "ERROR");
    const errorMessage = `[enrich] ${provider} lookup failed for ${ipAddress} [${errorType}]: ${message}`;
    log.warn(errorMessage);

    return {
      status: {
        provider,
        status: "error",
        message: isNetworkError ? `Network error: ${message}` : message
      }
    };
  }
}

interface TeamCymruResult {
  asn?: number;
  name?: string;
  prefix?: string;
  country?: string;
  registry?: string;
}

async function queryTeamCymru(ipAddress: string): Promise<TeamCymruResult | undefined> {
  return new Promise<TeamCymruResult | undefined>((resolve, reject) => {
    const socket = net.createConnection({ host: "whois.cymru.com", port: 43 });
    let payload = "";

    const timeout = PROVIDER_TIMEOUTS["team-cymru"] ?? 8000;
    socket.setTimeout(timeout, () => {
      socket.destroy(new Error("Team Cymru lookup timed out."));
    });

    socket.once("error", (error) => {
      reject(error);
    });

    socket.on("data", (chunk) => {
      payload += chunk.toString("utf8");
    });

    socket.once("end", () => {
      const lines = payload
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean);

      // Header is at index 0, first data row at index 1
      const dataRow = lines.find((line) => /^\d+\s*\|/.test(line));
      if (!dataRow) {
        resolve(undefined);
        return;
      }

      const parts = dataRow.split("|").map((value) => value.trim());
      if (parts.length < 7) {
        resolve(undefined);
        return;
      }

      const [asnStr, , prefix, country, registry, , name] = parts;
      const asn = Number.parseInt(asnStr, 10);
      resolve({
        asn: Number.isNaN(asn) ? undefined : asn,
        name,
        prefix,
        country: country || undefined,
        registry: registry || undefined
      });
    });

    socket.once("connect", () => {
      socket.write("begin\n");
      socket.write("verbose\n");
      socket.write(`${ipAddress}\n`);
      socket.end("end\n");
    });
  });
}

interface RdapResult {
  name?: string;
  handle?: string;
  country?: string;
  remarks?: string[];
}

async function queryRdap(ipAddress: string, baseUrl: string): Promise<RdapResult | undefined> {
  const url = `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(ipAddress)}`;
  const timeout = PROVIDER_TIMEOUTS["rdap"] ?? 10000;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "VisTracer",
      Accept: "application/rdap+json, application/json"
    },
    signal: AbortSignal.timeout(timeout)
  });

  if (!response.ok) {
    if (response.status === 404) {
      return undefined;
    }

    if (response.status === 429) {
      throw new Error(`Rate limited by RDAP service (HTTP 429). Please wait before retrying.`);
    }

    throw new Error(`HTTP ${response.status} from RDAP service.`);
  }

  const data = (await response.json()) as {
    name?: string;
    handle?: string;
    country?: string;
    remarks?: { description?: string[] }[];
  };

  return {
    name: data.name,
    handle: data.handle,
    country: data.country,
    remarks: data.remarks?.flatMap((remark) => remark.description ?? []) ?? []
  };
}

interface RipeStatResult {
  asn?: number;
  holder?: string;
  prefix?: string;
  country?: string;
}

async function queryRipeStat(ipAddress: string, sourceApp: string): Promise<RipeStatResult | undefined> {
  const params = new URLSearchParams({
    resource: ipAddress,
    sourceapp: sourceApp
  });

  const timeout = PROVIDER_TIMEOUTS["ripe-stat"] ?? 10000;
  const response = await fetch(
    `https://stat.ripe.net/data/prefix-overview/data.json?${params.toString()}`,
    {
      headers: {
        "User-Agent": "VisTracer"
      },
      signal: AbortSignal.timeout(timeout)
    }
  );

  if (!response.ok) {
    if (response.status === 404) {
      return undefined;
    }

    if (response.status === 429) {
      throw new Error(`Rate limited by RIPE Stat (HTTP 429). Please wait before retrying.`);
    }

    throw new Error(`HTTP ${response.status} from RIPE Stat.`);
  }

  const payload = (await response.json()) as {
    data?: {
      asns?: { asn?: number; holder?: string; country?: string }[];
      prefix?: string;
    };
  };

  const primaryAsn = payload.data?.asns?.[0];

  return {
    asn: primaryAsn?.asn,
    holder: primaryAsn?.holder,
    country: primaryAsn?.country,
    prefix: payload.data?.prefix
  };
}

interface PeeringDbApiResponse {
  data?: Array<{
    id?: number;
    name?: string;
    aka?: string;
    website?: string;
    city?: string;
    country?: string;
    ix_count?: number;
  }>;
}

async function queryPeeringDb(asn: number, apiKey?: string): Promise<PeeringDbDetails | undefined> {
  // Check cache first to avoid redundant queries for the same ASN
  const cached = peeringDbCache.get(asn);
  if (cached && (Date.now() - cached.timestamp) < PEERINGDB_CACHE_TTL) {
    log.info(`[peeringdb] Cache hit for ASN ${asn}`);
    return cached.data;
  }

  const headers: Record<string, string> = {
    "User-Agent": "VisTracer"
  };

  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  }

  const timeout = PROVIDER_TIMEOUTS["peeringdb"] ?? 10000;
  const response = await fetch(`https://www.peeringdb.com/api/net?asn=${asn}`, {
    headers,
    signal: AbortSignal.timeout(timeout)
  });

  if (!response.ok) {
    if (response.status === 404) {
      // Cache the 404 result to avoid repeated queries
      peeringDbCache.set(asn, { data: undefined, timestamp: Date.now() });
      return undefined;
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const waitTime = retryAfter ? `${retryAfter} seconds` : "later";
      throw new Error(`Rate limited by PeeringDB (HTTP 429). Retry after ${waitTime}. Consider using an API key for higher limits.`);
    }

    throw new Error(`HTTP ${response.status} from PeeringDB.`);
  }

  const payload = (await response.json()) as PeeringDbApiResponse;
  const entry = payload.data?.[0];

  if (!entry) {
    // Cache the empty result
    peeringDbCache.set(asn, { data: undefined, timestamp: Date.now() });
    return undefined;
  }

  const result = {
    id: entry.id,
    name: entry.name,
    aka: entry.aka,
    website: entry.website,
    city: entry.city,
    country: entry.country,
    ixCount: entry.ix_count
  };

  // Cache the successful result
  peeringDbCache.set(asn, { data: result, timestamp: Date.now() });
  return result;
}

export interface EnrichmentSeed {
  geo?: GeoDetails;
  asn?: AsnDetails;
}

export interface EnrichmentResult {
  geo?: GeoDetails;
  asn?: AsnDetails;
  providerStatuses: ProviderStatus[];
  peeringDb?: PeeringDbDetails;
}

function mergeAsn(base: AsnDetails | undefined, addition: Partial<AsnDetails>): AsnDetails {
  return {
    ...base,
    ...addition,
    network: addition.network ?? base?.network
  };
}

export async function enrichWithExternalProviders(
  ipAddress: string,
  seed: EnrichmentSeed
): Promise<EnrichmentResult> {
  const rawSettings = getSettingsStore().get("integrations") as IntegrationSettings | undefined;
  const settings: IntegrationSettings = {
    teamCymru: {
      enabled: rawSettings?.teamCymru?.enabled ?? true
    },
    rdap: {
      enabled: rawSettings?.rdap?.enabled ?? true,
      baseUrl: rawSettings?.rdap?.baseUrl ?? "https://rdap.org/ip"
    },
    ripeStat: {
      enabled: rawSettings?.ripeStat?.enabled ?? true,
      sourceApp: rawSettings?.ripeStat?.sourceApp ?? "VisTracer"
    },
    peeringDb: {
      enabled: rawSettings?.peeringDb?.enabled ?? false,
      apiKey: rawSettings?.peeringDb?.apiKey
    }
  };
  const providerStatuses: ProviderStatus[] = [];

  const settingsMessage = `[enrich] Provider toggles for ${ipAddress}: ` +
    `teamCymru=${settings.teamCymru.enabled}, rdap=${settings.rdap.enabled}, ` +
    `ripeStat=${settings.ripeStat.enabled}, peeringDb=${settings.peeringDb.enabled}`;
  log.info(settingsMessage);

  const introMessage = `[enrich] Starting enrichment pipeline for ${ipAddress}`;
  log.info(introMessage);

  if (seed.geo || seed.asn) {
    const seedMessage = `[enrich] MaxMind seed data for ${ipAddress}: hasGeo=${seed.geo != null}, hasAsn=${seed.asn != null}`;
    log.info(seedMessage);
    providerStatuses.push({
      provider: "maxmind",
      status: "success",
      message: "Resolved locally via GeoLite2."
    });
  } else {
    const noSeedMessage = `[enrich] No MaxMind seed data for ${ipAddress}, will attempt external providers only`;
    log.info(noSeedMessage);
    providerStatuses.push({
      provider: "maxmind",
      status: "error",
      message: "No GeoLite2 match found."
    });
  }

  let currentGeo = seed.geo;
  let currentAsn = seed.asn;
  let peeringDbDetails: PeeringDbDetails | undefined;

  const cymruResult = await executeProvider(
    "team-cymru",
    settings.teamCymru.enabled,
    () => queryTeamCymru(ipAddress),
    ipAddress
  );
  providerStatuses.push(cymruResult.status);

  if (cymruResult.value) {
    const beforeAsn = currentAsn?.asn;
    currentAsn = mergeAsn(currentAsn, {
      asn: currentAsn?.asn ?? cymruResult.value.asn,
      name: currentAsn?.name ?? cymruResult.value.name,
      network: currentAsn?.network ?? cymruResult.value.prefix,
      country: currentAsn?.country ?? cymruResult.value.country,
      registry: currentAsn?.registry ?? cymruResult.value.registry
    });
    const mergeMessage = `[enrich] Team Cymru data merged for ${ipAddress}: ASN=${currentAsn?.asn ?? 'none'} (was ${beforeAsn ?? 'none'})`;
    log.info(mergeMessage);
  }

  const rdapBaseUrl = settings.rdap.baseUrl?.trim() || "https://rdap.org/ip";
  const rdapResult = await executeProvider(
    "rdap",
    settings.rdap.enabled,
    () => queryRdap(ipAddress, rdapBaseUrl),
    ipAddress
  );
  providerStatuses.push(rdapResult.status);

  if (rdapResult.value) {
    let merged = false;
    if (!currentAsn?.name && rdapResult.value.name) {
      currentAsn = mergeAsn(currentAsn, { name: rdapResult.value.name });
      merged = true;
    }

    if (rdapResult.value.country && currentGeo?.country == null) {
      const baseline = currentGeo ?? seed.geo;
      currentGeo = {
        latitude: baseline?.latitude ?? 0,
        longitude: baseline?.longitude ?? 0,
        city: baseline?.city,
        country: rdapResult.value.country,
        isoCode: baseline?.isoCode,
        confidence: baseline?.confidence
      };
      merged = true;
    }

    if (merged) {
      const mergeMessage = `[enrich] RDAP data merged for ${ipAddress}`;
      log.info(mergeMessage);
    }
  }

  const ripeStatResult = await executeProvider(
    "ripe-stat",
    settings.ripeStat.enabled,
    () => queryRipeStat(ipAddress, settings.ripeStat.sourceApp || "VisTracer"),
    ipAddress
  );
  providerStatuses.push(ripeStatResult.status);

  if (ripeStatResult.value) {
    const beforeAsn = currentAsn?.asn;
    currentAsn = mergeAsn(currentAsn, {
      asn: currentAsn?.asn ?? ripeStatResult.value.asn,
      name: currentAsn?.name ?? ripeStatResult.value.holder,
      network: currentAsn?.network ?? ripeStatResult.value.prefix,
      country: currentAsn?.country ?? ripeStatResult.value.country
    });
    const mergeMessage = `[enrich] RIPE Stat data merged for ${ipAddress}: ASN=${currentAsn?.asn ?? 'none'} (was ${beforeAsn ?? 'none'})`;
    log.info(mergeMessage);
  }

  if (currentAsn?.asn) {
    const peeringDbResult = await executeProvider(
      "peeringdb",
      settings.peeringDb.enabled,
      () => queryPeeringDb(currentAsn!.asn!, settings.peeringDb.apiKey),
      ipAddress
    );
    providerStatuses.push(peeringDbResult.status);

    if (peeringDbResult.value) {
      peeringDbDetails = peeringDbResult.value;
      currentAsn = mergeAsn(currentAsn, {
        name: currentAsn.name ?? peeringDbResult.value.name,
        country: currentAsn.country ?? peeringDbResult.value.country
      });
      const mergeMessage = `[enrich] PeeringDB data merged for ${ipAddress}: ${peeringDbResult.value.name ?? 'unnamed'}`;
      log.info(mergeMessage);
    }
  } else {
    providerStatuses.push({
      provider: "peeringdb",
      status: "skipped",
      message: "ASN unknown, skipping PeeringDB lookup."
    });
  }

  const completeMessage = `[enrich] Completed enrichment pipeline for ${ipAddress}`;
  log.info(completeMessage);

  // Log summary of provider results
  const summary = providerStatuses.map(ps => `${ps.provider}:${ps.status}`).join(", ");
  const summaryMessage = `[enrich] Provider summary for ${ipAddress}: ${summary}`;
  log.info(summaryMessage);

  return {
    geo: currentGeo,
    asn: currentAsn,
    providerStatuses,
    peeringDb: peeringDbDetails
  };
}
