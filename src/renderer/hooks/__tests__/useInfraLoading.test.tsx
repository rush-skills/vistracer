import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import type { RendererApi } from "@common/bridge";
import { useInfraLoading } from "@renderer/hooks/useInfra";
import { NO_EXCHANGE_LIST, useInfraStore } from "@renderer/state/infraStore";
import { useTracerouteStore } from "@renderer/state/tracerouteStore";
import { useUiStore } from "@renderer/state/uiStore";
import cloudRegions from "../../public/infra/cloud-regions.json";

const initialInfra = useInfraStore.getState();
const initialUi = useUiStore.getState();
const initialTrace = useTracerouteStore.getState();

const Loader = () => {
  useInfraLoading();
  return null;
};

const sites = { complete: true, exchanges: [], facilities: [] };
let getPeeringDbSites: ReturnType<typeof vi.fn>;

const setLayers = (layers: Record<string, boolean>) => act(() => useUiStore.setState({ layers }));

beforeEach(() => {
  getPeeringDbSites = vi.fn().mockResolvedValue(null);
  window.visTracer = { getPeeringDbSites } as unknown as RendererApi;
  useInfraStore.setState(initialInfra, true);
  useUiStore.setState(initialUi, true);
  useTracerouteStore.setState(initialTrace, true);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useInfraLoading", () => {
  it("reads a source again when one of its layers is turned off and on", async () => {
    render(<Loader />);
    expect(getPeeringDbSites).not.toHaveBeenCalled();

    // Two layers share the exchange list: one read.
    setLayers({ exchanges: true, "data-centres": true });
    await waitFor(() =>
      expect(useInfraStore.getState().sources["peeringdb-sites"]).toEqual({
        status: "unavailable",
        message: NO_EXCHANGE_LIST
      })
    );
    expect(getPeeringDbSites).toHaveBeenCalledTimes(1);

    // Data centres stay on; exchanges off and on again reads the list again.
    getPeeringDbSites.mockResolvedValueOnce(sites);
    setLayers({ exchanges: false, "data-centres": true });
    expect(getPeeringDbSites).toHaveBeenCalledTimes(1);
    setLayers({ exchanges: true, "data-centres": true });
    await waitFor(() =>
      expect(useInfraStore.getState().sources["peeringdb-sites"].status).toBe("ready")
    );
    expect(getPeeringDbSites).toHaveBeenCalledTimes(2);

    // Loaded data is kept: off and on again reads nothing.
    setLayers({ exchanges: false, "data-centres": false });
    setLayers({ exchanges: true, "data-centres": false });
    expect(getPeeringDbSites).toHaveBeenCalledTimes(2);
  });

  it("tries a failed source again only when a layer that needs it is turned on", async () => {
    getPeeringDbSites.mockRejectedValueOnce(new Error("backend busy"));
    render(<Loader />);
    setLayers({ exchanges: true, "data-centres": true });
    await waitFor(() =>
      expect(useInfraStore.getState().sources["peeringdb-sites"].status).toBe("error")
    );
    // Another layer changing does not retry.
    setLayers({ exchanges: true, "data-centres": true, "cloud-regions": false, labels: false });
    expect(getPeeringDbSites).toHaveBeenCalledTimes(1);
    setLayers({ exchanges: true, "data-centres": false });
    setLayers({ exchanges: true, "data-centres": true });
    await waitFor(() => expect(getPeeringDbSites).toHaveBeenCalledTimes(2));
  });

  it("reads a missing exchange list again after a trace, for the layers that show it", async () => {
    render(<Loader />);
    setLayers({ "data-centres": true });
    await waitFor(() =>
      expect(useInfraStore.getState().sources["peeringdb-sites"].status).toBe("unavailable")
    );
    expect(getPeeringDbSites).toHaveBeenCalledTimes(1);
    // Exchange matching may have downloaded the list during the trace.
    getPeeringDbSites.mockResolvedValueOnce(sites);
    act(() => useTracerouteStore.setState({ status: "success" }));
    await waitFor(() =>
      expect(useInfraStore.getState().sources["peeringdb-sites"].status).toBe("ready")
    );
    expect(getPeeringDbSites).toHaveBeenCalledTimes(2);
  });

  it("does not read the missing exchange list after a trace while only other layers show", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(cloudRegions))));
    // An earlier read found no list, so a reload is possible.
    useInfraStore.setState((state) => ({
      sources: {
        ...state.sources,
        "peeringdb-sites": { status: "unavailable", message: NO_EXCHANGE_LIST }
      }
    }));
    render(<Loader />);
    setLayers({ "cloud-regions": true });
    await waitFor(() =>
      expect(useInfraStore.getState().sources["cloud-regions"].status).toBe("ready")
    );

    act(() => useTracerouteStore.setState({ status: "running" }));
    act(() => useTracerouteStore.setState({ status: "success" }));
    // A reload would call the backend after the layer code promise.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(getPeeringDbSites).not.toHaveBeenCalled();
    expect(useInfraStore.getState().sources["peeringdb-sites"].status).toBe("unavailable");
  });
});
