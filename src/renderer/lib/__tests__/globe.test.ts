import { describe, expect, it } from "vitest";
import {
  CAMERA_LIMITS,
  INITIAL_CAMERA_TRACKER,
  MAX_RING_RADIUS_KM,
  RING_STYLES,
  arcPositions,
  borderRings,
  buildArcs,
  buildGlobeScene,
  buildMarkers,
  buildRings,
  circlePositions,
  flyHeight,
  framedTarget,
  kmPerPixel,
  greatCircleKm,
  hopIndexToColor,
  latencyToColor,
  nextCameraFocus,
  planFlight,
  type CameraPosition
} from "@renderer/lib/globe";
import { bundledOnlyHeight } from "@renderer/lib/imagery";
import { ASN_PALETTE, UNKNOWN_ASN_COLOR } from "@renderer/lib/infra/asnColors";
import type { AnycastInfo, HopLocation, HopResolution, LocationConfidence } from "@common/ipc";

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
  radiusKm = 50,
  label = "Somewhere"
): HopLocation => ({
  ...noLocation,
  best: {
    source: "hostname-hint",
    latitude,
    longitude,
    radiusKm,
    confidence,
    label,
    rtt: null
  }
});

const anycastAt = (overrides: Partial<AnycastInfo> = {}): HopLocation => ({
  ...noLocation,
  anycast: {
    evidence: "known-prefix",
    service: "Google Public DNS",
    geoliteRuledOut: true,
    maxDistanceKm: 740,
    referenceHopIndex: 1,
    ...overrides
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

const FRANKFURT = { latitude: 50.11, longitude: 8.68 };
const NEW_YORK = { latitude: 40.71, longitude: -74.01 };

describe("latencyToColor", () => {
  it("maps latency bands to colours", () => {
    expect(latencyToColor(25)).toBe("#4bd67f");
    expect(latencyToColor(120)).toBe("#ffc773");
    expect(latencyToColor(250)).toBe("#ff5f5f");
    expect(latencyToColor(null)).toBe("#4F5D75");
  });
});

describe("greatCircleKm", () => {
  it("measures known distances", () => {
    expect(greatCircleKm(FRANKFURT, NEW_YORK)).toBeCloseTo(6205, -1);
    expect(
      greatCircleKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 })
    ).toBeCloseTo(Math.PI * 6371, 3);
  });
});

describe("arcs", () => {
  it("skips hops without a best estimate and hops at the same place", () => {
    const hops = [
      baseHop({ hopIndex: 1, location: noLocation }),
      baseHop({ hopIndex: 2, location: at(10, 10) }),
      baseHop({ hopIndex: 3, location: at(10, 10) })
    ];
    expect(buildArcs(hops)).toHaveLength(0);
  });

  it("connects consecutive located hops across a gap, coloured by latency", () => {
    const hops = [
      baseHop({ hopIndex: 1, location: at(FRANKFURT.latitude, FRANKFURT.longitude) }),
      baseHop({ hopIndex: 2, location: noLocation }),
      baseHop({
        hopIndex: 3,
        location: at(NEW_YORK.latitude, NEW_YORK.longitude),
        latency: { minRttMs: 90, maxRttMs: 95, avgRttMs: 92, jitterMs: 1 }
      }),
      baseHop({ hopIndex: 4, location: at(34.05, -118.24) })
    ];
    const arcs = buildArcs(hops);
    expect(arcs.map((arc) => [arc.fromHopIndex, arc.toHopIndex])).toEqual([
      [1, 3],
      [3, 4]
    ]);
    expect(arcs[0].color).toBe(latencyToColor(11));
    expect(arcs[1].color).toBe(latencyToColor(92));
  });

  it("follows the great circle, starts and ends on the hops and rises in the middle", () => {
    const points = arcPositions(FRANKFURT, NEW_YORK);
    const first = points[0];
    const last = points[points.length - 1];
    expect(greatCircleKm(first, FRANKFURT)).toBeLessThan(0.01);
    expect(greatCircleKm(last, NEW_YORK)).toBeLessThan(0.01);
    expect(first.height).toBeCloseTo(0, 6);
    expect(last.height).toBeCloseTo(0, 6);
    // Every point lies on the great circle: the two legs add up.
    const total = greatCircleKm(FRANKFURT, NEW_YORK);
    for (const point of points) {
      expect(greatCircleKm(FRANKFURT, point) + greatCircleKm(point, NEW_YORK)).toBeCloseTo(
        total,
        3
      );
    }
    const peak = Math.max(...points.map((point) => point.height));
    expect(peak).toBeCloseTo(total * 1000 * 0.12, -3);
    // The great circle from Frankfurt to New York passes north of both.
    expect(Math.max(...points.map((point) => point.latitude))).toBeGreaterThan(51);
  });

  it("keeps short hops visible and long hops below the cap", () => {
    const short = arcPositions(FRANKFURT, { latitude: 50.2, longitude: 8.7 });
    expect(Math.max(...short.map((point) => point.height))).toBeCloseTo(2000, 0);
    const long = arcPositions({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 170 });
    expect(Math.max(...long.map((point) => point.height))).toBeLessThanOrEqual(1_500_000);
  });

  it("does not break on the same point or antipodal points", () => {
    for (const points of [
      arcPositions(FRANKFURT, FRANKFURT),
      arcPositions({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 })
    ]) {
      expect(points.every((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))).toBe(
        true
      );
    }
  });
});

describe("confidence rings", () => {
  it("places every ring point at the radius on the surface and closes the ring", () => {
    const points = circlePositions(FRANKFURT.latitude, FRANKFURT.longitude, 111);
    expect(points.length).toBeGreaterThanOrEqual(49);
    expect(points[0]).toEqual(points[points.length - 1]);
    for (const point of points) {
      expect(point.height).toBe(0);
      expect(greatCircleKm(FRANKFURT, point)).toBeCloseTo(111, 6);
    }
  });

  it("keeps large rings round and works at the pole and the antimeridian", () => {
    const large = circlePositions(0, 0, 4000);
    expect(large.length).toBeGreaterThan(400);
    const polar = circlePositions(89.99, 0, 500);
    expect(polar.every((p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude))).toBe(
      true
    );
    const dateLine = circlePositions(0, 179.9, 300);
    expect(dateLine.every((p) => p.longitude >= -180 && p.longitude <= 180)).toBe(true);
    expect(
      dateLine.every(
        (p) => Math.abs(greatCircleKm({ latitude: 0, longitude: 179.9 }, p) - 300) < 1e-6
      )
    ).toBe(true);
  });

  it("scales rings to km and styles them by confidence", () => {
    const hops = [
      baseHop({ hopIndex: 1, location: at(50.1, 8.7, "high", 25) }),
      baseHop({ hopIndex: 2, location: at(52.4, 4.9, "medium", 200) }),
      baseHop({ hopIndex: 3, location: at(20.6, 79, "low", 1000) })
    ];
    const rings = buildRings(hops);
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
    expect(greatCircleKm({ latitude: 52.4, longitude: 4.9 }, rings[1].positions[7])).toBeCloseTo(
      200,
      6
    );
  });

  it("draws a conflicting estimate with the low-confidence style", () => {
    const location = at(28.6, 77.2, "high", 50);
    if (!location.best) throw new Error("fixture has a best estimate");
    const conflicting: HopLocation = {
      ...location,
      best: {
        ...location.best,
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
    const [ring] = buildRings([baseHop({ hopIndex: 2, location: conflicting })]);
    expect(ring.confidence).toBe("high");
    expect(ring.radiusKm).toBe(50);
    expect(ring).toMatchObject(RING_STYLES.low);
  });

  it("emphasises the selected and hovered hop and skips useless or missing radii", () => {
    const hops = [
      baseHop({ hopIndex: 1, location: at(0, 0, "medium", 100) }),
      baseHop({ hopIndex: 2, location: at(0, 10, "low", MAX_RING_RADIUS_KM + 1) }),
      baseHop({ hopIndex: 3, location: at(0, 20, "high", 0) }),
      baseHop({ hopIndex: 4, location: noLocation }),
      baseHop({ hopIndex: 5, location: at(0, 30, "low", 300) }),
      baseHop({ hopIndex: 6, location: at(0, 40, "low", 300) })
    ];
    const rings = buildRings(hops, 1, 5);
    expect(rings.map((r) => r.hopIndex)).toEqual([1, 5, 6]);
    expect(rings[0]).toMatchObject({ opacity: 1, lineWidth: RING_STYLES.medium.lineWidth + 1 });
    expect(rings[1]).toMatchObject({ opacity: 1, lineWidth: RING_STYLES.low.lineWidth + 1 });
    expect(rings[2]).toMatchObject(RING_STYLES.low);
  });
});

describe("markers and labels", () => {
  it("draws one marker per located hop with the selected and hovered hops on top", () => {
    const hops = [1, 2, 3, 4].map((hopIndex) =>
      baseHop({ hopIndex, location: hopIndex === 4 ? noLocation : at(hopIndex, hopIndex) })
    );
    const markers = buildMarkers(hops, 1, 2);
    expect(markers.map((m) => [m.hopIndex, m.emphasis])).toEqual([
      [3, "normal"],
      [2, "hovered"],
      [1, "selected"]
    ]);
    expect(markers[0]).toMatchObject({
      color: hopIndexToColor(3),
      position: { latitude: 3, longitude: 3, height: 0 }
    });
  });

  it("labels the selected and the hovered hop with its place", () => {
    const hops = [
      baseHop({ hopIndex: 1, location: at(50.1, 8.7, "high", 25, "Frankfurt, DE") }),
      baseHop({ hopIndex: 2, location: at(52.4, 4.9, "high", 25, "Amsterdam, NL") }),
      baseHop({ hopIndex: 3, location: noLocation })
    ];
    const scene = buildGlobeScene(hops, 1, 2);
    expect(scene.labels.map((label) => label.text)).toEqual([
      "1 · Frankfurt, DE",
      "2 · Amsterdam, NL"
    ]);
    expect(buildGlobeScene(hops, 3).labels).toEqual([]);
    expect(buildGlobeScene(hops, 1, 1).labels).toHaveLength(1);
  });
});

describe("anycast hops", () => {
  const hops = [
    baseHop({ hopIndex: 1, location: at(19.08, 72.88, "medium", 20, "Mumbai, IN") }),
    baseHop({ hopIndex: 2, location: anycastAt(), geo: { latitude: 37.75, longitude: -97.82 } })
  ];

  it("get no marker, ring or arc, even when GeoLite2 has a record", () => {
    const scene = buildGlobeScene(hops);
    expect(scene.markers.map((m) => m.hopIndex)).toEqual([1]);
    expect(scene.rings.map((r) => r.hopIndex)).toEqual([1]);
    expect(scene.arcs).toEqual([]);
  });

  it("show the RTT reach around the reference hop instead of a point", () => {
    const [reach] = buildGlobeScene(hops).reaches;
    expect(reach).toMatchObject({ hopIndex: 2, referenceHopIndex: 1, radiusKm: 740, opacity: 0.5 });
    for (const point of reach.positions) {
      expect(greatCircleKm({ latitude: 19.08, longitude: 72.88 }, point)).toBeCloseTo(740, 6);
    }
    const selected = buildGlobeScene(hops, 2);
    expect(selected.reaches[0].opacity).toBeGreaterThan(0.5);
    expect(selected.labels).toEqual([
      expect.objectContaining({
        hopIndex: 2,
        text: "2 · anycast (Google Public DNS), within 740 km of hop 1",
        position: selected.reaches[0].positions[0]
      })
    ]);
  });

  it("show nothing when the bound or the reference location is missing", () => {
    for (const location of [
      anycastAt({ maxDistanceKm: null }),
      anycastAt({ referenceHopIndex: null }),
      anycastAt({ referenceHopIndex: 9 })
    ]) {
      expect(buildGlobeScene([hops[0], baseHop({ hopIndex: 2, location })]).reaches).toEqual([]);
    }
  });
});

describe("camera", () => {
  const hop = (hopIndex: number, located = true) =>
    baseHop({
      hopIndex,
      location: located ? at(hopIndex * 5, hopIndex * 5, "high", 30) : noLocation
    });

  it("flies to each hop that gets a location during a run, and not on enrichment updates", () => {
    let step = nextCameraFocus(INITIAL_CAMERA_TRACKER, "run-a", [hop(1, false)], undefined);
    expect(step.focus).toBeNull();
    step = nextCameraFocus(step.tracker, "run-a", [hop(1, false), hop(2)], undefined);
    expect(step.focus).toEqual({ latitude: 10, longitude: 10, radiusKm: 30 });
    step = nextCameraFocus(step.tracker, "run-a", [hop(1, false), hop(2)], undefined);
    expect(step.focus).toBeNull();
  });

  it("flies to a newly selected hop, including an anycast hop's reach", () => {
    const hops = [hop(1), hop(2), baseHop({ hopIndex: 3, location: anycastAt() })];
    let step = nextCameraFocus(INITIAL_CAMERA_TRACKER, "run-a", hops, 1);
    expect(step.focus).toEqual({ latitude: 5, longitude: 5, radiusKm: 30 });
    step = nextCameraFocus(step.tracker, "run-a", hops, 1);
    expect(step.focus).toBeNull();
    step = nextCameraFocus(step.tracker, "run-a", hops, 3);
    expect(step.focus).toEqual({ latitude: 5, longitude: 5, radiusKm: 740 });
  });

  it("starts over for a new run", () => {
    const first = nextCameraFocus(INITIAL_CAMERA_TRACKER, "run-a", [hop(1)], 1);
    const next = nextCameraFocus(first.tracker, "run-b", [hop(1)], 1);
    expect(next.focus).toEqual({ latitude: 5, longitude: 5, radiusKm: 30 });
  });

  it("keeps the zoom but fits the ring and stays above the floor", () => {
    expect(flyHeight(5_000_000, 25, 0)).toBe(5_000_000);
    expect(flyHeight(200_000, 1000, 0)).toBe(4_000_000);
    expect(flyHeight(1_000, 1, 0)).toBe(CAMERA_LIMITS.minHeight);
    expect(flyHeight(90_000_000, 1, 0)).toBe(CAMERA_LIMITS.maxHeight);
    expect(flyHeight(200_000, 25, 3_000_000)).toBe(3_000_000);
  });
});

describe("automatic camera moves use only bundled imagery", () => {
  // Cesium 1.146 EllipsoidTerrainProvider: level 0 error is
  // R × 2π × 0.25 / (64 × 2); each level halves it. Online tiles start at
  // terrain level 5, so level 4 must not be refined.
  const LEVEL_4_ERROR_M = (6_378_137 * 2 * Math.PI * 0.25) / (64 * 2) / 16;
  const VIEW_PX = 1920;
  const FOV = Math.PI / 3;
  const floor = bundledOnlyHeight({
    levelGeometricErrorM: LEVEL_4_ERROR_M,
    viewportPx: VIEW_PX,
    fovRad: FOV,
    maximumScreenSpaceError: 2
  });
  /** QuadtreePrimitive `screenSpaceError` of the level 4 tile under a camera looking down. */
  const levelFourError = (heightM: number) =>
    (LEVEL_4_ERROR_M * VIEW_PX) / (heightM * 2 * Math.tan(FOV / 2));

  it("puts the floor where Cesium stops refining the last bundled level", () => {
    expect(levelFourError(floor)).toBeLessThan(2);
    expect(levelFourError(floor / 1.2)).toBeGreaterThan(2);
    expect(floor / 1000).toBeCloseTo(4_680, -1);
  });

  it("rises over the user's zoomed-in view before it moves to a hop", () => {
    const zoomedIn = { latitude: 19.08, longitude: 72.88, height: 300_000 };
    const steps = planFlight(zoomedIn, { latitude: 50.11, longitude: 8.68, radiusKm: 25 }, floor);
    expect(steps).toEqual([
      { kind: "rise", latitude: 19.08, longitude: 72.88, height: floor },
      { kind: "move", latitude: 50.11, longitude: 8.68, height: floor }
    ]);
  });

  it("keeps the user's height when it is above the floor", () => {
    const far = { latitude: 0, longitude: 0, height: 14_000_000 };
    expect(planFlight(far, { latitude: 50, longitude: 8, radiusKm: 25 }, floor)).toEqual([
      { kind: "move", latitude: 50, longitude: 8, height: 14_000_000 }
    ]);
  });

  // The app passes a frame for the panels (here 960 × 640 with the hop
  // pane, the timeline and the trace panel): the floor must hold as well.
  const PANELS = {
    insets: { top: 80, right: 348, bottom: 200, left: 0 },
    widthPx: 960,
    heightPx: 640,
    fovRad: FOV
  };

  it.each([
    ["without a frame", undefined],
    ["framed in the free area", PANELS]
  ] as const)(
    "follows a whole trace from a zoomed-in view without crossing new ground below the floor (%s)",
    (_name, frame) => {
      const route: Array<[number, number]> = [
        [19.08, 72.88],
        [13.08, 80.27],
        [43.3, 5.37],
        [50.11, 8.68],
        [51.51, -0.13],
        [40.71, -74.01]
      ];
      let position: CameraPosition = { latitude: 19.0, longitude: 72.8, height: 250_000 };
      let tracker = INITIAL_CAMERA_TRACKER;
      const hops: HopResolution[] = [];
      let moves = 0;
      route.forEach(([latitude, longitude], index) => {
        const hopIndex = index + 1;
        hops.push(baseHop({ hopIndex, location: at(latitude, longitude, "high", 30) }));
        // The store selects each new hop during a run.
        const next = nextCameraFocus(tracker, "run", [...hops], hopIndex);
        tracker = next.tracker;
        if (!next.focus) {
          return;
        }
        for (const step of planFlight(position, next.focus, floor, frame)) {
          if (step.kind === "move") {
            moves += 1;
            // Cesium interpolates the height of a flat flight between both ends.
            expect(Math.min(position.height, step.height)).toBeGreaterThanOrEqual(floor);
            expect(levelFourError(step.height)).toBeLessThan(2);
          } else {
            expect([step.latitude, step.longitude]).toEqual([
              position.latitude,
              position.longitude
            ]);
          }
          position = step;
        }
      });
      expect(moves).toBe(route.length);
    }
  );
});

describe("network colours", () => {
  const hop = (hopIndex: number, latitude: number, longitude: number, asn?: number) =>
    baseHop({
      hopIndex,
      ipAddress: `198.51.100.${hopIndex}`,
      asn: asn == null ? null : { asn, name: `AS-${asn}` },
      location: at(latitude, longitude)
    });
  const hops = [
    hop(1, 19.08, 72.88, 9498),
    hop(2, 13.08, 80.27, 9498),
    hop(3, 43.3, 5.37, 6453),
    hop(4, 50.11, 8.68)
  ];

  it("colours markers and rings by network, and hops without an ASN in grey", () => {
    const scene = buildGlobeScene(hops, undefined, undefined, { asnColors: true });
    const color = (hopIndex: number) => scene.markers.find((m) => m.hopIndex === hopIndex)?.color;
    expect(color(1)).toBe(color(2));
    expect(color(3)).not.toBe(color(1));
    expect(color(4)).toBe(UNKNOWN_ASN_COLOR);
    expect(ASN_PALETTE).toContain(color(1));
    expect(scene.rings.find((r) => r.hopIndex === 3)?.color).toBe(color(3));
  });

  it("splits an arc between two networks where the route hands over", () => {
    const arcs = buildGlobeScene(hops, undefined, undefined, { asnColors: true }).arcs;
    // 1→2 stays in one network: one arc; 2→3 and 3→4 change network: two halves each.
    expect(arcs.map((arc) => [arc.fromHopIndex, arc.toHopIndex])).toEqual([
      [1, 2],
      [2, 3],
      [2, 3],
      [3, 4],
      [3, 4]
    ]);
    const [first, second] = arcs.filter((arc) => arc.fromHopIndex === 2);
    expect(first.positions.at(-1)).toEqual(second.positions[0]);
    expect(first.color).not.toBe(second.color);
  });

  it("keeps the latency colours and hop colours while the layer is off", () => {
    const scene = buildGlobeScene(hops);
    expect(scene.arcs).toHaveLength(3);
    expect(scene.arcs[0].color).toBe(latencyToColor(11));
    expect(scene.markers.find((m) => m.hopIndex === 3)?.color).toBe(hopIndexToColor(3));
  });
});

describe("flights frame the hop in the area the panels leave free", () => {
  // 960 × 640 window: hop pane 336 px on the right, timeline and status bar
  // 200 px at the bottom, trace panel 80 px at the top.
  const frame = {
    insets: { top: 80, right: 348, bottom: 200, left: 0 },
    widthPx: 960,
    heightPx: 640,
    fovRad: Math.PI / 3
  };
  const kmPerPx = (heightM: number) => (2 * heightM * Math.tan(Math.PI / 6)) / 960 / 1000;

  it("looks east and south of the hop by half the covered width and height", () => {
    const target = framedTarget(FRANKFURT, 2_000_000, frame);
    expect(target.longitude).toBeGreaterThan(FRANKFURT.longitude);
    expect(target.latitude).toBeLessThan(FRANKFURT.latitude);
    // The hop then sits (348/2, (200-80)/2) px from the canvas centre: the
    // centre of the free area.
    const expectedKm = Math.hypot(174, 60) * kmPerPx(2_000_000);
    expect(greatCircleKm(FRANKFURT, target)).toBeCloseTo(expectedKm, 0);
  });

  it("uses the height for the field of view in a window taller than wide", () => {
    // Cesium's fov spans the larger side: in a 640 × 960 portrait window a
    // pixel covers 2h tan(30°) / 960, not / 640.
    const portrait = {
      insets: { top: 0, right: 200, bottom: 0, left: 0 },
      widthPx: 640,
      heightPx: 960,
      fovRad: Math.PI / 3
    };
    const target = framedTarget(FRANKFURT, 2_000_000, portrait);
    expect(greatCircleKm(FRANKFURT, target)).toBeCloseTo(100 * kmPerPx(2_000_000), 0);
    expect(kmPerPixel(2_000_000, Math.PI / 3, 960)).toBeCloseTo(kmPerPx(2_000_000), 9);
  });

  it("keeps the hop centred with no panels, or when the free area is too small", () => {
    const none = { ...frame, insets: { top: 0, right: 0, bottom: 0, left: 0 } };
    expect(framedTarget(FRANKFURT, 2_000_000, none)).toEqual(FRANKFURT);
    const crowded = { ...frame, insets: { top: 0, right: 800, bottom: 0, left: 0 } };
    expect(framedTarget(FRANKFURT, 2_000_000, crowded)).toEqual(FRANKFURT);
  });

  it("moves to the framed target, fits the ring in the free area and keeps the floor", () => {
    const current = { latitude: 0, longitude: 0, height: 3_000_000 };
    const focus = { ...FRANKFURT, radiusKm: 1000 };
    const floorM = 2_500_000;
    const [plain] = planFlight(current, focus, floorM);
    const [framed] = planFlight(current, focus, floorM, frame);
    // A 1,000 km ring needs 4,000 km of height; the free area is 612 × 360 px
    // of 960 × 640, so it needs 640/360 times that.
    expect(plain.height).toBe(4_000_000);
    expect(framed.height).toBeCloseTo(4_000_000 * (640 / 360), -3);
    expect(framed.longitude).toBeGreaterThan(FRANKFURT.longitude);
    const low = planFlight({ ...current, height: 300_000 }, focus, floorM, frame);
    expect(low.map((step) => step.kind)).toEqual(["rise", "move"]);
    expect(low.every((step) => step.height >= floorM)).toBe(true);
  });
});

describe("borderRings", () => {
  it("reads polygon and multipolygon rings and skips anything else", () => {
    const geojson = {
      type: "FeatureCollection",
      features: [
        {
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0]
              ]
            ]
          }
        },
        {
          geometry: {
            type: "MultiPolygon",
            coordinates: [
              [
                [
                  [2, 2],
                  [3, 2],
                  [2, 2]
                ]
              ],
              [
                [
                  [4, 4],
                  [5, 4],
                  [4, 4]
                ]
              ]
            ]
          }
        },
        { geometry: { type: "Point", coordinates: [1, 1] } },
        { geometry: null },
        {
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, "x"],
                [1, 0]
              ]
            ]
          }
        }
      ]
    };
    expect(borderRings(geojson)).toEqual([
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0]
      ],
      [
        [2, 2],
        [3, 2],
        [2, 2]
      ],
      [
        [4, 4],
        [5, 4],
        [4, 4]
      ]
    ]);
    expect(borderRings(null)).toEqual([]);
    expect(borderRings({ features: "nope" })).toEqual([]);
  });
});
