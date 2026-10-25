import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { RendererApi } from "@common/bridge";
import { ROUTE, makeRun } from "@renderer/test/fixtures";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
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
});
