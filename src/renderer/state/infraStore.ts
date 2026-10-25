import { create } from "zustand";
import {
  parseCloudRegions,
  parsePeeringDbSites,
  parseSubmarineCables,
  type CableData,
  type CloudRegionData,
  type InfraSourceId,
  type PeeringDbSiteData
} from "@renderer/lib/infra/sources";
import type { SiteLayer } from "@renderer/lib/globe";
import type { HoverAnchor } from "./tracerouteStore";
import { useUiStore } from "./uiStore";

/**
 * The data of the infrastructure layers. Each source loads the first time a
 * layer that needs it is shown (`ensure`), never at start-up; hiding the
 * layer keeps the data, so showing it again makes no new request.
 */

export type SourceState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T; note?: string }
  /** Nothing to show yet, and no error: says what to do. */
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

export interface InfraData {
  "peeringdb-sites": PeeringDbSiteData;
  "cloud-regions": CloudRegionData;
  "submarine-cables": CableData;
}

export type InfraSources = { [K in InfraSourceId]: SourceState<InfraData[K]> };

/** A site marker (or cable) under the pointer on the globe. */
export interface SiteHover {
  /** The picked marker or cable line (SiteSpec / CableSpec key). */
  specKey: string;
  layer: SiteLayer | "cables";
  /** Keys of the sites in the marker's cluster, the drawn one first. */
  keys: string[];
  anchor: HoverAnchor;
}

export interface InfraStore {
  sources: InfraSources;
  hoveredSite?: SiteHover;
  /** Loads a source unless it is loaded or loading; a failed load is tried again. */
  ensure: (id: InfraSourceId) => Promise<void>;
  /** Loads again: the PeeringDB list after a trace, when there was none. */
  reload: (id: InfraSourceId) => Promise<void>;
  setHoveredSite: (hover: SiteHover | undefined) => void;
}

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";

export const NO_EXCHANGE_LIST =
  "No exchange list yet. It downloads with your next trace while exchange matching (Integration settings → Internet exchanges) is on.";
export const OLD_EXCHANGE_LIST =
  "This exchange list was saved by an older version and has no data centres; your next trace with exchange matching on replaces it.";

type Loaded<T> = { data: T; note?: string } | { unavailable: string };

const LOADERS: { [K in InfraSourceId]: () => Promise<Loaded<InfraData[K]>> } = {
  "peeringdb-sites": async () => {
    const data = parsePeeringDbSites(await window.visTracer.getPeeringDbSites());
    if (!data) {
      return { unavailable: NO_EXCHANGE_LIST };
    }
    return { data, note: data.complete ? undefined : OLD_EXCHANGE_LIST };
  },
  "cloud-regions": async () => {
    const response = await fetch("./infra/cloud-regions.json");
    if (!response.ok) {
      throw new Error(`The bundled cloud region file did not load (HTTP ${response.status}).`);
    }
    return { data: parseCloudRegions(await response.json()) };
  },
  "submarine-cables": async () => {
    // The backend downloads only when the saved settings have the layer on
    // and its notice accepted, so the switch must be written first.
    await useUiStore.getState().whenSaved();
    const data = parseSubmarineCables(await window.visTracer.getSubmarineCables());
    return { data, note: data.note ?? undefined };
  }
};

const INITIAL: InfraSources = {
  "peeringdb-sites": { status: "idle" },
  "cloud-regions": { status: "idle" },
  "submarine-cables": { status: "idle" }
};

export const useInfraStore = create<InfraStore>((set, get) => {
  const load = async (id: InfraSourceId) => {
    const update = (state: SourceState<InfraData[typeof id]>) =>
      set((store) => ({ sources: { ...store.sources, [id]: state } }));
    update({ status: "loading" });
    try {
      const loaded = await LOADERS[id]();
      if ("data" in loaded && loaded.data.rejected > 0) {
        // One bad record never hides the others; the count says the source changed shape.
        console.warn(
          `The ${id} layer data had ${loaded.data.rejected} malformed records; they are not shown.`
        );
      }
      update(
        "unavailable" in loaded
          ? { status: "unavailable", message: loaded.unavailable }
          : { status: "ready", data: loaded.data, note: loaded.note }
      );
    } catch (error) {
      console.warn(`Could not load the ${id} layer data.`, error);
      update({ status: "error", message: errorText(error) });
    }
  };
  return {
    sources: INITIAL,
    ensure: async (id) => {
      const { status } = get().sources[id];
      if (status === "idle" || status === "error") {
        await load(id);
      }
    },
    reload: async (id) => {
      if (get().sources[id].status !== "loading") {
        await load(id);
      }
    },
    setHoveredSite: (hover) => set({ hoveredSite: hover })
  };
});

/** The data of a source when it is loaded. */
export function readySource<K extends InfraSourceId>(
  sources: InfraSources,
  id: K
): InfraData[K] | undefined {
  const state = sources[id] as SourceState<InfraData[K]>;
  return state.status === "ready" ? state.data : undefined;
}
