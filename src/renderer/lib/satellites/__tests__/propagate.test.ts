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

  it("turns TEME into Earth-fixed with the right sidereal angle (a geostationary check)", () => {
    // Over the equator, circular, one turn per sidereal day: the longitude
    // is Ω + ω + M minus Greenwich mean sidereal time, and it stays put.
    const epoch = "2026-10-24T12:00:00.000000";
    const geo = {
      ...starlinkRow(99950, 100),
      epoch,
      meanMotion: 1.00273791,
      eccentricity: 0.0001,
      inclination: 0.01,
      raan: 30,
      argOfPericenter: 20,
      bstar: 0,
      meanMotionDot: 0
    };
    const epochMs = Date.parse(`${epoch}Z`);
    // IAU 1982 GMST in degrees, independent of satellite.js.
    const jd = epochMs / 86_400_000 + 2_440_587.5;
    const gmst = (280.46061837 + 360.98564736629 * (jd - 2_451_545)) % 360;
    const expected = (((30 + 20 + 100 - gmst) % 360) + 540) % 360 - 180;
    const propagator = createPropagator([elements("geo", geo)]);
    const longitudeAt = (hours: number) => {
      const out = new Float64Array(3);
      propagator.positions(new Date(epochMs + hours * 3_600_000), out);
      expect(Math.hypot(out[0], out[1], out[2]) / 1000).toBeCloseTo(42_164, -2);
      return (Math.atan2(out[1], out[0]) * 180) / Math.PI;
    };
    expect(Math.abs(longitudeAt(0) - expected)).toBeLessThan(0.2);
    expect(Math.abs(longitudeAt(6) - expected)).toBeLessThan(0.2);
  });

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
    // Mean motion so high (a very low orbit) that it decays far below the ground in a year.
    const decayed = { ...starlinkRow(99904, 0), meanMotion: 16.4, bstar: 0.9 };
    const out = new Float64Array(3);
    createPropagator([elements("starlink", decayed)]).positions(
      new Date("2028-10-24T12:00:00Z"),
      out
    );
    expect([...out].every(Number.isNaN)).toBe(true);
  });
});
