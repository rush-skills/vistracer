/**
 * E2E tests of the UI shell: the whole App through the real Tauri bridge,
 * with Tauri's invoke/listen faked (a backend that streams one trace) and
 * the Cesium adapter replaced at its seam (no WebGL in jsdom).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GlobeController } from "../../src/renderer/modules/app/components/globe/controller";
import type { TracerouteProgressEvent, TracerouteRequest } from "../../src/common/ipc";
import { ROUTE } from "../../src/renderer/test/fixtures";

const backend = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  invoke: vi.fn(),
  progress: undefined as ((event: { payload: unknown }) => void) | undefined,
  requests: [] as TracerouteRequest[]
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => backend.invoke(command, args),
  isTauri: () => false,
  convertFileSrc: (path: string) => path
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    if (event === "vistracer:traceroute:progress") {
      backend.progress = handler;
    }
    return Promise.resolve(() => undefined);
  })
}));

const globe = vi.hoisted(() => ({
  controller: {
    setScene: vi.fn(),
    flyTo: vi.fn(),
    setInputEnabled: vi.fn(),
    setImagery: vi.fn(),
    setHoveredSite: vi.fn(),
    destroy: vi.fn()
  }
}));
vi.mock("../../src/renderer/modules/app/components/globe/cesiumGlobe", () => ({
  createCesiumGlobe: (): GlobeController => globe.controller
}));

import "../../src/common/bridge";
import { App } from "../../src/renderer/modules/app/App";
import { useInfraStore } from "../../src/renderer/state/infraStore";
import { useTracerouteStore } from "../../src/renderer/state/tracerouteStore";
import { useUiStore } from "../../src/renderer/state/uiStore";
import fs from "node:fs";
import path from "node:path";

const initialUi = useUiStore.getState();
const initialInfra = useInfraStore.getState();
const CLOUD_SNAPSHOT = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../src/renderer/public/infra/cloud-regions.json"), "utf8")
);
const SITES = {
  storedAt: 1,
  complete: true,
  exchanges: [
    {
      id: 31,
      name: "DE-CIX Frankfurt",
      city: "Frankfurt",
      country: "DE",
      latitude: 50.11,
      longitude: 8.68,
      radiusKm: 120,
      facilityCount: 40,
      networkCount: 1019
    }
  ],
  facilities: []
};
const CABLE_MAP = {
  fetchedAt: 1,
  note: null,
  cables: [{ id: "x", name: "Example Cable", segments: [[[72.8, 18.9], [5.4, 43.3]]] }]
};
const initialTrace = useTracerouteStore.getState();

/** A backend that answers the start-up calls and streams ROUTE for a trace. */
function fakeBackend(command: string, args?: Record<string, unknown>): unknown {
  switch (command) {
    case "get_settings":
      return backend.settings[args?.key as string] ?? null;
    case "set_settings":
      backend.settings[args?.key as string] = args?.value;
      return null;
    case "get_geo_database_meta":
      return { cityDbStatus: "loaded", asnDbStatus: "loaded" };
    case "get_recent_runs":
      return [];
    case "get_app_info":
      return { version: "0.0.0-test", updaterConfigured: false };
    case "get_peeringdb_sites":
      return SITES;
    case "get_submarine_cables": {
      // Like the backend: only with the saved layer switch on and its notice accepted.
      const ui = backend.settings["preferences.ui"] as
        | { layers?: Record<string, boolean>; consents?: Record<string, boolean> }
        | undefined;
      if (!ui?.layers?.["submarine-cables"] || !ui.consents?.["submarine-cables"]) {
        throw "Submarine cables are off: turn the layer on in Layers and accept its notice. Nothing was downloaded.";
      }
      return CABLE_MAP;
    }
    case "traceroute_run": {
      const request = args?.request as TracerouteRequest;
      backend.requests.push(request);
      const runId = `run-${backend.requests.length}`;
      const summary = {
        target: request.target,
        startedAt: 1,
        hopCount: ROUTE.length,
        protocolsTried: [request.protocol],
        notices: []
      };
      for (const hop of ROUTE) {
        backend.progress?.({
          payload: { runId, hop, completed: false, summary } satisfies TracerouteProgressEvent
        });
      }
      const run = { request, summary: { ...summary, completedAt: 2 }, hops: ROUTE };
      backend.progress?.({
        payload: { runId, completed: true, summary: run.summary, hops: ROUTE }
      });
      return { runId, run };
    }
    default:
      return null;
  }
}

const commandSearch = () => screen.getByRole("combobox", { name: /Search commands/ });

const settingsWrites = () =>
  backend.invoke.mock.calls.filter(([command, args]) => command === "set_settings" && args?.key === "preferences.ui");

function renderApp() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <App />
    </QueryClientProvider>
  );
}

async function trace(target: string) {
  const input = screen.getByRole("textbox", { name: "Traceroute target" });
  fireEvent.change(input, { target: { value: target } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Trace" }));
  });
  await screen.findByRole("listbox", { name: "Hops by round-trip time" });
}

beforeEach(() => {
  backend.settings = { "preferences.onboarding": { skipOnLaunch: true } };
  backend.requests = [];
  backend.invoke.mockReset();
  backend.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
    fakeBackend(command, args)
  );
  Object.values(globe.controller).forEach((mock) => mock.mockClear());
  useUiStore.setState(initialUi, true);
  useTracerouteStore.setState(initialTrace, true);
  useInfraStore.setState(initialInfra, true);
  delete document.documentElement.dataset.theme;
  fetchSpy = vi.fn(async (url: string) =>
    url === "./infra/cloud-regions.json"
      ? { ok: true, status: 200, json: async () => CLOUD_SNAPSHOT }
      : { ok: false, status: 404, json: async () => null }
  );
  vi.stubGlobal("fetch", fetchSpy);
});

let fetchSpy: ReturnType<typeof vi.fn>;
const invoked = (command: string) =>
  backend.invoke.mock.calls.filter(([name]) => name === command).length;

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("UI shell", () => {
  it("floats the panels over the globe and fills them from a trace", async () => {
    renderApp();
    expect(screen.getByRole("navigation", { name: "App controls" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "3D globe showing traceroute path" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Hop details" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Hop timeline" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Data sources and credits" })).toBeTruthy();
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));

    await trace("example.com");
    expect(backend.requests[0]).toMatchObject({ target: "example.com", protocol: "ICMP" });
    const timeline = screen.getByRole("listbox", { name: "Hops by round-trip time" });
    expect(within(timeline).getAllByRole("option")).toHaveLength(ROUTE.length);
    await waitFor(() =>
      expect(globe.controller.setScene.mock.calls.at(-1)?.[0].markers.length).toBeGreaterThan(0)
    );

    // Hover in the timeline: the card shows the hop, from the run in the store.
    fireEvent.mouseEnter(within(timeline).getAllByRole("option")[2]);
    expect(screen.getByRole("tooltip").textContent).toContain("Chennai, India");
    fireEvent.mouseLeave(within(timeline).getAllByRole("option")[2]);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("switches theme and a layer from the command bar and saves both", async () => {
    renderApp();
    await waitFor(() => expect(useUiStore.getState().loaded).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(commandSearch(), { target: { value: "light theme" } });
    fireEvent.keyDown(commandSearch(), { key: "Enter" });
    expect(document.documentElement.dataset.theme).toBe("light");

    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    fireEvent.click(screen.getByRole("switch", { name: "Online imagery" }));
    expect(globe.controller.setImagery).toHaveBeenLastCalledWith({ dayNight: true, online: false });

    await waitFor(() =>
      expect(settingsWrites().at(-1)?.[1]?.value).toEqual({
        theme: "light",
        layers: { "online-imagery": false },
        collapsed: { layers: false },
        consents: {}
      })
    );
  });

  it("starts a trace to a host typed in the command bar with the panel's options", async () => {
    renderApp();
    // The getting started dialog shows until the saved choice to skip it loads.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.change(screen.getByRole("combobox", { name: "Probe protocol" }), {
      target: { value: "UDP" }
    });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(commandSearch(), { target: { value: "example.org" } });
    await act(async () => {
      fireEvent.keyDown(commandSearch(), { key: "Enter" });
    });
    await waitFor(() => expect(backend.requests).toHaveLength(1));
    expect(backend.requests[0]).toMatchObject({ target: "example.org", protocol: "UDP" });
    expect(
      (screen.getByRole("textbox", { name: "Traceroute target" }) as HTMLInputElement).value
    ).toBe("example.org");
  });

  it("resets the trace options but keeps the target", async () => {
    renderApp();
    // Let the start-up settle: saved choices, the skipped guide, the globe.
    await waitFor(() => expect(useUiStore.getState().loaded).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(globe.controller.setScene).toHaveBeenCalled());
    const target = screen.getByRole("textbox", { name: "Traceroute target" }) as HTMLInputElement;
    fireEvent.change(target, { target: { value: "example.net" } });
    fireEvent.click(screen.getByRole("button", { name: "Trace options" }));
    const maxHops = screen.getByRole("spinbutton", { name: "Max hops" }) as HTMLInputElement;
    fireEvent.change(maxHops, { target: { value: "12" } });
    expect(maxHops.value).toBe("12");

    fireEvent.click(screen.getByRole("button", { name: "Reset options" }));
    expect((screen.getByRole("spinbutton", { name: "Max hops" }) as HTMLInputElement).value).toBe("30");
    expect(target.value).toBe("example.net");
  });

  it("keeps collapsed panels collapsed after a restart", async () => {
    const first = renderApp();
    await waitFor(() => expect(useUiStore.getState().loaded).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Hide hop details" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide hop timeline" }));
    await waitFor(() =>
      expect(backend.settings["preferences.ui"]).toEqual({
        theme: "dark",
        layers: {},
        collapsed: { hops: true, timeline: true },
        consents: {}
      })
    );
    first.unmount();

    useUiStore.setState(initialUi, true);
    renderApp();
    expect(await screen.findByRole("button", { name: "Show hop details" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show hop timeline" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Hop details" })).toBeNull();
  });

  it("loads no layer data while the infrastructure layers are off", async () => {
    renderApp();
    await waitFor(() => expect(useUiStore.getState().loaded).toBe(true));
    await trace("example.com");
    expect(invoked("get_peeringdb_sites")).toBe(0);
    expect(invoked("get_submarine_cables")).toBe(0);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).includes("infra/"))).toEqual([]);

    // Turned on from the command bar: exchanges and cloud regions load once.
    for (const query of ["show internet exchanges", "show cloud regions"]) {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      fireEvent.change(commandSearch(), { target: { value: query } });
      fireEvent.keyDown(commandSearch(), { key: "Enter" });
    }
    await waitFor(() => expect(useInfraStore.getState().sources["cloud-regions"].status).toBe("ready"));
    await waitFor(() => expect(useInfraStore.getState().sources["peeringdb-sites"].status).toBe("ready"));
    expect(invoked("get_peeringdb_sites")).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const scene = globe.controller.setScene.mock.calls.at(-1)?.[0];
    expect(scene.exchanges.length).toBeGreaterThan(0);
    expect(scene.cloudRegions.length).toBeGreaterThan(0);
    expect(invoked("get_submarine_cables")).toBe(0);
  });

  it("asks before the submarine cables, downloads once after consent and never while off", async () => {
    renderApp();
    await waitFor(() => expect(useUiStore.getState().loaded).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    const cables = () => screen.getByRole("switch", { name: "Submarine cables" }) as HTMLInputElement;

    // The notice first; declined, nothing is sent.
    fireEvent.click(cables());
    const notice = screen.getByRole("dialog", { name: "Show submarine cables?" });
    expect(notice.textContent).toContain("CC BY-NC-SA 3.0");
    expect(notice.textContent).toContain("www.submarinecablemap.com");
    fireEvent.click(within(notice).getByRole("button", { name: "Cancel" }));
    await act(async () => undefined);
    expect(invoked("get_submarine_cables")).toBe(0);
    expect(cables().checked).toBe(false);

    // Accepted: the switch and the consent are saved, then the map is asked for once.
    fireEvent.click(cables());
    fireEvent.click(screen.getByRole("button", { name: "Show and download" }));
    await waitFor(() => expect(useInfraStore.getState().sources["submarine-cables"].status).toBe("ready"));
    expect(invoked("get_submarine_cables")).toBe(1);
    const order = backend.invoke.mock.calls.map(([name, args]) =>
      name === "set_settings" ? `set_settings ${String(args?.key)}` : name
    );
    expect(order.lastIndexOf("set_settings preferences.ui")).toBeLessThan(order.indexOf("get_submarine_cables"));
    expect(screen.getByRole("button", { name: "Data sources and credits" }).textContent).toBe(
      "NASA, GIBS, CesiumJS, TeleGeography"
    );
    await waitFor(() => expect(globe.controller.setScene.mock.calls.at(-1)?.[0].cables.length).toBe(1));

    // Off and on again: no notice, no new request (the map stays in memory).
    fireEvent.click(cables());
    await waitFor(() => expect(globe.controller.setScene.mock.calls.at(-1)?.[0].cables).toEqual([]));
    expect(screen.getByRole("button", { name: "Data sources and credits" }).textContent).toBe(
      "NASA, GIBS, CesiumJS"
    );
    fireEvent.click(cables());
    expect(screen.queryByRole("dialog", { name: "Show submarine cables?" })).toBeNull();
    await waitFor(() => expect(globe.controller.setScene.mock.calls.at(-1)?.[0].cables.length).toBe(1));
    expect(invoked("get_submarine_cables")).toBe(1);
  });
});
