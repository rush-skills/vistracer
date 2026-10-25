import { describe, expect, it } from "vitest";
import { createPropagator } from "@renderer/lib/satellites/propagate";
import { VANGUARD_ROW, VANGUARD_TEME_KM, elements, starlinkRow } from "@renderer/test/satelliteFixtures";

const epochMs = Date.parse(`${VANGUARD_ROW.epoch}Z`);

const positionAt = (minutes: number) => {
  const out = new Float64Array(3);
  createPropagator([elements("stations", VANGUARD_ROW)]).positions(
    new Date(epochMs + minutes * 60_000),
    out
  );
  return [...out].map((m) => m / 1000);
};

describe("createPropagator (SGP4, satellite.js)", () => {
  it.each([0, 360] as const)(
    "matches Vallado's reference position of satellite 00005 %i minutes after the epoch",
    (minutes) => {
      // Earth-fixed = TEME turned about the z axis by the sidereal angle:
      // the distance from the centre and the height over the equator plane
      // are Vallado's, to the metre.
      const [x, y, z] = positionAt(minutes);
      const [rx, ry, rz] = VANGUARD_TEME_KM[minutes];
      expect(Math.hypot(x, y, z)).toBeCloseTo(Math.hypot(rx, ry, rz), 3);
      expect(z).toBeCloseTo(rz, 3);
      // ... and the frame really turned: not the TEME x and y.
      expect(Math.abs(x - rx)).toBeGreaterThan(100);
    }
  );

  it("places a Starlink-like satellite about 550 km up", () => {
    const out = new Float64Array(6);
    const propagator = createPropagator([
      elements("starlink", starlinkRow(99902, 10)),
      elements("starlink", starlinkRow(99903, 190))
    ]);
    expect(propagator.count).toBe(2);
    propagator.positions(new Date("2026-10-24T13:00:00Z"), out);
    for (const i of [0, 1]) {
      const km = Math.hypot(out[3 * i], out[3 * i + 1], out[3 * i + 2]) / 1000;
      // 6,378 km (equator) to 6,357 km (pole) plus about 530 to 560 km.
      expect(km).toBeGreaterThan(6_880);
      expect(km).toBeLessThan(6_950);
    }
  });

  it("gives NaN for a satellite that SGP4 cannot place", () => {
    // Mean motion so low that the orbit decays far below the ground in a year.
    const decayed = { ...starlinkRow(99904, 0), meanMotion: 16.4, bstar: 0.9 };
    const out = new Float64Array(3);
    createPropagator([elements("starlink", decayed)]).positions(
      new Date("2028-10-24T12:00:00Z"),
      out
    );
    expect([...out].every(Number.isNaN)).toBe(true);
  });
});
