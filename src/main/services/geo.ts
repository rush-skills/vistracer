import maxmind, { CityResponse, AsnResponse, Reader, Response } from "maxmind";
import { getCachedGeo, getSettingsStore, setCachedGeo } from "./persistence";
import { enrichWithExternalProviders } from "./integrations";
import { isPrivateIpv4 } from "@common/net";
import type {
  AsnDetails,
  GeoDetails,
  GeoDatabaseStatus,
  PeeringDbDetails,
  ProviderId,
  ProviderStatus
} from "@common/ipc";
import { getLogger } from "./logger";
import fs from "node:fs/promises";

const log = getLogger();

let cityReader: Reader<CityResponse> | null = null;
let asnReader: Reader<AsnResponse> | null = null;
let cityDbStatus: GeoDatabaseStatus = "missing";
let asnDbStatus: GeoDatabaseStatus = "missing";
let lastStatusMessage: string | undefined;

const PROVIDER_ORDER: ProviderId[] = ["maxmind", "team-cymru", "rdap", "ripe-stat", "peeringdb"];

function normalizeProviderStatuses(statuses?: ProviderStatus[]): ProviderStatus[] {
  const map = new Map<ProviderId, ProviderStatus>();
  statuses?.forEach((status) => {
    map.set(status.provider, status);
  });

  return PROVIDER_ORDER.map((provider) => {
    const existing = map.get(provider);
    if (existing) {
      return existing;
    }

    return {
      provider,
      status: "skipped",
      message: "No lookup performed."
    };
  });
}

async function loadReader<T extends Response>(
  path: string | undefined,
  dbType: "city" | "asn"
): Promise<Reader<T> | null> {
  if (!path) {
    if (dbType === "city") {
      cityDbStatus = "missing";
    } else {
      asnDbStatus = "missing";
    }
    return null;
  }

  try {
    await fs.access(path);
    const reader = await maxmind.open<T>(path);
    if (dbType === "city") {
      cityDbStatus = "loaded";
    } else {
      asnDbStatus = "loaded";
    }
    return reader;
  } catch (error) {
    log.warn(`Failed to load MaxMind database at ${path}`, error);
    if (dbType === "city") {
      cityDbStatus = "error";
    } else {
      asnDbStatus = "error";
    }
    lastStatusMessage = error instanceof Error ? error.message : "Unknown error";
    return null;
  }
}

async function ensureReaders(): Promise<void> {
  if (cityReader && asnReader) {
    return;
  }

  const store = getSettingsStore();
  const { cityDbPath, asnDbPath } = store.get("geo");

  if (!cityReader) {
    cityReader = await loadReader<CityResponse>(cityDbPath, "city");
  }

  if (!asnReader) {
    asnReader = await loadReader<AsnResponse>(asnDbPath, "asn");
  }
}

export interface GeoLookupResult {
  geo?: GeoDetails;
  asn?: AsnDetails;
  providers: ProviderStatus[];
  peeringDb?: PeeringDbDetails;
}

export interface GeoLookupOptions {
  forceRefresh?: boolean;
  onEnrichmentComplete?: (result: GeoLookupResult) => void;
}

export async function lookupGeo(
  ipAddress: string,
  options?: GeoLookupOptions
): Promise<GeoLookupResult | undefined> {
  if (!ipAddress || isPrivateIpv4(ipAddress)) {
    const providers = PROVIDER_ORDER.map<ProviderStatus>((provider) => ({
      provider,
      status: "skipped",
      message: "Private IP address."
    }));

    return {
      geo: undefined,
      asn: undefined,
      providers
    };
  }

  let geo: GeoDetails | undefined;
  let asn: AsnDetails | undefined;
  let cachedProviders: ProviderStatus[] | undefined;
  let cachedPeeringDb: PeeringDbDetails | undefined;
  let seededFromCache = false;

  log.info(
    `[geo] lookup start for ${ipAddress} (forceRefresh=${options?.forceRefresh ?? false})`
  );

  if (!options?.forceRefresh) {
    const cached = getCachedGeo(ipAddress);
    if (cached) {
      seededFromCache = true;
      log.info(`[geo] CACHE HIT for ${ipAddress}`);

      geo =
        cached.latitude != null && cached.longitude != null
          ? {
              latitude: cached.latitude,
              longitude: cached.longitude,
              city: cached.city,
              country: cached.country,
              isoCode: cached.isoCode,
              confidence: cached.confidence
            }
          : undefined;

      asn = cached.asn
        ? {
            asn: cached.asn,
            name: cached.asnName,
            network: cached.network,
            country: cached.asnCountry,
            registry: cached.asnRegistry
          }
        : undefined;

      cachedProviders = cached.providers;
      cachedPeeringDb = cached.peeringDb;
    } else {
      log.info(`[geo] CACHE MISS for ${ipAddress}`);
    }
  } else {
    log.info(`[geo] CACHE BYPASS (forceRefresh=true) for ${ipAddress}`);
  }

  if (!seededFromCache || options?.forceRefresh) {
    await ensureReaders();

    geo =
      geo ??
      (cityReader
        ? (() => {
            try {
              const result = cityReader.get(ipAddress);
              if (!result) {
                return undefined;
              }

              return {
                latitude: result.location?.latitude ?? 0,
                longitude: result.location?.longitude ?? 0,
                city: result.city?.names?.en,
                country: result.country?.names?.en,
                isoCode: result.country?.iso_code,
                confidence: result.location?.accuracy_radius
              };
            } catch (error) {
              log.warn("Geo lookup failed", ipAddress, error);
              return undefined;
            }
          })()
        : undefined);

    asn =
      asn ??
      (asnReader
        ? (() => {
            try {
              const result = asnReader.get(ipAddress);
              if (!result) {
                return undefined;
              }

              const network = (result as { network?: string }).network;

              return {
                asn: result.autonomous_system_number,
                name: result.autonomous_system_organization,
                network
              };
            } catch (error) {
              log.warn("ASN lookup failed", ipAddress, error);
              return undefined;
            }
          })()
        : undefined);
  }

  // Return MaxMind data immediately, don't wait for external enrichment
  // External providers will update in background (non-blocking)
  const finalGeo = geo;
  const finalAsn = asn;

  // Don't show old cached enrichment errors - they're stale
  // Only show provider statuses from successful cache hits or fresh data
  let providers: ProviderStatus[];
  if (seededFromCache && cachedProviders) {
    // Filter out any error statuses from cache - they're outdated
    providers = normalizeProviderStatuses(
      cachedProviders.filter(p => p.status !== "error")
    );
  } else {
    providers = normalizeProviderStatuses([]);
  }

  const finalPeeringDb = cachedPeeringDb;

  // Fire enrichment in background for fresh lookups (don't await)
  // This allows UI to update immediately with MaxMind data
  if (!seededFromCache || options?.forceRefresh) {
    log.info(`[geo] Starting async external provider enrichment for ${ipAddress} (reason: ${options?.forceRefresh ? 'force refresh' : 'cache miss'})`);

    // Fire and forget - don't block on enrichment
    enrichWithExternalProviders(ipAddress, { geo, asn })
      .then((enrichment) => {
        log.info(`[geo] Async enrichment completed for ${ipAddress} (${enrichment.providerStatuses.length} providers)`);

        // Update cache with enriched data
        const updatedGeo = enrichment.geo ?? geo;
        const updatedAsn = enrichment.asn ?? asn;
        const updatedProviders = normalizeProviderStatuses(enrichment.providerStatuses);
        const updatedPeeringDb = enrichment.peeringDb ?? cachedPeeringDb;

        if (updatedGeo || updatedAsn || updatedPeeringDb) {
          setCachedGeo(ipAddress, {
            latitude: updatedGeo?.latitude,
            longitude: updatedGeo?.longitude,
            city: updatedGeo?.city,
            country: updatedGeo?.country,
            isoCode: updatedGeo?.isoCode,
            confidence: updatedGeo?.confidence,
            asn: updatedAsn?.asn,
            asnName: updatedAsn?.name,
            network: updatedAsn?.network,
            asnCountry: updatedAsn?.country,
            asnRegistry: updatedAsn?.registry,
            providers: updatedProviders,
            peeringDb: updatedPeeringDb
          });
        }

        // Notify callback with enriched data
        if (options?.onEnrichmentComplete) {
          log.info(`[geo] Calling enrichment callback for ${ipAddress}`);
          options.onEnrichmentComplete({
            geo: updatedGeo,
            asn: updatedAsn,
            providers: updatedProviders,
            peeringDb: updatedPeeringDb
          });
        }
      })
      .catch((error) => {
        log.warn(`[geo] Async enrichment failed for ${ipAddress}:`, error);
      });
  } else {
    log.info(`[geo] Skipping external provider enrichment for ${ipAddress} (using cached data)`);
  }

  log.info(
    `[geo] lookup complete for ${ipAddress} (seededFromCache=${seededFromCache}, hasGeo=${
      finalGeo != null
    }, hasAsn=${finalAsn != null}) [NON-BLOCKING]`
  );

  // If we're returning fresh MaxMind data (not from cache), cache it now
  // Enrichment will update the cache later when it completes
  if (!seededFromCache && (finalGeo || finalAsn)) {
    setCachedGeo(ipAddress, {
      latitude: finalGeo?.latitude,
      longitude: finalGeo?.longitude,
      city: finalGeo?.city,
      country: finalGeo?.country,
      isoCode: finalGeo?.isoCode,
      confidence: finalGeo?.confidence,
      asn: finalAsn?.asn,
      asnName: finalAsn?.name,
      network: finalAsn?.network,
      asnCountry: finalAsn?.country,
      asnRegistry: finalAsn?.registry,
      providers,
      peeringDb: finalPeeringDb
    });
  }

  return {
    geo: finalGeo,
    asn: finalAsn,
    providers,
    peeringDb: finalPeeringDb
  };
}

export function getGeoDatabaseStatus() {
  return {
    cityDbStatus,
    asnDbStatus,
    statusMessage: lastStatusMessage
  };
}

export async function reloadGeoDatabases(): Promise<void> {
  cityReader = null;
  asnReader = null;
  cityDbStatus = "missing";
  asnDbStatus = "missing";
  lastStatusMessage = undefined;
  await ensureReaders();
}
