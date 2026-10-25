import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RendererApi } from "@common/bridge";
import { NO_EXCHANGE_LIST, OLD_EXCHANGE_LIST, readySource, useInfraStore } from "../infraStore";
import { useUiStore } from "../uiStore";

const initialInfra = useInfraStore.getState();
const initialUi = useUiStore.getState();

const sites = {
  storedAt: 1,
  complete: true,
  exchanges: [],
  facilities: [
    {
      id: 58,
      name: "Digital Realty FRA1",
      org: null,
      city: null,
      country: null,
      latitude: 50.12,
      longitude: 8.74,
      networkCount: 1,
      exchangeCount: 1
    }
  ]
};

let api: {
  getPeeringDbSites: ReturnType<typeof vi.fn>;
  getSubmarineCables: ReturnType<typeof vi.fn>;
  setSettings: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  api = {
    getPeeringDbSites: vi.fn().mockResolvedValue(sites),
    getSubmarineCables: vi.fn().mockResolvedValue({ fetchedAt: 1, note: null, cables: [] }),
    setSettings: vi.fn().mockResolvedValue(undefined)
  };
  window.visTracer = api as unknown as RendererApi;
  useInfraStore.setState(initialInfra, true);
  useUiStore.setState(initialUi, true);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("infraStore", () => {
  it("loads nothing until a layer asks, then loads once", async () => {
    expect(useInfraStore.getState().sources["peeringdb-sites"].status).toBe("idle");
    expect(api.getPeeringDbSites).not.toHaveBeenCalled();
    // The layer code (parsers, clustering, matching) comes with the first data.
    expect(useInfraStore.getState().code).toBeUndefined();
    await useInfraStore.getState().ensure("peeringdb-sites");
    expect(useInfraStore.getState().code?.parsePeeringDbSites).toBeTypeOf("function");
    await useInfraStore.getState().ensure("peeringdb-sites");
    expect(api.getPeeringDbSites).toHaveBeenCalledTimes(1);
    expect(readySource(useInfraStore.getState().sources, "peeringdb-sites")?.facilities).toHaveLength(1);
    expect(api.getSubmarineCables).not.toHaveBeenCalled();
  });

  it("logs how many malformed records a source dropped", async () => {
    api.getPeeringDbSites.mockResolvedValueOnce({
      ...sites,
      facilities: [...sites.facilities, { id: "bad" }, { ...sites.facilities[0], latitude: 91 }]
    });
    await useInfraStore.getState().ensure("peeringdb-sites");
    expect(
      readySource(useInfraStore.getState().sources, "peeringdb-sites")?.facilities
    ).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledWith(
      "The peeringdb-sites layer data had 2 malformed records; they are not shown."
    );
  });

  it("says what to do when there is no exchange list, or an old one", async () => {
    api.getPeeringDbSites.mockResolvedValueOnce(null);
    await useInfraStore.getState().ensure("peeringdb-sites");
    expect(useInfraStore.getState().sources["peeringdb-sites"]).toEqual({
      status: "unavailable",
      message: NO_EXCHANGE_LIST
    });
    api.getPeeringDbSites.mockResolvedValueOnce({ ...sites, complete: false, facilities: [] });
    await useInfraStore.getState().reload("peeringdb-sites");
    expect(useInfraStore.getState().sources["peeringdb-sites"]).toMatchObject({
      status: "ready",
      note: OLD_EXCHANGE_LIST
    });
  });

  it("reports a failed load and tries again only when asked again", async () => {
    api.getSubmarineCables.mockRejectedValueOnce(
      "Could not download the cable map from www.submarinecablemap.com: HTTP 503."
    );
    await useInfraStore.getState().ensure("submarine-cables");
    expect(useInfraStore.getState().sources["submarine-cables"]).toEqual({
      status: "error",
      message: "Could not download the cable map from www.submarinecablemap.com: HTTP 503."
    });
    expect(api.getSubmarineCables).toHaveBeenCalledTimes(1);
    await useInfraStore.getState().ensure("submarine-cables");
    expect(api.getSubmarineCables).toHaveBeenCalledTimes(2);
    expect(useInfraStore.getState().sources["submarine-cables"].status).toBe("ready");
  });

  it("writes the cable switch before it asks the backend, which checks the saved switch", async () => {
    const order: string[] = [];
    let finishWrite: () => void = () => undefined;
    api.setSettings.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push("write started");
          finishWrite = () => {
            order.push("write done");
            resolve();
          };
        })
    );
    api.getSubmarineCables.mockImplementation(async () => {
      order.push("cables asked");
      return { fetchedAt: 1, note: null, cables: [] };
    });
    useUiStore.setState({ loaded: true, consents: { "submarine-cables": true } });
    useUiStore.getState().setLayerVisible("submarine-cables", true);
    const loading = useInfraStore.getState().ensure("submarine-cables");
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishWrite();
    await loading;
    expect(order).toEqual(["write started", "write done", "cables asked"]);
  });

  it("loads the bundled cloud regions from the app, and refuses a malformed file", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ meta: { schema: 2 } }) });
    vi.stubGlobal("fetch", fetchMock);
    await useInfraStore.getState().ensure("cloud-regions");
    expect(fetchMock).toHaveBeenCalledWith("./infra/cloud-regions.json");
    expect(useInfraStore.getState().sources["cloud-regions"]).toMatchObject({
      status: "error",
      message: expect.stringContaining("this version reads layout 1")
    });
  });
});

describe("layer notices (uiStore)", () => {
  beforeEach(() => useUiStore.setState({ loaded: true }));

  it("opens the notice instead of showing the layer, and shows it after acceptance", async () => {
    const store = useUiStore.getState();
    store.setLayerVisible("submarine-cables", true);
    expect(useUiStore.getState().pendingConsent).toBe("submarine-cables");
    expect(useUiStore.getState().layers["submarine-cables"]).toBeUndefined();
    expect(api.setSettings).not.toHaveBeenCalled();

    useUiStore.getState().acceptConsent();
    await useUiStore.getState().whenSaved();
    expect(useUiStore.getState().pendingConsent).toBeUndefined();
    expect(api.setSettings).toHaveBeenLastCalledWith("preferences.ui", {
      theme: "dark",
      layers: { "submarine-cables": true },
      collapsed: {},
      consents: { "submarine-cables": true }
    });

    // Accepted once: off and on again needs no notice.
    useUiStore.getState().setLayerVisible("submarine-cables", false);
    useUiStore.getState().setLayerVisible("submarine-cables", true);
    expect(useUiStore.getState().pendingConsent).toBeUndefined();
    expect(useUiStore.getState().layers["submarine-cables"]).toBe(true);
  });

  it("keeps the layer off when the notice is declined", () => {
    useUiStore.getState().setLayerVisible("submarine-cables", true);
    useUiStore.getState().declineConsent();
    expect(useUiStore.getState().pendingConsent).toBeUndefined();
    expect(useUiStore.getState().layers["submarine-cables"]).toBeUndefined();
    expect(useUiStore.getState().consents).toEqual({});
    expect(api.setSettings).not.toHaveBeenCalled();
  });

  it("needs no notice for the other layers", () => {
    useUiStore.getState().setLayerVisible("exchanges", true);
    expect(useUiStore.getState().pendingConsent).toBeUndefined();
    expect(useUiStore.getState().layers.exchanges).toBe(true);
  });
});
