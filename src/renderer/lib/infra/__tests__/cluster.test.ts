import { describe, expect, it } from "vitest";
import { greatCircleKm } from "@renderer/lib/globe";
import {
  CLUSTER_SPACING_PX,
  MAX_CLUSTER_LEVEL,
  cellKmForLevel,
  clusterLevel,
  clusterSites,
  kmPerPixel,
  type ClusterPoint
} from "@renderer/lib/infra/cluster";

const point = (key: string, latitude: number, longitude: number, weight = 1, pinned = false): ClusterPoint => ({
  key,
  latitude,
  longitude,
  weight,
  pinned
});

describe("cluster level", () => {
  it("steps with the ground distance of a pixel, within 1 km and 4,096 km cells", () => {
    expect(clusterLevel(0.001)).toBe(0);
    expect(clusterLevel(1000)).toBe(MAX_CLUSTER_LEVEL);
    expect(clusterLevel(Number.NaN)).toBe(MAX_CLUSTER_LEVEL);
    // 10 km per pixel × 36 px = 360 km: the next power of two is 512 km.
    expect(cellKmForLevel(clusterLevel(10))).toBe(512);
    expect(cellKmForLevel(clusterLevel(10))).toBeGreaterThanOrEqual(10 * CLUSTER_SPACING_PX);
    let previous = -1;
    for (let km = 0.01; km < 200; km *= 1.5) {
      const level = clusterLevel(km);
      expect(level).toBeGreaterThanOrEqual(previous);
      previous = level;
    }
  });

  it("measures a pixel at the centre of a top-down view", () => {
    // 1,000 km up, 60° wide over 1,000 px: 2 × 1,000 × tan(30°) / 1,000 ≈ 1.155 km.
    expect(kmPerPixel(1_000_000, Math.PI / 3, 1000)).toBeCloseTo(1.155, 3);
  });
});

describe("clusterSites", () => {
  it("joins close sites to the most important one and keeps far ones apart", () => {
    const clusters = clusterSites(
      [
        point("small", 50.1, 8.7, 1),
        point("big", 50.12, 8.72, 900),
        point("amsterdam", 52.37, 4.9, 10)
      ],
      100
    );
    expect(clusters.map((c) => [c.key, c.members])).toEqual([
      ["big", ["big", "small"]],
      ["amsterdam", ["amsterdam"]]
    ]);
    // The marker sits at a real site, not at an average.
    expect(clusters[0]).toMatchObject({ latitude: 50.12, longitude: 8.72 });
  });

  it("gives the same clusters for any input order", () => {
    const points = Array.from({ length: 60 }, (_, i) =>
      point(`s${i}`, 48 + (i % 7) * 0.4, 2 + Math.floor(i / 7) * 0.5, i % 5)
    );
    const forward = clusterSites(points, 64);
    const backward = clusterSites([...points].reverse(), 64);
    expect(backward).toEqual(forward);
  });

  it("puts every site in exactly one cluster and keeps seeds a cell apart", () => {
    const points = Array.from({ length: 400 }, (_, i) =>
      point(`s${i}`, Math.sin(i) * 60, ((i * 37) % 360) - 180, (i * 13) % 17)
    );
    const clusters = clusterSites(points, 512);
    const members = clusters.flatMap((c) => c.members).sort();
    expect(members).toEqual(points.map((p) => p.key).sort());
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        expect(greatCircleKm(clusters[i], clusters[j])).toBeGreaterThan(512);
      }
    }
  });

  it("makes sites on the route seeds: they take the sites near them and never join others", () => {
    const clusters = clusterSites(
      [
        point("big", 50.1, 8.7, 900),
        point("route", 50.11, 8.71, 1, true),
        point("near", 50.105, 8.705, 2),
        point("route-2", 50.13, 8.73, 1, true)
      ],
      100
    );
    expect(clusters.map((c) => [c.key, c.pinned, c.members])).toEqual([
      ["route", true, ["route", "big", "near"]],
      ["route-2", true, ["route-2"]]
    ]);
  });

  it("finds every seed within a cell at high latitude, also with large cells", () => {
    // Level 11 (2,048 km) at 70° N: 3.7 columns of longitude are within
    // reach, more than 1 / cos(70°) ≈ 2.9 columns.
    const points = [point("seed", 70, 0, 10), point("far-east", 72, 44)];
    expect(greatCircleKm(points[0], points[1])).toBeLessThan(2048);
    expect(clusterSites(points, 2048)).toHaveLength(1);
    // Around a pole every column is near.
    expect(clusterSites([point("a", 89, 0, 2), point("b", 89, 180)], 300)).toHaveLength(1);
    // Seeds stay a cell apart everywhere, poles included.
    const many = Array.from({ length: 300 }, (_, i) =>
      point(`p${i}`, 90 - (i % 40) * 4.4, ((i * 53) % 360) - 180, (i * 7) % 11)
    );
    const clusters = clusterSites(many, 1024);
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        expect(greatCircleKm(clusters[i], clusters[j])).toBeGreaterThan(1024);
      }
    }
  });

  it("joins sites across the antimeridian and near the poles", () => {
    expect(clusterSites([point("fiji", -17, 179.95, 2), point("east", -17, -179.95)], 32)).toHaveLength(1);
    // At 70° N a degree of longitude is 38 km: 3° apart is about 114 km.
    expect(clusterSites([point("a", 70, 10, 2), point("b", 70, 13)], 128)).toHaveLength(1);
    expect(clusterSites([point("a", 70, 10, 2), point("b", 70, 13)], 64)).toHaveLength(2);
  });
});
