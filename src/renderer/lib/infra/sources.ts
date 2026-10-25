/**
 * The data of the infrastructure layers, parsed at the edge. Each source
 * arrives untyped (backend IPC or a bundled JSON file); records that do not
 * have the expected shape are dropped and counted, so one bad record cannot
 * hide the others. A source whose outer shape is wrong is an error.
 */

/** Data a layer loads when it is switched on (`LayerDefinition.data`). */
export type InfraSourceId = "peeringdb-sites" | "cloud-regions" | "submarine-cables";

export interface Exchange {
  /** "ix:<PeeringDB id>", the same id as `IxpMatch.ixId` of a hop. */
  key: string;
  id: number;
  name: string;
  city: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
  facilityCount: number;
  networkCount: number;
}

export interface Facility {
  /** "fac:<PeeringDB id>" */
  key: string;
  id: number;
  name: string;
  org: string | null;
  city: string | null;
  country: string | null;
  latitude: number;
  longitude: number;
  networkCount: number;
  exchangeCount: number;
}

export interface PeeringDbSiteData {
  /** False for a list saved by an older version: it has no data centres. */
  complete: boolean;
  exchanges: Exchange[];
  facilities: Facility[];
  /** Records dropped at the edge; logged by the loader. */
  rejected: number;
}

export interface CloudProvider {
  id: string;
  name: string;
  shortName: string;
  /** The company whose networks the ASNs are ("Google" for Google Cloud). */
  operator: string;
  asns: number[];
  /** Cloudflare has data centres, not regions. */
  sites: "regions" | "data-centres";
}

export interface CloudRegion {
  /** "<provider>:<code>" */
  key: string;
  provider: string;
  code: string;
  name: string;
  city: string;
  country: string;
  /** Always approximate: the city centre or the airport of the site. */
  latitude: number;
  longitude: number;
}

export interface CloudRegionData {
  providers: CloudProvider[];
  regions: CloudRegion[];
  rejected: number;
}

export interface SubmarineCable {
  /** "cable:<TeleGeography id>" */
  key: string;
  id: string;
  name: string;
  /** Line strings of [longitude, latitude]. */
  segments: Array<Array<[number, number]>>;
}

export interface CableData {
  /** Set when a refresh failed and the backend sent its saved copy. */
  note: string | null;
  cables: SubmarineCable[];
  rejected: number;
}

/** The cloud region snapshot layout this version reads. */
export const CLOUD_SNAPSHOT_SCHEMA = 1;

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;

const latitude = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 90 ? value : null;

const longitude = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 180 ? value : null;

/** Optional text: absent or null is null, anything else must be text. */
const optionalText = (value: unknown): string | null | undefined =>
  value == null ? null : (text(value) ?? undefined);

function list(raw: Fields, field: string, what: string): unknown[] {
  const value = raw[field];
  if (!Array.isArray(value)) {
    throw new Error(`${what} has no ${field} list.`);
  }
  return value;
}

/** Keeps the records `parse` accepts, once per key, and counts the others. */
function records<T extends { key: string }>(
  rows: unknown[],
  parse: (row: Fields) => T | null
): { kept: T[]; rejected: number } {
  const kept: T[] = [];
  const keys = new Set<string>();
  for (const row of rows) {
    const record = isRecord(row) ? parse(row) : null;
    if (record && !keys.has(record.key)) {
      keys.add(record.key);
      kept.push(record);
    }
  }
  return { kept, rejected: rows.length - kept.length };
}

function exchange(row: Fields): Exchange | null {
  const id = count(row.id);
  const name = text(row.name);
  const lat = latitude(row.latitude);
  const lon = longitude(row.longitude);
  const city = optionalText(row.city);
  const country = optionalText(row.country);
  const facilityCount = count(row.facilityCount);
  const networkCount = count(row.networkCount);
  if (
    id == null ||
    !name ||
    lat == null ||
    lon == null ||
    city === undefined ||
    country === undefined ||
    facilityCount == null ||
    networkCount == null
  ) {
    return null;
  }
  return {
    key: `ix:${id}`,
    id,
    name,
    city,
    country,
    latitude: lat,
    longitude: lon,
    facilityCount,
    networkCount
  };
}

function facility(row: Fields): Facility | null {
  const id = count(row.id);
  const name = text(row.name);
  const lat = latitude(row.latitude);
  const lon = longitude(row.longitude);
  const org = optionalText(row.org);
  const city = optionalText(row.city);
  const country = optionalText(row.country);
  const networkCount = count(row.networkCount);
  const exchangeCount = count(row.exchangeCount);
  if (
    id == null ||
    !name ||
    lat == null ||
    lon == null ||
    org === undefined ||
    city === undefined ||
    country === undefined ||
    networkCount == null ||
    exchangeCount == null
  ) {
    return null;
  }
  return {
    key: `fac:${id}`,
    id,
    name,
    org,
    city,
    country,
    latitude: lat,
    longitude: lon,
    networkCount,
    exchangeCount
  };
}

/** `get_peeringdb_sites`. `null` (no list downloaded yet) gives `null`. */
export function parsePeeringDbSites(raw: unknown): PeeringDbSiteData | null {
  if (raw == null) {
    return null;
  }
  if (!isRecord(raw)) {
    throw new Error("The exchange list from the backend is not an object.");
  }
  if (typeof raw.complete !== "boolean") {
    throw new Error("The exchange list from the backend does not say whether it is complete.");
  }
  const exchanges = records(list(raw, "exchanges", "The exchange list"), exchange);
  const facilities = records(list(raw, "facilities", "The exchange list"), facility);
  return {
    complete: raw.complete,
    exchanges: exchanges.kept,
    facilities: facilities.kept,
    rejected: exchanges.rejected + facilities.rejected
  };
}

function provider(row: Fields): (CloudProvider & { key: string }) | null {
  const id = text(row.id);
  const name = text(row.name);
  const shortName = text(row.shortName);
  const operator = text(row.operator);
  const asns = Array.isArray(row.asns) ? row.asns.map(count) : null;
  const sites = row.sites === "regions" || row.sites === "data-centres" ? row.sites : null;
  if (!id || !name || !shortName || !operator || !asns || asns.some((asn) => asn == null) || !sites) {
    return null;
  }
  return { key: id, id, name, shortName, operator, asns: asns as number[], sites };
}

/** `public/infra/cloud-regions.json` (scripts/infra-data/build-cloud-regions.mjs). */
export function parseCloudRegions(raw: unknown): CloudRegionData {
  if (!isRecord(raw) || !isRecord(raw.meta)) {
    throw new Error("The cloud region file has no metadata.");
  }
  if (raw.meta.schema !== CLOUD_SNAPSHOT_SCHEMA) {
    throw new Error(
      `The cloud region file has layout ${String(raw.meta.schema)}; this version reads layout ${CLOUD_SNAPSHOT_SCHEMA}.`
    );
  }
  const providers = records(list(raw, "providers", "The cloud region file"), provider);
  const known = new Set(providers.kept.map((entry) => entry.id));
  const regions = records(list(raw, "regions", "The cloud region file"), (row) => {
    const providerId = text(row.provider);
    const code = text(row.code);
    const name = text(row.name);
    const city = text(row.city);
    const country = typeof row.country === "string" && /^[A-Z]{2}$/.test(row.country) ? row.country : null;
    const lat = latitude(row.latitude);
    const lon = longitude(row.longitude);
    if (!providerId || !known.has(providerId) || !code || !name || !city || !country) {
      return null;
    }
    if (lat == null || lon == null || row.approximate !== true) {
      return null;
    }
    return {
      key: `${providerId}:${code}`,
      provider: providerId,
      code,
      name,
      city,
      country,
      latitude: lat,
      longitude: lon
    };
  });
  return {
    providers: providers.kept.map(({ id, name, shortName, operator, asns, sites }) => ({
      id,
      name,
      shortName,
      operator,
      asns,
      sites
    })),
    regions: regions.kept,
    rejected: providers.rejected + regions.rejected
  };
}

function segment(value: unknown): Array<[number, number]> | null {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const points: Array<[number, number]> = [];
  for (const point of value) {
    const lon = Array.isArray(point) ? longitude(point[0]) : null;
    const lat = Array.isArray(point) ? latitude(point[1]) : null;
    if (lon == null || lat == null) {
      return null;
    }
    points.push([lon, lat]);
  }
  return points;
}

/** `get_submarine_cables` (already compacted and checked by the backend). */
export function parseSubmarineCables(raw: unknown): CableData {
  if (!isRecord(raw)) {
    throw new Error("The cable map from the backend is not an object.");
  }
  const cables = records(list(raw, "cables", "The cable map"), (row) => {
    const id = text(row.id);
    const name = text(row.name);
    const segments = Array.isArray(row.segments) ? row.segments.map(segment) : null;
    if (!id || !name || !segments || segments.length === 0 || segments.includes(null)) {
      return null;
    }
    return { key: `cable:${id}`, id, name, segments: segments as Array<Array<[number, number]>> };
  });
  return { note: text(raw.note), cables: cables.kept, rejected: cables.rejected };
}
