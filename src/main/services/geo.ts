import maxmind, { CityResponse, AsnResponse, Reader, Response } from "maxmind";
import { getCachedGeo, getSettingsStore, setCachedGeo } from "./persistence";
import { isPrivateIpv4 } from "@common/net";
import type { AsnDetails, GeoDetails } from "@common/ipc";
import { getLogger } from "./logger";
import fs from "node:fs/promises";

const log = getLogger();

let cityReader: Reader<CityResponse> | null = null;
let asnReader: Reader<AsnResponse> | null = null;

async function loadReader<T extends Response>(path: string | undefined): Promise<Reader<T> | null> {
  if (!path) {
    return null;
  }

  try {
    await fs.access(path);
    return await maxmind.open<T>(path);
  } catch (error) {
    log.warn(`Failed to load MaxMind database at ${path}`, error);
    return null;
  }
}

async function ensureReaders(): Promise<void> {
  if (cityReader && asnReader) {
    return;
  }

  const store = getSettingsStore();
  const { cityDbPath, asnDbPath } = store.get("geo");

  if (!cityReader && cityDbPath) {
    cityReader = await loadReader<CityResponse>(cityDbPath);
  }

  if (!asnReader && asnDbPath) {
    asnReader = await loadReader<AsnResponse>(asnDbPath);
  }
}

export interface GeoLookupResult {
  geo?: GeoDetails;
  asn?: AsnDetails;
}

export interface GeoLookupOptions {
  forceRefresh?: boolean;
}

export async function lookupGeo(
  ipAddress: string,
  options?: GeoLookupOptions
): Promise<GeoLookupResult | undefined> {
  if (!ipAddress || isPrivateIpv4(ipAddress)) {
    return {
      geo: undefined,
      asn: undefined
    };
  }

  if (!options?.forceRefresh) {
    const cached = getCachedGeo(ipAddress);
    if (cached) {
      return {
        geo: {
          latitude: cached.latitude,
          longitude: cached.longitude,
          city: cached.city,
          country: cached.country,
          isoCode: cached.isoCode,
          confidence: cached.confidence
        },
        asn: cached.asn
          ? {
              asn: cached.asn,
              name: cached.asnName,
              network: cached.network
            }
          : undefined
      };
    }
  }

  await ensureReaders();

  const geo: GeoDetails | undefined = cityReader
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
    : undefined;

  const asn: AsnDetails | undefined = asnReader
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
    : undefined;

  if (geo && !options?.forceRefresh) {
    setCachedGeo(ipAddress, {
      latitude: geo.latitude,
      longitude: geo.longitude,
      city: geo.city,
      country: geo.country,
      isoCode: geo.isoCode,
      confidence: geo.confidence,
      asn: asn?.asn,
      asnName: asn?.name,
      network: asn?.network
    });
  }

  return { geo, asn };
}
