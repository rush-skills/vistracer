import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CLOUD_SNAPSHOT_SCHEMA,
  parseCloudRegions,
  parsePeeringDbSites,
  parseSubmarineCables
} from "@renderer/lib/infra/sources";
import {
  CLOUDFLARE_PLACES,
  CURATED_PROVIDERS,
  CURATED_REGIONS
} from "../../../../../scripts/infra-data/cloud-regions";

const snapshotPath = path.resolve(__dirname, "../../../public/infra/cloud-regions.json");
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as {
  meta: { recordCount: number; sources: Array<{ recordCount: number; what: string }> };
  regions: Array<Record<string, unknown>>;
};

const exchangeRow = {
  id: 31,
  name: "DE-CIX Frankfurt",
  city: "Frankfurt",
  country: "DE",
  latitude: 50.1,
  longitude: 8.7,
  radiusKm: 120,
  facilityCount: 40,
  networkCount: 1019
};
const facilityRow = {
  id: 58,
  name: "Digital Realty FRA1",
  org: "Digital Realty",
  city: "Frankfurt",
  country: "DE",
  latitude: 50.12,
  longitude: 8.74,
  networkCount: 618,
  exchangeCount: 31
};

describe("parsePeeringDbSites", () => {
  it("reads the backend's list and keys sites like the phase 2 IX match", () => {
    const data = parsePeeringDbSites({
      storedAt: 10,
      complete: true,
      exchanges: [exchangeRow],
      facilities: [facilityRow, { ...facilityRow, id: 59, org: null, city: null }]
    });
    expect(data?.exchanges[0]).toMatchObject({ key: "ix:31", name: "DE-CIX Frankfurt", networkCount: 1019 });
    expect(data?.facilities.map((site) => site.key)).toEqual(["fac:58", "fac:59"]);
    expect(data?.facilities[1].org).toBeNull();
    expect(data?.rejected).toBe(0);
  });

  it("has nothing to show before exchange matching downloaded a list", () => {
    expect(parsePeeringDbSites(null)).toBeNull();
    expect(parsePeeringDbSites(undefined)).toBeNull();
  });

  it("drops malformed records one by one and counts them", () => {
    const data = parsePeeringDbSites({
      storedAt: 10,
      complete: false,
      exchanges: [
        exchangeRow,
        { ...exchangeRow, id: 32, latitude: 95 },
        { ...exchangeRow, id: 33, name: "  " },
        { ...exchangeRow, id: 34, radiusKm: 0 },
        { ...exchangeRow, id: 35, networkCount: -1 },
        { ...exchangeRow, id: 36, city: 7 },
        "not a record",
        { ...exchangeRow }
      ],
      facilities: [{ ...facilityRow, longitude: Number.NaN }, { ...facilityRow, id: "58" }]
    });
    expect(data?.exchanges.map((site) => site.id)).toEqual([31]);
    expect(data?.facilities).toEqual([]);
    // 6 bad exchanges and one duplicate, 2 bad facilities.
    expect(data?.rejected).toBe(9);
    expect(data?.complete).toBe(false);
  });

  it("rejects a list without the expected outer shape", () => {
    expect(() => parsePeeringDbSites("sites")).toThrow("not an object");
    expect(() => parsePeeringDbSites({ complete: true, exchanges: [], facilities: [] })).toThrow(
      "no download time"
    );
    expect(() => parsePeeringDbSites({ storedAt: 1, complete: true, exchanges: [] })).toThrow(
      "no facilities list"
    );
  });
});

describe("parseCloudRegions", () => {
  it("reads every record of the bundled snapshot", () => {
    const data = parseCloudRegions(snapshot);
    expect(data.rejected).toBe(0);
    expect(data.regions).toHaveLength(snapshot.meta.recordCount);
    expect(data.providers.map((provider) => provider.id)).toEqual(["aws", "gcp", "azure", "cloudflare"]);
    expect(data.sources.length).toBeGreaterThanOrEqual(4);
    const counts = Object.fromEntries(
      data.providers.map((provider) => [
        provider.id,
        data.regions.filter((region) => region.provider === provider.id).length
      ])
    );
    // The metadata counts match the records.
    for (const source of snapshot.meta.sources.slice(0, 3)) {
      const provider = data.providers.find((entry) => source.what.startsWith(entry.name));
      expect(source.recordCount).toBe(counts[provider?.id ?? ""]);
    }
    expect(counts.cloudflare).toBeGreaterThan(300);
    expect(data.regions.find((region) => region.key === "aws:eu-central-1")?.city).toBe("Frankfurt");
  });

  it("matches the hand-curated table: rebuild the snapshot after editing it", () => {
    const data = parseCloudRegions(snapshot);
    const bundled = data.regions.filter((region) => region.provider !== "cloudflare");
    expect(bundled.map((region) => region.key)).toEqual(
      CURATED_REGIONS.map((region) => `${region.provider}:${region.code}`)
    );
    for (const curated of CURATED_PROVIDERS) {
      expect(data.providers.find((provider) => provider.id === curated.id)?.asns).toEqual([...curated.asns]);
    }
    for (const place of CLOUDFLARE_PLACES) {
      expect(data.regions.find((region) => region.key === `cloudflare:${place.code}`)?.latitude).toBe(
        place.latitude
      );
    }
  });

  it("drops regions that are malformed, unknown or not marked approximate", () => {
    const base = snapshot.regions[0];
    const data = parseCloudRegions({
      ...snapshot,
      regions: [
        base,
        { ...base, code: "other-1", provider: "oracle" },
        { ...base, code: "other-2", approximate: false },
        { ...base, code: "other-3", country: "Germany" },
        { ...base, code: "other-4", latitude: "50" },
        base
      ]
    });
    expect(data.regions).toHaveLength(1);
    expect(data.rejected).toBe(5);
  });

  it("refuses a file of another layout or without metadata", () => {
    expect(() =>
      parseCloudRegions({ ...snapshot, meta: { ...snapshot.meta, schema: CLOUD_SNAPSHOT_SCHEMA + 1 } })
    ).toThrow("this version reads layout 1");
    expect(() => parseCloudRegions({ regions: [] })).toThrow("no metadata");
    expect(() => parseCloudRegions({ meta: { schema: 1 }, providers: [] })).toThrow("no regions list");
  });
});

describe("parseSubmarineCables", () => {
  const cable = { id: "2africa", name: "2Africa", segments: [[[1, 2], [3, 4]]] };

  it("reads the backend's compact cable map", () => {
    const data = parseSubmarineCables({ fetchedAt: 5, note: null, cables: [cable] });
    expect(data.cables).toEqual([{ key: "cable:2africa", ...cable }]);
    expect(data.note).toBeNull();
  });

  it("drops cables with a bad line and keeps the note of an old copy", () => {
    const data = parseSubmarineCables({
      fetchedAt: 5,
      note: "A refresh failed; showing the saved copy.",
      cables: [cable, { ...cable, id: "x", segments: [[[1, 2]]] }, { ...cable, id: "y", segments: [[[200, 0], [1, 1]]] }]
    });
    expect(data.cables).toHaveLength(1);
    expect(data.rejected).toBe(2);
    expect(data.note).toContain("refresh failed");
  });

  it("rejects an answer without the expected outer shape", () => {
    expect(() => parseSubmarineCables([])).toThrow("not an object");
    expect(() => parseSubmarineCables({ cables: [] })).toThrow("no download time");
  });
});
