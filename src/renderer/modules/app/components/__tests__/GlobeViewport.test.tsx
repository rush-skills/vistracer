import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { HopLocation, HopResolution, TracerouteRun } from "@common/ipc";
import type { GlobeScene } from "@renderer/lib/globe";
import { useInfraStore } from "@renderer/state/infraStore";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import { useUiStore } from "@renderer/state/uiStore";
import { CLOUD, PEERINGDB } from "@renderer/test/infraFixtures";
import type { GlobeCallbacks, GlobeController } from "../globe/controller";
import { GlobeViewport, measureInsets } from "../GlobeViewport";

// WebGL does not exist in jsdom: the Cesium adapter is replaced at the seam.
const fake = vi.hoisted(() => ({
  controller: {
    setScene: vi.fn<(scene: GlobeScene) => void>(),
    flyTo: vi.fn(),
    setInputEnabled: vi.fn(),
    setImagery: vi.fn(),
    setHoveredSite: vi.fn(),
    destroy: vi.fn()
  },
  callbacks: undefined as GlobeCallbacks | undefined,
  fail: false
}));

vi.mock("../globe/cesiumGlobe", () => ({
  createCesiumGlobe: (_container: HTMLElement, callbacks: GlobeCallbacks): GlobeController => {
    if (fake.fail) {
      throw new Error("WebGL is not supported");
    }
    fake.callbacks = callbacks;
    return fake.controller;
  }
}));

const located = (hopIndex: number, latitude: number, longitude: number): HopResolution => {
  const location: HopLocation = {
    best: {
      source: "hostname-hint",
      latitude,
      longitude,
      radiusKm: 50,
      confidence: "high",
      label: `Place ${hopIndex}`,
      rtt: null
    },
    alternatives: [],
    ixp: null,
    hostnameHint: null,
    anycast: null,
    isRttReference: false
  };
  return {
    hopIndex,
    ipAddress: `192.0.2.${hopIndex}`,
    hostName: null,
    responders: [],
    lossPercent: 0,
    latency: { minRttMs: 10, maxRttMs: 10, avgRttMs: 10, jitterMs: 0 },
    isPrivate: false,
    location,
    rawLine: "",
    lookupState: "complete"
  };
};

const runWith = (hops: HopResolution[]): TracerouteRun => ({
  request: {
    target: "example.com",
    protocol: "ICMP",
    maxHops: 30,
    timeoutMs: 4000,
    packetCount: 3,
    forceFresh: false
  },
  summary: {
    target: "example.com",
    startedAt: 1,
    hopCount: hops.length,
    protocolsTried: ["ICMP"],
    notices: []
  },
  hops
});

const lastScene = () => fake.controller.setScene.mock.calls.at(-1)?.[0];

describe("GlobeViewport", () => {
  beforeEach(() => {
    fake.fail = false;
    fake.callbacks = undefined;
    Object.values(fake.controller).forEach((mock) => mock.mockClear());
    useTracerouteStore.setState({
      selectedHopIndex: undefined,
      hoveredHopIndex: undefined,
      captureActive: false
    });
    useUiStore.setState({ layers: {} });
    useInfraStore.setState({
      sources: {
        "peeringdb-sites": { status: "ready", data: PEERINGDB },
        "cloud-regions": { status: "ready", data: CLOUD },
        "submarine-cables": { status: "idle" }
      },
      hoveredSite: undefined
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("draws the hops of the run and flies to the selected hop", async () => {
    const run = runWith([located(1, 50.1, 8.7), located(2, 52.4, 4.9)]);
    const { rerender } = render(<GlobeViewport run={run} selectedHopIndex={1} />);
    await waitFor(() => expect(fake.controller.setScene).toHaveBeenCalled());

    expect(lastScene()?.markers.map((m) => [m.hopIndex, m.emphasis])).toEqual([
      [2, "normal"],
      [1, "selected"]
    ]);
    expect(lastScene()?.arcs).toHaveLength(1);
    expect(fake.controller.flyTo).toHaveBeenLastCalledWith(
      { latitude: 50.1, longitude: 8.7, radiusKm: 50 },
      { top: 0, right: 0, bottom: 0, left: 0 }
    );

    rerender(<GlobeViewport run={run} selectedHopIndex={2} />);
    expect(fake.controller.flyTo).toHaveBeenLastCalledWith(
      { latitude: 52.4, longitude: 4.9, radiusKm: 50 },
      { top: 0, right: 0, bottom: 0, left: 0 }
    );
    const flights = fake.controller.flyTo.mock.calls.length;
    // An enrichment update with the same hops does not move the camera.
    rerender(<GlobeViewport run={runWith([...run.hops])} selectedHopIndex={2} />);
    expect(fake.controller.flyTo).toHaveBeenCalledTimes(flights);
  });

  it("syncs hover and selection from the globe into the store and back", async () => {
    const run = runWith([located(1, 50.1, 8.7), located(2, 52.4, 4.9)]);
    render(<GlobeViewport run={run} />);
    await waitFor(() => expect(fake.callbacks).toBeDefined());

    act(() => fake.callbacks?.onHoverHop(2));
    expect(useTracerouteStore.getState().hoveredHopIndex).toBe(2);
    expect(lastScene()?.markers.find((m) => m.hopIndex === 2)?.emphasis).toBe("hovered");
    expect(lastScene()?.labels.map((label) => label.text)).toEqual(["2 · Place 2"]);

    act(() => fake.callbacks?.onSelectHop(1));
    expect(useTracerouteStore.getState().selectedHopIndex).toBe(1);

    act(() => fake.callbacks?.onHoverHop(undefined));
    expect(useTracerouteStore.getState().hoveredHopIndex).toBeUndefined();
  });

  it("does not fly to a hop clicked on the globe while an export records", async () => {
    const run = runWith([located(1, 50.1, 8.7), located(2, 52.4, 4.9)]);
    render(<GlobeViewport run={run} selectedHopIndex={1} />);
    await waitFor(() => expect(fake.callbacks).toBeDefined());
    act(() => useTracerouteStore.setState({ selectedHopIndex: 1 }));
    const flights = fake.controller.flyTo.mock.calls.length;
    act(() => useTracerouteStore.getState().setCaptureActive(true));

    act(() => fake.callbacks?.onSelectHop(2));
    expect(useTracerouteStore.getState().selectedHopIndex).toBe(1);
    expect(fake.controller.flyTo).toHaveBeenCalledTimes(flights);
  });

  it("locks the camera during an export and destroys the globe on unmount", async () => {
    const { unmount } = render(<GlobeViewport run={runWith([located(1, 0, 0)])} />);
    await waitFor(() => expect(fake.controller.setInputEnabled).toHaveBeenLastCalledWith(true));
    act(() => useTracerouteStore.getState().setCaptureActive(true));
    expect(fake.controller.setInputEnabled).toHaveBeenLastCalledWith(false);
    unmount();
    expect(fake.controller.destroy).toHaveBeenCalledTimes(1);
  });

  it("leaves hidden layers out of the scene and passes the imagery switches", async () => {
    const run = runWith([located(1, 50.1, 8.7), located(2, 52.4, 4.9)]);
    render(<GlobeViewport run={run} selectedHopIndex={1} />);
    await waitFor(() => expect(fake.controller.setScene).toHaveBeenCalled());
    expect(fake.controller.setImagery).toHaveBeenLastCalledWith({ dayNight: true, online: true });
    expect(lastScene()?.rings).toHaveLength(2);

    act(() => useUiStore.setState({ layers: { rings: false, arcs: false } }));
    expect(lastScene()?.rings).toEqual([]);
    expect(lastScene()?.arcs).toEqual([]);
    expect(lastScene()?.markers).toHaveLength(2);

    // Off: the adapter takes the online layer out of the globe, and the
    // tile cache refuses downloads (tile_cache.rs).
    act(() => useUiStore.setState({ layers: { "online-imagery": false, "day-night": false } }));
    expect(fake.controller.setImagery).toHaveBeenLastCalledWith({ dayNight: false, online: false });
  });

  it("tells the user when the globe cannot start", async () => {
    fake.fail = true;
    render(<GlobeViewport run={runWith([located(1, 0, 0)])} />);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The globe could not start: WebGL is not supported. It needs WebGL; the hop table still works."
    );
  });

  it("notes when detailed imagery fails", async () => {
    render(<GlobeViewport />);
    await waitFor(() => expect(fake.callbacks).toBeDefined());
    expect(screen.queryByRole("status")).toBeNull();
    act(() => fake.callbacks?.onImageryError("HTTP 503"));
    expect(screen.getByRole("status").textContent).toContain("Detailed imagery is unavailable");
  });

  it("draws the infrastructure layers that are on, and none that are off", async () => {
    render(<GlobeViewport run={runWith([located(1, 50.1, 8.7)])} selectedHopIndex={1} />);
    await waitFor(() => expect(fake.controller.setScene).toHaveBeenCalled());
    const empty = lastScene();
    expect([empty?.exchanges, empty?.facilities, empty?.cloudRegions, empty?.cables]).toEqual([[], [], [], []]);

    act(() => useUiStore.setState({ layers: { exchanges: true, "cloud-regions": true, "cloud-gcp": false } }));
    const scene = lastScene();
    expect(scene?.exchanges.length).toBeGreaterThan(0);
    expect(scene?.facilities).toEqual([]);
    expect(scene?.cloudRegions.some((site) => site.key.startsWith("cloudRegions|gcp:"))).toBe(
      false
    );
    expect(scene?.cloudRegions.some((site) => site.key.startsWith("cloudRegions|aws:"))).toBe(true);
  });

  it("clusters again when the adapter reports a new zoom level, and not on a hop hover", async () => {
    useUiStore.setState({ layers: { "data-centres": true } });
    render(<GlobeViewport run={runWith([located(1, 50.1, 8.7)])} />);
    await waitFor(() => expect(fake.callbacks).toBeDefined());
    act(() => fake.callbacks?.onClusterLevel(10));
    const far = lastScene()?.facilities;
    act(() => useTracerouteStore.getState().setHoveredHop(1));
    // The route changed; the site markers are the same list, so the adapter keeps them.
    expect(lastScene()?.facilities).toBe(far);
    act(() => fake.callbacks?.onClusterLevel(0));
    expect(lastScene()?.facilities.length).toBeGreaterThan(far?.length ?? 0);
  });

  it("puts the hovered site in the store with its cluster, for the hover card", async () => {
    useUiStore.setState({ layers: { "data-centres": true } });
    render(<GlobeViewport run={runWith([])} />);
    await waitFor(() => expect(fake.callbacks).toBeDefined());
    act(() => fake.callbacks?.onClusterLevel(10));
    // Far out, the two Frankfurt data centres form one cluster at the larger one.
    const far = lastScene()?.facilities;
    const frankfurt = far?.find((site) => site.key === "facilities|fac:58");
    act(() => fake.callbacks?.onHoverSite(frankfurt?.key, { x: 5, y: 6 }));
    const hovered = useInfraStore.getState().hoveredSite;
    expect(hovered).toMatchObject({
      specKey: frankfurt?.key,
      layer: "facilities",
      anchor: { kind: "point", x: 5, y: 6 }
    });
    expect(hovered?.keys.length).toBeGreaterThan(1);
    expect(frankfurt?.key).toBe(`facilities|${hovered?.keys[0]}`);
    // The adapter restyles the hovered marker; the site markers are not rebuilt.
    expect(fake.controller.setHoveredSite).toHaveBeenLastCalledWith(frankfurt?.key);
    expect(lastScene()?.facilities).toBe(far);
    act(() => fake.callbacks?.onHoverSite(undefined));
    expect(useInfraStore.getState().hoveredSite).toBeUndefined();
    expect(fake.controller.setHoveredSite).toHaveBeenLastCalledWith(undefined);
    expect(lastScene()?.facilities).toBe(far);
  });

  it("frames flights in the whole canvas during an export, which records no panels", async () => {
    const run = runWith([located(1, 50.1, 8.7), located(2, 52.4, 4.9)]);
    const { rerender } = render(<GlobeViewport run={run} selectedHopIndex={1} />);
    await waitFor(() => expect(fake.controller.flyTo).toHaveBeenCalled());
    expect(fake.controller.flyTo.mock.calls.at(-1)?.[1]).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    act(() => useTracerouteStore.getState().setCaptureActive(true));
    rerender(<GlobeViewport run={run} selectedHopIndex={2} />);
    expect(fake.controller.flyTo.mock.calls.at(-1)).toEqual([
      { latitude: 52.4, longitude: 4.9, radiusKm: 50 },
      undefined
    ]);
    act(() => useTracerouteStore.getState().setCaptureActive(false));
  });

  it("does not rebuild site markers or cables for a hop update that changes nothing", async () => {
    const cableMap = {
      fetchedAt: 1,
      note: null,
      cables: [
        {
          key: "cable:x",
          id: "x",
          name: "Example",
          segments: [
            [
              [8.7, 50.1],
              [4.9, 52.4]
            ] as Array<[number, number]>
          ]
        }
      ],
      rejected: 0
    };
    useInfraStore.setState({
      sources: {
        ...useInfraStore.getState().sources,
        "submarine-cables": { status: "ready", data: cableMap }
      }
    });
    useUiStore.setState({ layers: { "data-centres": true, "submarine-cables": true } });
    // The route infra reads the run from the store, as in the app.
    const run = runWith([located(1, 50.1, 8.7), located(2, 52.4, 4.9)]);
    useTracerouteStore.setState({ runs: { r: run }, currentRunId: "r" });
    const { rerender } = render(<GlobeViewport run={run} />);
    await waitFor(() => expect(fake.callbacks).toBeDefined());
    act(() => fake.callbacks?.onClusterLevel(6));
    const before = lastScene();
    expect(before?.cables.length).toBe(1);
    // An enrichment update: new hop objects, same places.
    const updated = runWith(run.hops.map((hop) => ({ ...hop, hostName: "router.example.net" })));
    act(() => useTracerouteStore.setState({ runs: { r: updated } }));
    rerender(<GlobeViewport run={updated} />);
    expect(lastScene()?.facilities).toBe(before?.facilities);
    expect(lastScene()?.cables).toBe(before?.cables);
  });
});

describe("measureInsets", () => {
  it("measures how far the marked panels reach into the canvas from each edge", () => {
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
    const canvas = document.createElement("div");
    canvas.getBoundingClientRect = () => rect(0, 0, 960, 640);
    const panel = (edge: string, box: DOMRect) => {
      const element = document.createElement("div");
      element.setAttribute("data-globe-inset", edge);
      element.getBoundingClientRect = () => box;
      document.body.append(element);
      return element;
    };
    const panels = [
      panel("right", rect(612, 12, 336, 500)),
      panel("bottom", rect(12, 440, 500, 120)),
      panel("bottom", rect(12, 572, 600, 56)),
      panel("top", rect(12, 12, 420, 68)),
      // The network legend, on the left above the timeline.
      panel("left", rect(12, 200, 300, 180)),
      // A hidden panel has no size and covers nothing.
      panel("right", rect(0, 0, 0, 0))
    ];
    expect(measureInsets(canvas)).toEqual({ top: 80, right: 348, bottom: 200, left: 312 });
    panels.forEach((element) => element.remove());
  });
});
