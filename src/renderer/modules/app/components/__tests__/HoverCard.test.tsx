import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { RendererApi } from "@common/bridge";
import { ROUTE, makeRun } from "@renderer/test/fixtures";
import { useInfraStore } from "@renderer/state/infraStore";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import { useUiStore } from "@renderer/state/uiStore";
import { INFRA_CODE, PEERINGDB } from "@renderer/test/infraFixtures";
import { groupData, starlinkRow } from "@renderer/test/satelliteFixtures";
import { HoverCard } from "../HoverCard";

let bridge: Record<string, ReturnType<typeof vi.fn>>;
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // Every bridge call and fetch is recorded: hovering must make none.
  bridge = Object.fromEntries(
    ["getSettings", "setSettings", "runTraceroute", "getTileCacheInfo", "getGeoDatabaseMeta"].map(
      (name) => [name, vi.fn()]
    )
  );
  window.visTracer = bridge as unknown as RendererApi;
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  useTracerouteStore.setState({
    runs: { r1: makeRun(ROUTE) },
    currentRunId: "r1",
    hoveredHopIndex: undefined,
    hoverAnchor: undefined,
    captureActive: false
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HoverCard", () => {
  it("shows a hovered satellite: name, NORAD id, altitude and the age of its elements", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-25T02:00:00Z"));
    useInfraStore.setState({
      code: INFRA_CODE,
      sources: {
        ...useInfraStore.getState().sources,
        "celestrak-starlink": { status: "ready", data: groupData("starlink", [starlinkRow(99902, 10)]) }
      }
    });
    render(<HoverCard />);
    act(() =>
      useInfraStore.getState().setHoveredSite({
        specKey: "sat|starlink|99902",
        layer: "satellites",
        keys: ["sat|starlink|99902"],
        heightKm: 551.2,
        anchor: { kind: "point", x: 100, y: 100 }
      })
    );
    const card = screen.getByRole("tooltip");
    expect(card.textContent).toContain("EXAMPLE STARLINK-99902");
    expect(card.textContent).toContain("Starlink · NORAD 99902 · 2098-001A");
    expect(card.textContent).toContain("Altitude 551 km");
    expect(card.textContent).toContain("Orbital elements from 14 hours ago (CelesTrak)");
    for (const call of Object.values(bridge)) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    act(() => useInfraStore.getState().setHoveredSite(undefined));
    vi.restoreAllMocks();
  });

  it("says when a hop is likely a satellite link", () => {
    const hops = ROUTE.map((hop, i) => (i === 1 ? { ...hop, asn: { asn: 14593, name: "SPACEX-STARLINK" } } : hop));
    const run = { ...makeRun(ROUTE), hops };
    useTracerouteStore.setState({ runs: { r1: run } });
    render(<HoverCard />);
    act(() => useTracerouteStore.getState().setHoveredHop(run.hops[1].hopIndex, { kind: "point", x: 50, y: 50 }));
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Likely satellite link: Starlink, medium confidence"
    );
  });

  it("calls a low-confidence satellite link possible, with the reason", () => {
    // A HughesNet hop only 30 ms away: too close for a geostationary link before it.
    const hops = ROUTE.map((hop, i) => (i === 2 ? { ...hop, asn: { asn: 6621, name: "HUGHES-NET" } } : hop));
    const run = { ...makeRun(ROUTE), hops };
    useTracerouteStore.setState({ runs: { r1: run } });
    render(<HoverCard />);
    act(() => useTracerouteStore.getState().setHoveredHop(run.hops[2].hopIndex, { kind: "point", x: 50, y: 50 }));
    const text = screen.getByRole("tooltip").textContent ?? "";
    expect(text).toContain("Possible HughesNet satellite link (low confidence: a 30 ms round trip is too short for a geostationary link)");
    expect(text).not.toContain("Likely");
  });

  it("shows the hovered hop from the store and makes no request", () => {
    render(<HoverCard />);
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() =>
      useTracerouteStore.getState().setHoveredHop(3, { kind: "point", x: 200, y: 150 })
    );
    const card = screen.getByRole("tooltip");
    expect(card.textContent).toContain("Hop 3");
    expect(card.textContent).toContain("if-ae-2.tcore1.mlv-mumbai.as6453.net");
    expect(card.textContent).toContain("180.87.38.5");
    expect(card.textContent).toContain("AS6453 TATA COMMUNICATIONS");
    expect(card.textContent).toContain("Chennai, India");
    expect(card.textContent).toContain("Host name: high confidence, ±50 km");
    expect(card.textContent).toContain("31 ms (30–31)");
    // Placed after measuring: next to the pointer, inside the window.
    expect(card.style.visibility).toBe("");
    expect(card.style.left).toBe("212px");
    expect(card.style.top).toBe("162px");

    act(() =>
      useTracerouteStore.getState().setHoveredHop(6, { kind: "point", x: 210, y: 150 })
    );
    expect(screen.getByRole("tooltip").textContent).toContain("Anycast: many Google Public DNS");

    for (const call of Object.values(bridge)) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("places the card again when an export ends", () => {
    render(<HoverCard />);
    act(() => useTracerouteStore.getState().setHoveredHop(3, { kind: "point", x: 200, y: 150 }));
    act(() => useTracerouteStore.getState().setCaptureActive(true));
    expect(screen.queryByRole("tooltip")).toBeNull();
    // The pointer moved on while the export recorded.
    act(() => useTracerouteStore.getState().setHoveredHop(3, { kind: "point", x: 300, y: 150 }));
    act(() => useTracerouteStore.getState().setCaptureActive(false));
    const card = screen.getByRole("tooltip");
    expect(card.style.visibility).toBe("");
    expect(card.style.left).toBe("312px");
  });

  it("shows nothing for a hover from the hop table, during an export, or after the pointer leaves", () => {
    render(<HoverCard />);
    act(() => useTracerouteStore.getState().setHoveredHop(3));
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => useTracerouteStore.getState().setHoveredHop(3, { kind: "point", x: 1, y: 1 }));
    expect(screen.getByRole("tooltip")).toBeTruthy();
    act(() => useTracerouteStore.getState().setCaptureActive(true));
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => useTracerouteStore.getState().setCaptureActive(false));

    act(() => useTracerouteStore.getState().setHoveredHop(undefined, { kind: "point", x: 1, y: 1 }));
    expect(useTracerouteStore.getState().hoverAnchor).toBeUndefined();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows a hovered data centre cluster from the loaded list and makes no request", () => {
    useUiStore.setState({ layers: { "data-centres": true } });
    useInfraStore.setState({
      code: INFRA_CODE,
      sources: {
        ...useInfraStore.getState().sources,
        "peeringdb-sites": { status: "ready", data: PEERINGDB }
      }
    });
    render(<HoverCard />);
    act(() =>
      useInfraStore.getState().setHoveredSite({
        specKey: "facilities|fac:58",
        layer: "facilities",
        keys: ["fac:58", "fac:60"],
        anchor: { kind: "point", x: 100, y: 100 }
      })
    );
    const card = screen.getByRole("tooltip");
    expect(card.textContent).toContain("Digital Realty Frankfurt FRA1-27");
    expect(card.textContent).toContain("Data centre (PeeringDB)");
    expect(card.textContent).toContain("Also here: Equinix FR5.");
    // A hop under the pointer wins over the site.
    act(() => useTracerouteStore.getState().setHoveredHop(3, { kind: "point", x: 100, y: 100 }));
    expect(screen.getByRole("tooltip").textContent).toContain("Hop 3");
    for (const call of Object.values(bridge)) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
