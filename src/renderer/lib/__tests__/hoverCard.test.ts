import { describe, expect, it } from "vitest";
import { ROUTE, estimate, makeHop } from "@renderer/test/fixtures";
import { CARD_GAP, CARD_MARGIN, hoverCardContent, placeCard } from "../hoverCard";

const hop = (index: number) => ROUTE.find((item) => item.hopIndex === index)!;

describe("hoverCardContent", () => {
  it("shows host, address, network, location with confidence and source, and RTT", () => {
    expect(hoverCardContent(hop(3))).toEqual({
      title: "Hop 3",
      host: "if-ae-2.tcore1.mlv-mumbai.as6453.net",
      address: "180.87.38.5",
      network: "AS6453 TATA COMMUNICATIONS",
      place: "Chennai, India",
      placeDetail: "Host name: high confidence, ±50 km",
      rtt: "31 ms (30–31)",
      loss: null,
      note: null
    });
  });

  it("notes anycast, private and missing replies instead of a place", () => {
    const anycast = hoverCardContent(hop(6));
    expect(anycast.place).toBeNull();
    expect(anycast.network).toBe("AS15169 GOOGLE");
    expect(anycast.note).toBe(
      "Anycast: many Google Public DNS sites share this address, and the nearest one answered. The globe shows no point for it."
    );
    expect(hoverCardContent(hop(1)).note).toBe("Private address: it has no public location.");
    const silent = hoverCardContent(hop(4));
    expect(silent).toMatchObject({ address: "No reply", rtt: null, loss: "100% loss" });
    expect(hoverCardContent(hop(5)).loss).toBe("33% loss");
  });

  it("says when the RTT check disagrees with the location", () => {
    const best = { ...estimate("London, GB", 51.5, 0), rtt: null };
    const conflicting = makeHop(5, "154.54.56.85", 160, {
      location: {
        ...hop(5).location,
        best: {
          ...best,
          rtt: {
            verdict: "conflict",
            distanceKm: 1139,
            maxDistanceKm: 840,
            originalRadiusKm: 50,
            referenceHopIndex: 2,
            referenceSource: "geolite-city",
            boundHopIndex: 5,
            boundRttMs: 160
          }
        }
      }
    });
    expect(hoverCardContent(conflicting).note).toBe(
      "The RTT check against hop 2 disagrees with this location; one of the two is wrong."
    );
  });
});

describe("placeCard", () => {
  const view = { width: 1000, height: 700 };
  const card = { width: 240, height: 120 };

  it("puts the card below and right of the pointer", () => {
    expect(placeCard({ kind: "point", x: 100, y: 100 }, card, view)).toEqual({
      left: 100 + CARD_GAP,
      top: 100 + CARD_GAP
    });
  });

  it("flips to the left and above near the right and bottom edges", () => {
    expect(placeCard({ kind: "point", x: 900, y: 650 }, card, view)).toEqual({
      left: 900 - CARD_GAP - card.width,
      top: 650 - CARD_GAP - card.height
    });
  });

  it("centres the card above a timeline hop, or below it at the top", () => {
    const rect = { kind: "rect" as const, left: 400, top: 600, width: 56, height: 90 };
    expect(placeCard(rect, card, view)).toEqual({
      left: 428 - card.width / 2,
      top: 600 - CARD_GAP - card.height
    });
    expect(placeCard({ ...rect, top: 20 }, card, view).top).toBe(20 + 90 + CARD_GAP);
  });

  it("keeps the card inside the window", () => {
    const corner = placeCard({ kind: "rect", left: 0, top: 600, width: 56, height: 90 }, card, view);
    expect(corner.left).toBe(CARD_MARGIN);
    const huge = placeCard({ kind: "point", x: 10, y: 10 }, { width: 2000, height: 900 }, view);
    expect(huge).toEqual({ left: CARD_MARGIN, top: CARD_MARGIN });
    for (const x of [0, 500, 1000]) {
      for (const y of [0, 350, 700]) {
        const { left, top } = placeCard({ kind: "point", x, y }, card, view);
        expect(left).toBeGreaterThanOrEqual(CARD_MARGIN);
        expect(left + card.width).toBeLessThanOrEqual(view.width - CARD_MARGIN);
        expect(top).toBeGreaterThanOrEqual(CARD_MARGIN);
        expect(top + card.height).toBeLessThanOrEqual(view.height - CARD_MARGIN);
      }
    }
  });
});
