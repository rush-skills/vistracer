import { describe, expect, it } from "vitest";
import { buildArcDescriptors, latencyToColor, latLngToVector3 } from "@renderer/lib/globe";
import type { HopResolution } from "@common/ipc";

const baseHop = (overrides: Partial<HopResolution>): HopResolution => ({
  hopIndex: 1,
  ipAddress: "1.1.1.1",
  hostName: "test",
  lossPercent: 0,
  latency: { minRttMs: 10, maxRttMs: 12, avgRttMs: 11, jitterMs: 2 },
  geo: { latitude: 0, longitude: 0 },
  asn: undefined,
  isPrivate: false,
  isAnycastSuspected: false,
  rawLine: "",
  ...overrides
});

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
  it("skips hops without geodata", () => {
    const hops: HopResolution[] = [
      baseHop({ hopIndex: 1, geo: undefined }),
      baseHop({ hopIndex: 2, geo: { latitude: 10, longitude: 10 } })
    ];

    expect(buildArcDescriptors(hops)).toHaveLength(0);
  });

  it("builds arcs between consecutive geolocated hops", () => {
    const hops: HopResolution[] = [
      baseHop({ hopIndex: 1, geo: { latitude: 0, longitude: 0 } }),
      baseHop({ hopIndex: 2, geo: { latitude: 10, longitude: 20 } }),
      baseHop({ hopIndex: 3, geo: { latitude: 30, longitude: 40 } })
    ];

    const arcs = buildArcDescriptors(hops);
    expect(arcs).toHaveLength(2);
    expect(arcs[0].id).toBe("1-2");
    expect(arcs[0].points.length).toBeGreaterThan(10);
  });
});

describe("latLngToVector3", () => {
  it("maps latitude/longitude to 3D coordinates", () => {
    const vector = latLngToVector3(0, 0, 5);
    expect(vector.length()).toBeCloseTo(5, 5);
  });
});
