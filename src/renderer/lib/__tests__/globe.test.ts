import { describe, expect, it } from "vitest";
import { Vector3 } from "three";
import {
  MAX_RING_RADIUS_KM,
  RING_STYLES,
  buildArcDescriptors,
  buildConfidenceRings,
  circlePoints,
  hopIndexToColor,
  latencyToColor,
  latLngToVector3
} from "@renderer/lib/globe";
import type { HopLocation, HopResolution, LocationConfidence } from "@common/ipc";

const noLocation: HopLocation = {
  best: null,
  alternatives: [],
  ixp: null,
  hostnameHint: null,
  anycast: null,
  isRttReference: false
};

const at = (
  latitude: number,
  longitude: number,
  confidence: LocationConfidence = "high",
  radiusKm = 50
): HopLocation => ({
  ...noLocation,
  best: {
    source: "hostname-hint",
    latitude,
    longitude,
    radiusKm,
    confidence,
    label: "Somewhere",
    rtt: null
  }
});

const baseHop = (overrides: Partial<HopResolution>): HopResolution => ({
  hopIndex: 1,
  ipAddress: "1.1.1.1",
  hostName: "test",
  lossPercent: 0,
  latency: { minRttMs: 10, maxRttMs: 12, avgRttMs: 11, jitterMs: 2 },
  geo: { latitude: 0, longitude: 0 },
  asn: undefined,
  isPrivate: false,
  location: at(0, 0),
  rawLine: "",
  responders: [],
  lookupState: "complete",
  ...overrides
});

/** Great-circle distance in km between the ring centre and a ring point. */
const surfaceKm = (centre: Vector3, point: Vector3) =>
  centre.clone().normalize().angleTo(point.clone().normalize()) * 6371;

describe("latencyToColor", () => {
  it("maps low latency to success colour", () => {
    expect(latencyToColor(25)).toBe("#4bd67f");
  });

  it("maps mid latency to warning colour", () => {
    expect(latencyToColor(120)).toBe("#ffc773");
  });

  it("maps high latency to danger colour", () => {
    expect(latencyToColor(250)).toBe("#ff5f5f");
  });

  it("handles missing latency gracefully", () => {
    expect(latencyToColor(null)).toBe("#4F5D75");
  });
});

describe("buildArcDescriptors", () => {
  it("skips hops without a best estimate", () => {
    const hops: HopResolution[] = [
      baseHop({ hopIndex: 1, location: noLocation }),
      baseHop({ hopIndex: 2, location: at(10, 10) })
    ];

    expect(buildArcDescriptors(hops)).toHaveLength(0);
  });

  it("builds arcs between consecutive located hops", () => {
    const hops: HopResolution[] = [
      baseHop({ hopIndex: 1, location: at(0, 0) }),
      baseHop({ hopIndex: 2, location: at(10, 20) }),
      baseHop({ hopIndex: 3, location: at(30, 40) })
    ];

    const arcs = buildArcDescriptors(hops);
    expect(arcs).toHaveLength(2);
    expect(arcs[0].id).toBe("1-2");
    expect(arcs[0].points.length).toBeGreaterThan(10);
  });

  it("does not draw an anycast hop even when GeoLite2 has a record", () => {
    const anycast: HopLocation = {
      ...noLocation,
      anycast: {
        evidence: "known-prefix",
        service: "Google Public DNS",
        geoliteRuledOut: true,
        maxDistanceKm: 740,
        referenceHopIndex: 1
      }
    };
    const hops = [
      baseHop({ hopIndex: 1, location: at(19, 72) }),
      baseHop({ hopIndex: 2, location: anycast, geo: { latitude: 37.7, longitude: -97.8 } })
    ];
    expect(buildArcDescriptors(hops)).toHaveLength(0);
    expect(buildConfidenceRings(hops)).toHaveLength(1);
  });
});

describe("confidence rings", () => {
  it("places every ring point at the radius, on the surface", () => {
    const centre = latLngToVector3(50.11, 8.68, 1);
    const points = circlePoints(50.11, 8.68, 111, 32, 5.03);
    expect(points).toHaveLength(33);
    for (const point of points) {
      expect(point.length()).toBeCloseTo(5.03, 6);
      expect(surfaceKm(centre, point)).toBeCloseTo(111, 3);
    }
    // Near the pole the basis must not collapse.
    const polar = circlePoints(89.99, 0, 500, 16);
    expect(polar.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z))).toBe(true);
  });

  it("scales rings to km and styles them by confidence", () => {
    const hops = [
      baseHop({ hopIndex: 1, location: at(50.1, 8.7, "high", 25) }),
      baseHop({ hopIndex: 2, location: at(52.4, 4.9, "medium", 200) }),
      baseHop({ hopIndex: 3, location: at(20.6, 79, "low", 1000) })
    ];
    const rings = buildConfidenceRings(hops);
    expect(rings.map((r) => [r.hopIndex, r.radiusKm, r.confidence])).toEqual([
      [1, 25, "high"],
      [2, 200, "medium"],
      [3, 1000, "low"]
    ]);
    expect(rings[0]).toMatchObject({ ...RING_STYLES.high, color: hopIndexToColor(1) });
    expect(rings[1]).toMatchObject(RING_STYLES.medium);
    expect(rings[2]).toMatchObject(RING_STYLES.low);
    expect(RING_STYLES.high.dashed).toBe(false);
    expect(RING_STYLES.low.dashed).toBe(true);
    expect(RING_STYLES.high.opacity).toBeGreaterThan(RING_STYLES.medium.opacity);
    expect(RING_STYLES.medium.opacity).toBeGreaterThan(RING_STYLES.low.opacity);

    const centre = latLngToVector3(52.4, 4.9, 1);
    expect(surfaceKm(centre, rings[1].points[7])).toBeCloseTo(200, 3);
  });

  it("draws a conflicting estimate with the low-confidence style", () => {
    const location = at(28.6, 77.2, "high", 50);
    const best = location.best;
    if (!best) throw new Error("fixture has a best estimate");
    const conflicting: HopLocation = {
      ...location,
      best: {
        ...best,
        rtt: {
          verdict: "conflict",
          distanceKm: 1139,
          maxDistanceKm: 840,
          originalRadiusKm: 50,
          referenceHopIndex: 1,
          referenceSource: "geolite-city",
          boundHopIndex: 2,
          boundRttMs: 5
        }
      }
    };
    const [ring] = buildConfidenceRings([baseHop({ hopIndex: 2, location: conflicting })]);
    expect(ring.confidence).toBe("high");
    expect(ring.radiusKm).toBe(50);
    expect(ring).toMatchObject(RING_STYLES.low);
  });

  it("emphasises the selected hop and skips useless or missing radii", () => {
    const hops = [
      baseHop({ hopIndex: 1, location: at(0, 0, "medium", 100) }),
      baseHop({ hopIndex: 2, location: at(0, 10, "low", MAX_RING_RADIUS_KM + 1) }),
      baseHop({ hopIndex: 3, location: at(0, 20, "high", 0) }),
      baseHop({ hopIndex: 4, location: noLocation })
    ];
    const rings = buildConfidenceRings(hops, 1);
    expect(rings.map((r) => r.hopIndex)).toEqual([1]);
    expect(rings[0].opacity).toBe(1);
    expect(rings[0].lineWidth).toBeGreaterThan(RING_STYLES.medium.lineWidth);
  });
});

describe("latLngToVector3", () => {
  it("maps latitude/longitude to 3D coordinates", () => {
    const vector = latLngToVector3(0, 0, 5);
    expect(vector.length()).toBeCloseTo(5, 5);
  });
});
