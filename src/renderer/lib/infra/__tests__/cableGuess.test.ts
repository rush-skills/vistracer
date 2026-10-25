import { describe, expect, it } from "vitest";
import type { HopResolution, LocationEstimate } from "@common/ipc";
import { greatCircleKm } from "@renderer/lib/globe";
import { cablePositions, guessCables } from "@renderer/lib/infra/cableGuess";
import { estimate, makeHop } from "@renderer/test/fixtures";
import { CABLES } from "@renderer/test/infraFixtures";

const located = (hopIndex: number, best: LocationEstimate): HopResolution =>
  makeHop(hopIndex, `198.51.100.${hopIndex}`, hopIndex * 20, {
    location: { best, alternatives: [], ixp: null, hostnameHint: null, anycast: null, isRttReference: false }
  });

describe("cablePositions", () => {
  it("follows the great circle in steps of at most 100 km and keeps the given points", () => {
    const positions = cablePositions([
      [-73.97, 40.59],
      [-4.55, 50.83]
    ]);
    expect(positions[0]).toMatchObject({ longitude: -73.97, latitude: 40.59 });
    expect(positions.at(-1)).toMatchObject({ longitude: -4.55, latitude: 50.83 });
    for (let i = 1; i < positions.length; i += 1) {
      expect(greatCircleKm(positions[i - 1], positions[i])).toBeLessThanOrEqual(100.5);
    }
    // The great circle from New York to Cornwall bends north of both ends.
    expect(Math.max(...positions.map((p) => p.latitude))).toBeGreaterThan(51);
    expect(positions.every((p) => p.height > 0)).toBe(true);
  });
});

describe("guessCables", () => {
  const mumbai = located(2, estimate("Mumbai", 19.08, 72.88, "medium", "geolite-city", 20));
  const marseille = located(4, estimate("Marseille", 43.3, 5.37));

  it("names a cable with one end near each hop of a long crossing", () => {
    expect(guessCables([mumbai, marseille], CABLES.cables)).toEqual([
      {
        cableKey: "cable:indian-ocean",
        name: "Example Indian Ocean Cable",
        fromHopIndex: 2,
        toHopIndex: 4,
        fromKm: expect.any(Number),
        toKm: expect.any(Number)
      }
    ]);
  });

  it("guesses nothing for short links, low-confidence places or no cable near both", () => {
    const chennai = located(3, estimate("Chennai", 13.08, 80.27));
    expect(guessCables([mumbai, chennai], CABLES.cables)).toEqual([]);
    const vague = located(4, estimate("France", 46, 2, "low", "geolite-country", 1000));
    expect(guessCables([mumbai, vague], CABLES.cables)).toEqual([]);
    const tokyo = located(5, estimate("Tokyo", 35.68, 139.69));
    expect(guessCables([mumbai, tokyo], CABLES.cables)).toEqual([]);
  });

  it("offers at most two cables per crossing, the nearest landings first", () => {
    const near = (id: string, offset: number) => ({
      key: `cable:${id}`,
      id,
      name: id,
      segments: [
        [
          [72.83 + offset, 18.94] as [number, number],
          [5.37 + offset, 43.3] as [number, number]
        ]
      ]
    });
    const guesses = guessCables([mumbai, marseille], [near("c", 2), near("a", 0), near("b", 1)]);
    expect(guesses.map((guess) => guess.name)).toEqual(["a", "b"]);
  });
});
