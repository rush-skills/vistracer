import { describe, expect, it } from "vitest";
import type { HopLocation, HopResolution } from "@common/ipc";
import { SITE_COLORS, layerVisibility } from "@renderer/lib/layers";
import {
  GUESSED_CABLE_COLOR,
  buildSiteClusters,
  cableLines,
  cableSpecs,
  hoveredSiteStyle,
  infraScene,
  keepUnchanged,
  routeInfra,
  siteSpecKey,
  siteSpecs
} from "@renderer/lib/infra/scene";
import { siteCardContent } from "@renderer/lib/infra/siteCard";
import { estimate, makeHop } from "@renderer/test/fixtures";
import { CABLES, CLOUD, PEERINGDB } from "@renderer/test/infraFixtures";

const location = (overrides: Partial<HopLocation>): HopLocation => ({
  best: null,
  alternatives: [],
  ixp: null,
  hostnameHint: null,
  anycast: null,
  isRttReference: false,
  ...overrides
});

const HOPS: HopResolution[] = [
  makeHop(2, "103.21.124.1", 4, {
    location: location({ best: estimate("Mumbai", 19.08, 72.88, "medium", "geolite-city", 20) })
  }),
  makeHop(4, "80.231.217.17", 111, { location: location({ best: estimate("Marseille", 43.3, 5.37) }) }),
  makeHop(5, "80.81.192.96", 120, {
    location: location({
      best: estimate("DE-CIX Frankfurt", 50.11, 8.68, "high", "ixp", 30),
      ixp: { ixId: 31, name: "DE-CIX Frankfurt", city: "Frankfurt", country: "DE", prefix: "80.81.192.0/21", facilityCount: 40 }
    })
  }),
  makeHop(6, "52.93.1.1", 121, {
    asn: { asn: 16509, name: "AMAZON-02" },
    location: location({ best: estimate("Frankfurt", 50.1, 8.7) })
  })
];

const INPUT = { peeringdb: PEERINGDB, cloud: CLOUD, cables: CABLES };
const ALL_ON = layerVisibility({
  exchanges: true,
  "data-centres": true,
  "cloud-regions": true,
  "submarine-cables": true
});

describe("infrastructure scene", () => {
  it("builds nothing for layers that are off", () => {
    const visibility = layerVisibility({});
    const route = routeInfra(HOPS, visibility, INPUT);
    expect(route.exchangeLinks.size + route.facilityLinks.size + route.cloudMatches.size).toBe(0);
    const clusters = buildSiteClusters(visibility, 6, INPUT, route);
    expect(clusters).toEqual({ exchanges: [], facilities: [], cloudRegions: [] });
  });

  it("lights up and labels the sites on the route", () => {
    const route = routeInfra(HOPS, ALL_ON, INPUT);
    const clusters = buildSiteClusters(ALL_ON, 4, INPUT, route);
    const scene = infraScene(clusters, []);
    const decix = scene.exchanges.find((site) => site.key === siteSpecKey("exchanges", "ix:31"));
    expect(decix?.label).toBe("DE-CIX Frankfurt · hop 5");
    expect(decix?.outline).toBe("#FFFFFF");
    const aws = scene.cloudRegions.find((site) => site.label?.startsWith("AWS eu-central-1"));
    expect(aws?.label).toBe("AWS eu-central-1 · hop 6 (high)");
    expect(aws?.key).toBe(siteSpecKey("cloudRegions", "aws:eu-central-1"));
    // Labelled sites draw last, on top.
    expect(scene.cloudRegions.at(-1)?.label).toBeDefined();
    // The nearest data centres to hops 4, 5 and 6 stand out, unlabelled.
    expect(scene.facilities.filter((site) => site.outline === "#FFFFFF").length).toBeGreaterThan(0);
  });

  it("clusters far out and splits close in, and leaves hidden providers out before clustering", () => {
    const visibility = layerVisibility({ "cloud-regions": true, "cloud-aws": false });
    const route = routeInfra([], visibility, INPUT);
    const far = buildSiteClusters(visibility, 10, INPUT, route).cloudRegions;
    const near = buildSiteClusters(visibility, 0, INPUT, route).cloudRegions;
    const members = (sites: typeof far) => sites.flatMap((site) => site.cluster.members);
    expect(members(far).some((key) => key.startsWith("aws:"))).toBe(false);
    expect(far.length).toBeLessThan(near.length);
    // GCP Frankfurt (a region) outranks the Cloudflare data centre near it.
    expect(far.find((site) => site.cluster.members.includes("cloudflare:FRA"))?.cluster.key).toBe(
      "gcp:europe-west3"
    );
  });

  it("styles markers by layer and grows clusters and the hovered marker", () => {
    const route = routeInfra([], ALL_ON, INPUT);
    const clusters = buildSiteClusters(ALL_ON, 10, INPUT, route);
    const specs = siteSpecs(clusters.facilities);
    const single = siteSpecs(buildSiteClusters(ALL_ON, 0, INPUT, route).facilities)[0];
    const cluster = clusters.facilities.find((site) => site.cluster.members.length > 1);
    const key = siteSpecKey("facilities", cluster?.cluster.key ?? "");
    const frankfurt = specs.find((site) => site.key === key);
    expect(frankfurt?.color).toBe(SITE_COLORS.facility.fill);
    expect(frankfurt?.pixelSize).toBeGreaterThan(single.pixelSize);
    // The hovered marker is restyled in place: larger, with a white outline.
    expect(frankfurt && hoveredSiteStyle(frankfurt)).toEqual({
      pixelSize: (frankfurt?.pixelSize ?? 0) + 2,
      outline: "#FFFFFF"
    });
  });

  it("highlights every line of a guessed cable and names it once", () => {
    // The guessed cable has a second line (a branch).
    const cables = CABLES.cables.map((cable) =>
      cable.key === "cable:indian-ocean"
        ? {
            ...cable,
            segments: [
              ...cable.segments,
              [
                [43, 12.6],
                [45.0, 11.6]
              ] as Array<[number, number]>
            ]
          }
        : cable
    );
    const route = routeInfra(HOPS, ALL_ON, { ...INPUT, cables: { ...CABLES, cables } });
    expect(route.cableGuesses.map((guess) => guess.name)).toEqual(["Example Indian Ocean Cable"]);
    const specs = cableSpecs(cableLines(cables), route.cableGuesses);
    const guessed = specs.filter((spec) => spec.color === GUESSED_CABLE_COLOR);
    expect(guessed).toHaveLength(2);
    expect(guessed.filter((spec) => spec.label).map((spec) => spec.label?.text)).toEqual([
      "Example Indian Ocean Cable? (a guess)"
    ]);
    expect(specs.slice(-2)).toEqual(guessed);
  });

  it("keeps the previous route results when a new hop list changes nothing", () => {
    const first = routeInfra(HOPS, ALL_ON, INPUT);
    // An enrichment update: a new list and new hop objects, same places.
    const again = routeInfra(
      HOPS.map((hop) => ({ ...hop, hostName: "router.example.net" })),
      ALL_ON,
      INPUT
    );
    expect(again.cableGuesses).not.toBe(first.cableGuesses);
    expect(keepUnchanged(first, again)).toBe(first);
    // A hop that moves changes the links; the guesses stay the same object.
    const moved = routeInfra(
      HOPS.map((hop) =>
        hop.hopIndex === 6
          ? { ...hop, location: { ...hop.location, best: estimate("Kassel", 51.3, 9.5) } }
          : hop
      ),
      ALL_ON,
      INPUT
    );
    const kept = keepUnchanged(first, moved);
    expect(kept).not.toBe(first);
    expect(kept.facilityLinks).not.toBe(first.facilityLinks);
    expect(kept.cableGuesses).toBe(first.cableGuesses);
    expect(keepUnchanged(undefined, first)).toBe(first);
  });

  it("keeps the site marker colours visible on the dark globe (3:1)", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const space = luminance("#0D0E14");
    for (const [name, colors] of Object.entries(SITE_COLORS)) {
      // A ring (facility) is seen by its outline; the others by their fill.
      const shown = name === "facility" ? colors.outline : colors.fill;
      expect((luminance(shown) + 0.05) / (space + 0.05), name).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("siteCardContent", () => {
  const route = routeInfra(HOPS, ALL_ON, INPUT);

  it("says what the route has to do with an exchange", () => {
    const card = siteCardContent({ layer: "exchanges", keys: ["ix:31"] }, INPUT, route);
    expect(card).toEqual({
      title: "DE-CIX Frankfurt",
      lines: ["Internet exchange (PeeringDB)", "1,019 networks, 3 facilities"],
      // Hop 6 has no exchange match of its own; DE-CIX is the nearest.
      route: ["Hop 5 is on its peering LAN.", "Nearest exchange to hop 6 (2 km)."],
      more: null
    });
  });

  it("lists the other data centres of a cluster", () => {
    const card = siteCardContent(
      { layer: "facilities", keys: ["fac:58", "fac:60", "fac:18", "fac:900", "fac:404"] },
      INPUT,
      route
    );
    expect(card?.more).toBe("Also here: Equinix FR5, NIKHEF Amsterdam, Interxion MRS1.");
    expect(card?.route[0]).toMatch(/^Nearest data centre to hop \d/);
  });

  it("gives a cloud region's match and confidence, and that its place is approximate", () => {
    const card = siteCardContent({ layer: "cloudRegions", keys: ["aws:eu-central-1", "gcp:europe-west3"] }, INPUT, route);
    expect(card?.title).toBe("AWS eu-central-1");
    expect(card?.lines).toContain("Amazon Web Services region; approximate location (the city).");
    // Hop 5 has no ASN: next to the region, it is only a low match.
    expect(card?.route).toEqual([
      expect.stringMatching(/^Hop 5, low confidence: No network \(ASN\) is known/),
      expect.stringMatching(/^Hop 6, high confidence: AS16509/)
    ]);
    expect(card?.more).toBe("Also here: Google Cloud europe-west3.");
  });

  it("credits TeleGeography and labels a cable match as a guess", () => {
    const card = siteCardContent({ layer: "cables", keys: ["cable:indian-ocean"] }, INPUT, route);
    expect(card?.lines[0]).toContain("TeleGeography Submarine Cable Map, CC BY-NC-SA 3.0");
    expect(card?.route[0]).toMatch(/^A guess: it lands near hop 2 .* and hop 4 .*another cable\.$/);
  });

  it("shows nothing for a site the data no longer has", () => {
    expect(siteCardContent({ layer: "exchanges", keys: ["ix:1"] }, INPUT, route)).toBeNull();
    expect(siteCardContent({ layer: "cables", keys: ["cable:x"] }, {}, route)).toBeNull();
  });
});
