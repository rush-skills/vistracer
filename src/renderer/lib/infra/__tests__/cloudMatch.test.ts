import { describe, expect, it } from "vitest";
import type { HopResolution, LocationEstimate } from "@common/ipc";
import { matchCloudRegion, matchCloudRegions } from "@renderer/lib/infra/cloudMatch";
import { formatKm } from "@renderer/lib/infra/format";
import { shownCloud } from "@renderer/lib/infra/scene";
import { layerVisibility } from "@renderer/lib/layers";
import { estimate, makeHop } from "@renderer/test/fixtures";
import { CLOUD, PROVIDERS } from "@renderer/test/infraFixtures";

const at = (
  asn: number | null,
  best: LocationEstimate | null,
  extra: Partial<HopResolution> = {}
): HopResolution =>
  makeHop(7, "203.0.113.7", 20, {
    asn: asn == null ? null : { asn, name: "NET" },
    location: { best, alternatives: [], ixp: null, hostnameHint: null, anycast: null, isRttReference: false },
    ...extra
  });

const match = (hop: HopResolution) => matchCloudRegion(hop, PROVIDERS, CLOUD.regions);

describe("matchCloudRegion", () => {
  it("is high when the provider's network has a region next to a precise estimate", () => {
    const result = match(at(16509, estimate("Frankfurt", 50.1, 8.7, "high", "hostname-hint", 50)));
    expect(result).toMatchObject({ confidence: "high", distanceKm: expect.any(Number) });
    expect(result?.region?.code).toBe("eu-central-1");
    expect(result?.reason).toBe(
      "AS16509 is Amazon's network, and AWS eu-central-1 is 2 km from the hop's estimate. An edge site of the same network in that city would look the same."
    );
  });

  it("is at most medium when the estimate is weak or disputed by the RTT check", () => {
    // A GeoLite2 city record the app rates low (radius 150 km), next to the region.
    const weak = match(at(16509, estimate("Frankfurt", 50.1, 8.7, "low", "geolite-city", 150)));
    expect(weak?.confidence).toBe("medium");
    expect(weak?.reason).toContain("(±150 km, low confidence), so the region is a guess");
    const disputed = estimate("Frankfurt", 50.1, 8.7, "high", "hostname-hint", 50);
    disputed.rtt = {
      verdict: "conflict",
      distanceKm: 900,
      maxDistanceKm: 500,
      originalRadiusKm: 50,
      referenceHopIndex: 2,
      referenceSource: "geolite-city",
      boundHopIndex: 7,
      boundRttMs: 20
    };
    const conflict = match(at(16509, disputed));
    expect(conflict?.confidence).toBe("medium");
    expect(conflict?.reason).toContain("disputed by the RTT check");
    // Without an ASN, a weak or disputed estimate gives no match at all.
    expect(match(at(null, estimate("Frankfurt", 50.11, 8.68, "low", "geolite-city", 80)))).toBeNull();
    expect(match(at(null, disputed))).toBeNull();
  });

  it("is medium for the provider's network with its region within 500 km", () => {
    // Paris is about 480 km from Frankfurt.
    const result = match(at(16509, estimate("Paris", 48.86, 2.35, "high", "hostname-hint", 50)));
    expect(result?.confidence).toBe("medium");
    expect(result?.reason).toContain("so the region is a guess");
  });

  it("is low for the provider's network far from its regions: an edge site", () => {
    const result = match(at(16509, estimate("Lagos", 6.45, 3.4, "high", "hostname-hint", 50)));
    expect(result?.confidence).toBe("low");
    expect(result?.reason).toContain("probably an edge site");
  });

  it("does not trust a vague estimate to place a hop in one region", () => {
    // GeoLite2 country centroid of Germany, ±1,000 km.
    const result = match(at(16509, estimate("Germany", 51, 10, "low", "geolite-country", 1000)));
    expect(result?.confidence).toBe("medium");
    // Far from every region, a vague estimate is not called an edge site:
    // the US country centroid (±2,000 km) is about 1,700 km from Ashburn.
    const us = match(
      at(16509, estimate("United States", 39.5, -98.35, "low", "geolite-country", 2000))
    );
    expect(us?.confidence).toBe("low");
    expect(us?.reason).not.toContain("edge site");
    expect(us?.reason).toContain("(±2,000 km) is too vague to place it at a region");
  });

  it("is low with no region for an anycast or unlocated hop of the provider", () => {
    const anycast = at(13335, null, {
      location: {
        best: null,
        alternatives: [],
        ixp: null,
        hostnameHint: null,
        anycast: { evidence: "known-prefix", service: "Cloudflare DNS", geoliteRuledOut: false, maxDistanceKm: null, referenceHopIndex: null },
        isRttReference: false
      }
    });
    const result = match(anycast);
    expect(result).toMatchObject({ confidence: "low", region: null });
    expect(result?.reason).toBe(
      "AS13335 is Cloudflare's network, but it is anycast, so the data centre is unknown."
    );
  });

  it("never matches another network's router next to a region", () => {
    expect(match(at(3356, estimate("Frankfurt", 50.11, 8.68)))).toBeNull();
  });

  it("is low on proximity alone when no ASN is known", () => {
    const result = match(at(null, estimate("Frankfurt", 50.11, 8.68, "high", "hostname-hint", 50)));
    expect(result?.confidence).toBe("low");
    expect(result?.reason).toContain("which alone proves little");
    expect(match(at(null, estimate("Frankfurt", 50.11, 8.68, "medium", "geolite-city", 200)))).toBeNull();
    expect(match(at(null, estimate("Kassel", 51.3, 9.5)))).toBeNull();
  });

  it("ignores private hops and hops without an answer", () => {
    expect(match(at(16509, estimate("Frankfurt", 50.1, 8.7), { isPrivate: true }))).toBeNull();
    expect(match(at(16509, estimate("Frankfurt", 50.1, 8.7), { ipAddress: null }))).toBeNull();
  });

  it("matches only the providers whose switch is on", () => {
    const hop = at(16509, estimate("Frankfurt", 50.1, 8.7));
    const shown = shownCloud(CLOUD, layerVisibility({ "cloud-regions": true, "cloud-aws": false }));
    expect(shown.providers.map((provider) => provider.id)).toEqual(["gcp", "cloudflare"]);
    expect(matchCloudRegions([hop], shown.providers, shown.regions).size).toBe(0);
    const all = shownCloud(CLOUD, layerVisibility({ "cloud-regions": true }));
    expect(matchCloudRegions([hop], all.providers, all.regions).get(7)?.provider.id).toBe("aws");
    expect(shownCloud(CLOUD, layerVisibility({})).providers).toEqual([]);
  });
});

describe("formatKm", () => {
  it("rounds to whole km and says when a distance is under 1 km", () => {
    expect([0, 0.4, 0.6, 12.4, 1234.5].map(formatKm)).toEqual([
      "under 1 km",
      "under 1 km",
      "1 km",
      "12 km",
      "1,235 km"
    ]);
  });
});
