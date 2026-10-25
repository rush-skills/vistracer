import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { RendererApi } from "@common/bridge";
import { ROUTE, makeRun } from "@renderer/test/fixtures";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import { useUiStore } from "@renderer/state/uiStore";
import { HopTimeline } from "../HopTimeline";

const run = makeRun(ROUTE);
const initialUi = useUiStore.getState();
let setSettings: ReturnType<typeof vi.fn>;

/** The timeline as the app renders it: selection from the store. */
const Connected = () => {
  const selected = useTracerouteStore((state) => state.selectedHopIndex);
  return <HopTimeline run={run} selectedHopIndex={selected} />;
};

const option = (hopIndex: number) =>
  screen.getAllByRole("option").find((el) => el.id === `timeline-hop-${hopIndex}`) as HTMLElement;

beforeEach(async () => {
  setSettings = vi.fn().mockResolvedValue(undefined);
  window.visTracer = {
    getSettings: vi.fn().mockResolvedValue(undefined),
    setSettings
  } as unknown as RendererApi;
  useUiStore.setState(initialUi, true);
  await useUiStore.getState().load();
  useTracerouteStore.setState({ selectedHopIndex: undefined, hoveredHopIndex: undefined });
});

describe("HopTimeline", () => {
  it("shows every hop with RTT, loss, confidence and the latency jumps", () => {
    render(<Connected />);
    const list = screen.getByRole("listbox", { name: "Hops by round-trip time" });
    expect(within(list).getAllByRole("option")).toHaveLength(6);
    expect(option(5).getAttribute("aria-label")).toBe(
      "Hop 5, 80.231.217.17, Marseille, France, high confidence, RTT 112 ms (min 111, max 112), 33% loss, 81 ms more than hop 3"
    );
    expect(option(5).className).toContain("timeline__hop--jump");
    expect(option(5).textContent).toContain("+81");
    expect(option(5).textContent).toContain("33%");
    expect(option(4).textContent).toContain("*");
    expect(option(6).textContent).toContain("anycast");
    expect(screen.getByText("6 hops, up to 113 ms")).toBeTruthy();
  });

  it("keeps the selection in step with the store in both directions", () => {
    render(<Connected />);
    fireEvent.click(option(3));
    expect(useTracerouteStore.getState().selectedHopIndex).toBe(3);
    expect(option(3).getAttribute("aria-selected")).toBe("true");

    // Selected on the globe or in the hop pane.
    act(() => useTracerouteStore.getState().setSelectedHop(5));
    expect(option(5).getAttribute("aria-selected")).toBe("true");
    expect(option(3).getAttribute("aria-selected")).toBe("false");
    expect(option(5).tabIndex).toBe(0);
    expect(option(3).tabIndex).toBe(-1);
  });

  it("moves the selection with the arrow keys, Home and End", () => {
    render(<Connected />);
    // Before anything is selected, the first hop takes the focus.
    expect(option(1).tabIndex).toBe(0);
    option(1).focus();
    fireEvent.keyDown(option(1), { key: "ArrowRight" });
    expect(useTracerouteStore.getState().selectedHopIndex).toBe(2);
    expect(document.activeElement).toBe(option(2));

    fireEvent.keyDown(option(2), { key: "ArrowDown" });
    expect(useTracerouteStore.getState().selectedHopIndex).toBe(3);
    fireEvent.keyDown(option(3), { key: "ArrowLeft" });
    expect(useTracerouteStore.getState().selectedHopIndex).toBe(2);
    fireEvent.keyDown(option(2), { key: "End" });
    expect(useTracerouteStore.getState().selectedHopIndex).toBe(6);
    expect(document.activeElement).toBe(option(6));
    fireEvent.keyDown(option(6), { key: "ArrowRight" });
    expect(useTracerouteStore.getState().selectedHopIndex).toBe(6);
    fireEvent.keyDown(option(6), { key: "Home" });
    expect(useTracerouteStore.getState().selectedHopIndex).toBe(1);
    fireEvent.keyDown(option(1), { key: "ArrowUp" });
    expect(useTracerouteStore.getState().selectedHopIndex).toBe(1);
  });

  it("leaves the selection to an animated export while it records", () => {
    render(<Connected />);
    fireEvent.click(option(2));
    act(() => useTracerouteStore.getState().setCaptureActive(true));
    try {
      fireEvent.click(option(5));
      option(2).focus();
      fireEvent.keyDown(option(2), { key: "ArrowRight" });
      expect(useTracerouteStore.getState().selectedHopIndex).toBe(2);
      expect(document.activeElement).toBe(option(2));
    } finally {
      act(() => useTracerouteStore.getState().setCaptureActive(false));
    }
  });

  it("shares the hovered hop with the globe and the hop pane", () => {
    render(<Connected />);
    fireEvent.mouseEnter(option(3));
    expect(useTracerouteStore.getState().hoveredHopIndex).toBe(3);
    fireEvent.mouseLeave(option(3));
    expect(useTracerouteStore.getState().hoveredHopIndex).toBeUndefined();

    act(() => useTracerouteStore.getState().setHoveredHop(5));
    expect(option(5).className).toContain("timeline__hop--hovered");
    expect(option(3).className).not.toContain("timeline__hop--hovered");
  });

  it("scrolls a hop selected elsewhere into view", () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.id);
    };
    try {
      render(<Connected />);
      act(() => useTracerouteStore.getState().setSelectedHop(6));
      expect(scrolled).toEqual(["timeline-hop-6"]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("points its toggle only at a hop list that exists", () => {
    const { unmount } = render(<HopTimeline />);
    const toggle = screen.getByRole("button", { name: "Hide hop timeline" });
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    unmount();
    render(<Connected />);
    const controls = screen
      .getByRole("button", { name: "Hide hop timeline" })
      .getAttribute("aria-controls");
    expect(document.getElementById(controls ?? "")).toBe(screen.getByRole("listbox"));
  });

  it("collapses and saves that it is collapsed", async () => {
    render(<Connected />);
    fireEvent.click(screen.getByRole("button", { name: "Hide hop timeline" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(setSettings).toHaveBeenLastCalledWith("preferences.ui", {
      theme: "dark",
      layers: {},
      collapsed: { timeline: true }
    });
    fireEvent.click(screen.getByRole("button", { name: "Show hop timeline" }));
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});
