import { create } from "zustand";
import type { InfraCode } from "@renderer/lib/infra/code";
import type {
  CableData,
  CloudRegionData,
  InfraSourceId,
  PeeringDbSiteData,
  SatelliteGroupData
} from "@renderer/lib/infra/sources";
import {
  CLOCK_TOLERANCE_MS,
  MAX_SATELLITES_PER_GROUP,
  SATELLITE_DATA_TTL_MS,
  SATELLITE_GROUPS,
  type SatelliteGroupId,
  type SatelliteSourceId
} from "@renderer/lib/satellites/groups";
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
  /** `staleAt`: after this time (ms), turning the layer on again loads the data again. */
  | { status: "ready"; data: T; note?: string; staleAt?: number }
  /** Nothing to show yet, and no error: says what to do. */
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string };

export type InfraData = {
  "peeringdb-sites": PeeringDbSiteData;
  "cloud-regions": CloudRegionData;
  "submarine-cables": CableData;
} & { [K in SatelliteSourceId]: SatelliteGroupData };

export type InfraSources = { [K in InfraSourceId]: SourceState<InfraData[K]> };

/** A site marker, cable or satellite under the pointer on the globe. */
export interface SiteHover {
  /** The picked marker, cable line or satellite (its spec or elements key). */
  specKey: string;
  layer: SiteLayer | "cables" | "satellites";
  /** Keys of the sites in the marker's cluster, the drawn one first. */
  keys: string[];
  anchor: HoverAnchor;
  /** A satellite's height above the ellipsoid when the pointer reached it. */
  heightKm?: number;
}

export interface InfraStore {
  sources: InfraSources;
  /** Parsers, clustering and matching; loaded with the first layer data. */
  code?: InfraCode;
  hoveredSite?: SiteHover;
  /**
   * Loads a source unless it is loaded or loading. A failed load, one that
   * had nothing to show yet, or data past its `staleAt` is loaded again;
   * stale data stays shown meanwhile.
   */
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

type Loaded<T> = { data: T; note?: string; staleAt?: number } | { unavailable: string };

type Loader<K extends InfraSourceId> = (code: InfraCode) => Promise<Loaded<InfraData[K]>>;

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

function satelliteLoader(
  group: SatelliteGroupId
): (code: InfraCode) => Promise<Loaded<SatelliteGroupData>> {
  return async ({ parseSatelliteGroup }) => {
    // The backend downloads a group only when the saved settings have the
    // layer, the group and the notice, so the switches are written first.
    await useUiStore.getState().whenSaved();
    const raw = await window.visTracer.getSatellites(SATELLITE_GROUPS[group].celestrak);
    const data = parseSatelliteGroup(raw, group);
    const count = data.satellites.length;
    const shown =
      count > MAX_SATELLITES_PER_GROUP
        ? `Showing ${plural(MAX_SATELLITES_PER_GROUP, "satellite")} of ${count.toLocaleString("en-US")}, evenly chosen, to keep the globe fast.`
        : plural(count, "satellite") + ".";
    // A copy dated in the future is asked for again the next time the group
    // is turned on; the backend decides whether it may download.
    const now = Date.now();
    return {
      data,
      note: [shown, data.note].filter(Boolean).join(" "),
      staleAt:
        data.fetchedAt > now + CLOCK_TOLERANCE_MS ? now : data.fetchedAt + SATELLITE_DATA_TTL_MS
    };
  };
}

const LOADERS: { [K in InfraSourceId]: Loader<K> } = {
  "peeringdb-sites": async ({ parsePeeringDbSites }) => {
    const data = parsePeeringDbSites(await window.visTracer.getPeeringDbSites());
    if (!data) {
      return { unavailable: NO_EXCHANGE_LIST };
    }
    return { data, note: data.complete ? undefined : OLD_EXCHANGE_LIST };
  },
  "cloud-regions": async ({ parseCloudRegions }) => {
    const response = await fetch("./infra/cloud-regions.json");
    if (!response.ok) {
      throw new Error(`The bundled cloud region file did not load (HTTP ${response.status}).`);
    }
    return { data: parseCloudRegions(await response.json()) };
  },
  "submarine-cables": async ({ parseSubmarineCables }) => {
    // The backend downloads only when the saved settings have the layer on
    // and its notice accepted, so the switch must be written first.
    await useUiStore.getState().whenSaved();
    const data = parseSubmarineCables(await window.visTracer.getSubmarineCables());
    return { data, note: data.note ?? undefined };
  },
  "celestrak-starlink": satelliteLoader("starlink"),
  "celestrak-oneweb": satelliteLoader("oneweb"),
  "celestrak-gps": satelliteLoader("gps"),
  "celestrak-stations": satelliteLoader("stations"),
  "celestrak-geo": satelliteLoader("geo")
};

const IDLE = { status: "idle" } as const;
const INITIAL: InfraSources = {
  "peeringdb-sites": IDLE,
  "cloud-regions": IDLE,
  "submarine-cables": IDLE,
  "celestrak-starlink": IDLE,
  "celestrak-oneweb": IDLE,
  "celestrak-gps": IDLE,
  "celestrak-stations": IDLE,
  "celestrak-geo": IDLE
};

// One import for every source; a failed import (a missing chunk) is tried again.
let codeImport: Promise<InfraCode> | undefined;
const importCode = () =>
  (codeImport ??= import("@renderer/lib/infra/code").catch((error: unknown) => {
    codeImport = undefined;
    throw error;
  }));

export const useInfraStore = create<InfraStore>((set, get) => {
  const load = async (id: InfraSourceId) => {
    const update = (state: SourceState<InfraData[typeof id]>) =>
      set((store) => ({ sources: { ...store.sources, [id]: state } }));
    const shown = get().sources[id];
    // Stale data stays on the globe while a newer copy loads.
    if (shown.status !== "ready") {
      update({ status: "loading" });
    }
    try {
      const code = get().code ?? (await importCode());
      if (!get().code) {
        set({ code });
      }
      const loaded = await LOADERS[id](code);
      if ("data" in loaded && loaded.data.rejected > 0) {
        // One bad record never hides the others; the count says the source changed shape.
        console.warn(
          `The ${id} layer data had ${loaded.data.rejected} malformed records; they are not shown.`
        );
      }
      if ("unavailable" in loaded) {
        update({ status: "unavailable", message: loaded.unavailable });
      } else {
        // The same download again (an older copy the backend keeps while it
        // may not ask CelesTrak) keeps its object: the globe then rebuilds
        // no points and no SGP4 records.
        const before = shown.status === "ready" ? shown.data : undefined;
        const same =
          before != null &&
          "fetchedAt" in before &&
          "fetchedAt" in loaded.data &&
          before.fetchedAt === loaded.data.fetchedAt;
        update({
          status: "ready",
          data: same ? before : loaded.data,
          note: loaded.note,
          staleAt: loaded.staleAt
        });
      }
    } catch (error) {
      console.warn(`Could not load the ${id} layer data.`, error);
      update(
        shown.status === "ready"
          ? { ...shown, note: `Could not load a newer copy: ${errorText(error)}` }
          : { status: "error", message: errorText(error) }
      );
    }
  };
  return {
    sources: INITIAL,
    ensure: async (id) => {
      const source = get().sources[id];
      const stale =
        source.status === "ready" && source.staleAt != null && Date.now() >= source.staleAt;
      if (
        source.status === "idle" ||
        source.status === "error" ||
        source.status === "unavailable" ||
        stale
      ) {
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
