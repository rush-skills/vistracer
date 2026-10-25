import { describe, expect, it } from "vitest";
import type { HopResolution } from "@common/ipc";
import { parseSatelliteGroup } from "@renderer/lib/infra/sources";
import { formatAge, parseSatelliteKey, satelliteCardContent } from "@renderer/lib/satellites/card";
import { MAX_SATELLITES_PER_GROUP, SATELLITE_GROUPS } from "@renderer/lib/satellites/groups";
import {
  GEO_MIN_RTT_MS,
  routeConstellations,
  satelliteLink,
  satelliteLinks
} from "@renderer/lib/satellites/isp";
import { hoveredSatelliteStyle } from "@renderer/lib/globe";
import { planSatelliteGroups } from "@renderer/lib/satellites/reconcile";
import { satelliteDrawing, thinEvenly } from "@renderer/lib/satellites/scene";
import { makeHop } from "@renderer/test/fixtures";
import { VANGUARD_ROW, groupData, starlinkRow } from "@renderer/test/satelliteFixtures";

const hop = (hopIndex: number, asn: number | null, rttMs: number | null, extra: Partial<HopResolution> = {}) => {
  const base = makeHop(hopIndex, `198.51.100.${hopIndex}`, rttMs ?? 10, {
    asn: asn == null ? null : { asn, name: `NET-${asn}` },
    ...extra
  });
  return rttMs == null
    ? { ...base, latency: { minRttMs: null, maxRttMs: null, avgRttMs: null, jitterMs: null } }
    : base;
};

describe("parseSatelliteGroup", () => {
  const raw = (satellites: unknown[], extra: Record<string, unknown> = {}) => ({
    group: "starlink",
    fetchedAt: 1_790_000_000_000,
    source: "https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=csv",
    note: null,
    satellites,
    ...extra
  });

  it("reads the backend's records and keys them by group and NORAD id", () => {
    const data = parseSatelliteGroup(raw([starlinkRow(99902, 10), VANGUARD_ROW]), "starlink");
    expect(data.satellites.map((s) => s.key)).toEqual(["sat|starlink|99902", "sat|starlink|5"]);
    expect(data.satellites[1].epochMs).toBe(Date.UTC(2000, 5, 27, 18, 50, 19, 733.568));
    expect(data).toMatchObject({ group: "starlink", fetchedAt: 1_790_000_000_000, note: null, rejected: 0 });
  });

  it("drops malformed records at the edge and counts them", () => {
    const good = starlinkRow(99902, 10);
    const data = parseSatelliteGroup(
      raw([
        good,
        { ...good, noradId: 0 },
        { ...good, noradId: 99903, name: " " },
        { ...good, noradId: 99904, epoch: "yesterday" },
        { ...good, noradId: 99905, epoch: "2026-10-24T12:00:00Z" },
        { ...good, noradId: 99906, eccentricity: 1 },
        { ...good, noradId: 99907, meanMotion: 0 },
        { ...good, noradId: 99908, inclination: Number.NaN },
        { ...good, noradId: 99909, raan: "120" },
        { ...good, noradId: 99910, objectId: null },
        "not a record",
        { ...good }
      ]),
      "starlink"
    );
    expect(data.satellites.map((s) => s.noradId)).toEqual([99902]);
    // 10 bad records and one duplicate.
    expect(data.rejected).toBe(11);
  });

  it("rejects an answer of another group or without the expected shape", () => {
    expect(() => parseSatelliteGroup("x", "starlink")).toThrow("not an object");
    expect(() => parseSatelliteGroup(raw([]), "gps")).toThrow("not gps");
    expect(() => parseSatelliteGroup(raw([], { fetchedAt: "now" }), "starlink")).toThrow(
      "no download time"
    );
    expect(() => parseSatelliteGroup(raw([], { satellites: undefined }), "starlink")).toThrow(
      "no satellites list"
    );
    // The GPS group is "gps-ops" at CelesTrak.
    expect(parseSatelliteGroup(raw([], { group: "gps-ops" }), "gps").satellites).toEqual([]);
  });
});

describe("satelliteLink (satellite internet providers on the route)", () => {
  it("marks a Starlink hop as a likely satellite link with medium confidence", () => {
    const link = satelliteLink(hop(2, 14593, 32));
    expect(link).toMatchObject({ hopIndex: 2, confidence: "medium", isp: { name: "Starlink", group: "starlink" } });
    expect(link?.reason).toContain("AS14593 is SpaceX's Starlink network");
    expect(link?.reason).toContain("does not show which link is in space");
    expect(satelliteLink(hop(3, 800, 40))?.isp.group).toBe("oneweb");
  });

  it("checks a geostationary provider's hop against the 477 ms a GEO link takes", () => {
    const slow = satelliteLink(hop(2, 7155, 612));
    expect(slow?.confidence).toBe("high");
    expect(slow?.reason).toContain("612 ms");
    const fast = satelliteLink(hop(2, 6621, 35));
    expect(fast?.confidence).toBe("low");
    expect(fast?.reason).toContain("too short");
    expect(satelliteLink(hop(2, 29286, null))?.confidence).toBe("medium");
    expect(GEO_MIN_RTT_MS).toBeLessThan(477);
  });

  it("ignores other networks, hops without an ASN and private addresses", () => {
    expect(satelliteLink(hop(1, 3356, 10))).toBeNull();
    expect(satelliteLink(hop(1, null, 10))).toBeNull();
    expect(satelliteLink(hop(1, 14593, 10, { isPrivate: true }))).toBeNull();
  });

  it("highlights the groups of likely links only", () => {
    const links = satelliteLinks([hop(1, null, 1), hop(2, 14593, 30), hop(3, 6621, 40), hop(4, 3356, 50)]);
    expect([...links.keys()]).toEqual([2, 3]);
    // The HughesNet hop is too fast for a GEO link before it: no highlight.
    expect(routeConstellations(links)).toEqual(new Set(["starlink"]));
  });
});

describe("satelliteDrawing", () => {
  it("draws each shown group with its style and keeps the satellites array for the same data", () => {
    const starlink = groupData("starlink", [starlinkRow(1, 0), starlinkRow(2, 90)]);
    const gps = groupData("gps", [VANGUARD_ROW]);
    const first = satelliteDrawing([starlink, gps], new Set());
    const again = satelliteDrawing([starlink, gps], new Set(["starlink"]));
    expect(first.map((g) => g.group)).toEqual(["starlink", "gps"]);
    expect(again[0].satellites).toBe(first[0].satellites);
    expect(first[0]).toMatchObject({
      color: SATELLITE_GROUPS.starlink.color,
      pixelSize: SATELLITE_GROUPS.starlink.pixelSize,
      opacity: 0.8,
      highlighted: false
    });
    // The constellation the route uses: opaque and larger.
    expect(again[0]).toMatchObject({ opacity: 1, pixelSize: SATELLITE_GROUPS.starlink.pixelSize + 2, highlighted: true });
    expect(hoveredSatelliteStyle(first[1]).pixelSize).toBe(first[1].pixelSize + 4);
  });

  it("thins a group above the limit evenly", () => {
    const many = Array.from({ length: 30 }, (_, i) => i);
    expect(thinEvenly(many, 10)).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24, 27]);
    expect(thinEvenly(many, 40)).toBe(many);
    const big = groupData(
      "starlink",
      Array.from({ length: MAX_SATELLITES_PER_GROUP + 500 }, (_, i) => starlinkRow(i + 1, i % 360))
    );
    expect(satelliteDrawing([big], new Set())[0].satellites).toHaveLength(MAX_SATELLITES_PER_GROUP);
  });

  it("keeps the satellite colours visible on the dark globe (3:1)", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    // Space, the dark ocean and the night side (as for the network colours).
    for (const backdrop of ["#0D0E14", "#0A2246", "#000000"]) {
      for (const group of Object.values(SATELLITE_GROUPS)) {
        // Drawn at 0.8 opacity: the colour mixed with the backdrop.
        const mixed =
          "#" +
          [1, 3, 5]
            .map((i) =>
              Math.round(
                0.8 * parseInt(group.color.slice(i, i + 2), 16) + 0.2 * parseInt(backdrop.slice(i, i + 2), 16)
              )
                .toString(16)
                .padStart(2, "0")
            )
            .join("");
        const ratio = (luminance(mixed) + 0.05) / (luminance(backdrop) + 0.05);
        expect(ratio, `${group.id} on ${backdrop}`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("planSatelliteGroups (the adapter's point collections)", () => {
  it("keeps a group with the same satellites, rebuilds a changed one and removes a gone one", () => {
    const starlink = groupData("starlink", [starlinkRow(1, 0), starlinkRow(2, 90)]);
    const gps = groupData("gps", [VANGUARD_ROW]);
    const first = satelliteDrawing([starlink, gps], new Set());
    const drawn = new Map(first.map((group) => [group.group, group.satellites]));

    // The route's highlight and GPS switched off: Starlink keeps its points.
    const highlighted = satelliteDrawing([starlink], new Set(["starlink"]));
    expect(planSatelliteGroups(drawn, highlighted)).toEqual({
      remove: ["gps"],
      keep: highlighted,
      build: []
    });
    // A newer download: Starlink is rebuilt, GPS kept.
    const newer = satelliteDrawing([groupData("starlink", [starlinkRow(3, 0)]), gps], new Set());
    const plan = planSatelliteGroups(drawn, newer);
    expect(plan.remove).toEqual(["starlink"]);
    expect(plan.keep.map((group) => group.group)).toEqual(["gps"]);
    expect(plan.build.map((group) => group.group)).toEqual(["starlink"]);
    // Nothing drawn yet: everything is built.
    expect(planSatelliteGroups(new Map(), first).build).toEqual(first);
  });
});

describe("satelliteCardContent", () => {
  const now = Date.parse("2026-10-25T02:00:00Z");
  const starlink = groupData("starlink", [starlinkRow(99902, 10)]);

  it("names the satellite, its NORAD id, height and the age of its elements", () => {
    const card = satelliteCardContent(
      { keys: ["sat|starlink|99902"], heightKm: 548.4 },
      { starlink },
      new Map(),
      now
    );
    expect(card).toEqual({
      title: "EXAMPLE STARLINK-99902",
      lines: [
        "Starlink · NORAD 99902 · 2098-001A",
        "Altitude 548 km",
        "Orbital elements from 14 hours ago (CelesTrak); the position is an SGP4 estimate."
      ],
      route: [],
      more: null
    });
  });

  it("says when the route has a likely link of the satellite's constellation", () => {
    const links = satelliteLinks([hop(2, 14593, 30)]);
    const card = satelliteCardContent({ keys: ["sat|starlink|99902"] }, { starlink }, links, now);
    expect(card?.route).toEqual(["Hop 2 (AS14593) is likely a Starlink link (medium confidence)."]);
    expect(card?.lines).toHaveLength(2);
  });

  it("has nothing for an unknown key or a group without data", () => {
    expect(satelliteCardContent({ keys: ["sat|starlink|1"] }, { starlink }, new Map(), now)).toBeNull();
    expect(satelliteCardContent({ keys: ["sat|gps|99902"] }, { starlink }, new Map(), now)).toBeNull();
    expect(parseSatelliteKey("sat|moon|1")).toBeNull();
    expect(parseSatelliteKey("facilities|fac:1")).toBeNull();
    expect(parseSatelliteKey("sat|geo|100001")).toEqual({ group: "geo", noradId: 100001 });
  });

  it("formats the age of the elements", () => {
    expect([0.5, 1, 14.4, 47, 72].map((h) => formatAge(h * 3_600_000))).toEqual([
      "under an hour",
      "1 hour",
      "14 hours",
      "47 hours",
      "3 days"
    ]);
  });
});
