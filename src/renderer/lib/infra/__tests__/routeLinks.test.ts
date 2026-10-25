import { describe, expect, it } from "vitest";
import type { HopLocation } from "@common/ipc";
import { linkExchanges, linkFacilities } from "@renderer/lib/infra/routeLinks";
import { estimate, makeHop } from "@renderer/test/fixtures";
import { PEERINGDB } from "@renderer/test/infraFixtures";

const location = (overrides: Partial<HopLocation>): HopLocation => ({
  best: null,
  alternatives: [],
  ixp: null,
  hostnameHint: null,
  anycast: null,
  isRttReference: false,
  ...overrides
});

const ixMatch = {
  ixId: 31,
  name: "DE-CIX Frankfurt",
  city: "Frankfurt",
  country: "DE",
  prefix: "80.81.192.0/21",
  facilityCount: 40
};

describe("route links", () => {
  it("lights up the exchange whose peering LAN a hop is on (phase 2 match)", () => {
    const hops = [
      makeHop(5, "80.81.192.96", 120, {
        location: location({ ixp: ixMatch, best: estimate("DE-CIX Frankfurt", 50.11, 8.68, "high", "ixp", 120) })
      })
    ];
    const links = linkExchanges(hops, PEERINGDB.exchanges);
    expect(links.get("ix:31")).toEqual([{ hopIndex: 5, kind: "on-lan", distanceKm: null }]);
    expect(links.size).toBe(1);
  });

  it("links each well-placed hop to the nearest exchange and data centre within its radius", () => {
    const hops = [
      makeHop(4, "80.231.217.17", 111, { location: location({ best: estimate("Marseille", 43.3, 5.37) }) }),
      makeHop(6, "154.54.58.1", 128, { location: location({ best: estimate("Frankfurt", 50.1, 8.65) }) })
    ];
    expect(linkExchanges(hops, PEERINGDB.exchanges).get("ix:359")?.[0]).toMatchObject({
      hopIndex: 4,
      kind: "nearest"
    });
    const facilities = linkFacilities(hops, PEERINGDB.facilities);
    // Equinix FR5 (2 km) is nearer than Digital Realty (6 km).
    expect([...facilities.keys()].sort()).toEqual(["fac:60", "fac:900"]);
    expect(facilities.get("fac:60")?.[0].distanceKm).toBeLessThan(3);
  });

  it("does not link hops whose location is weak or disputed", () => {
    const weak = makeHop(2, "198.51.100.2", 5, {
      location: location({ best: estimate("Frankfurt", 50.1, 8.7, "low", "geolite-city", 300) })
    });
    const conflict = makeHop(3, "198.51.100.3", 6, {
      location: location({
        best: {
          ...estimate("Frankfurt", 50.1, 8.7),
          rtt: {
            verdict: "conflict",
            distanceKm: 900,
            maxDistanceKm: 500,
            originalRadiusKm: 50,
            referenceHopIndex: 2,
            referenceSource: "geolite-city",
            boundHopIndex: 3,
            boundRttMs: 6
          }
        }
      })
    });
    const far = makeHop(4, "198.51.100.4", 7, { location: location({ best: estimate("Kassel", 51.3, 9.5) }) });
    expect(linkFacilities([weak, conflict, far], PEERINGDB.facilities).size).toBe(0);
  });
});
