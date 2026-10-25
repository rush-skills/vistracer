import { useEffect, useMemo, useRef } from "react";
import type { HopResolution } from "@common/ipc";
import { EMPTY_INFRA_SCENE, type InfraScene, type SiteLayer } from "@renderer/lib/globe";
import { LAYER_LIST, layerActive, layerVisibility } from "@renderer/lib/layers";
import type { InfraCode } from "@renderer/lib/infra/code";
import type { InfraInput, RouteInfra, SiteClusters } from "@renderer/lib/infra/scene";
import { readySource, useInfraStore, type InfraSources } from "@renderer/state/infraStore";
import { selectCurrentRun, useTracerouteStore } from "@renderer/state/tracerouteStore";
import { useUiStore } from "@renderer/state/uiStore";

const NO_HOPS: HopResolution[] = [];

/** The layers that show the PeeringDB list exchange matching downloads. */
const EXCHANGE_LIST_LAYERS = LAYER_LIST.filter((layer) => layer.data === "peeringdb-sites").map(
  (layer) => layer.id
);

/** What the route has to do with the layers before their code is loaded: nothing. */
const NO_ROUTE_INFRA: RouteInfra = {
  exchangeLinks: new Map(),
  facilityLinks: new Map(),
  cloudMatches: new Map(),
  cableGuesses: [],
  shownProviders: []
};
const NO_CLUSTERS: SiteClusters = { exchanges: [], facilities: [], cloudRegions: [] };

/**
 * Loads the data of the infrastructure layers the user shows. Each layer
 * that is turned on (or shown at start) asks for its source; a source that
 * failed or had nothing yet is tried again then, so "turn the layer off and
 * on" works also while another layer with the same source stays on. After a
 * trace, a missing or old PeeringDB list is read again: exchange matching
 * may have downloaded one during the trace.
 */
export function useInfraLoading(): void {
  const saved = useUiStore((state) => state.layers);
  const shownKey = useMemo(() => {
    const visibility = layerVisibility(saved);
    return LAYER_LIST.filter((layer) => layer.data && layerActive(visibility, layer.id))
      .map((layer) => layer.id)
      .join(",");
  }, [saved]);
  const shownBefore = useRef<ReadonlySet<string>>(new Set());
  const status = useTracerouteStore((state) => state.status);

  useEffect(() => {
    const shown = new Set(shownKey ? shownKey.split(",") : []);
    const { ensure } = useInfraStore.getState();
    for (const layer of LAYER_LIST) {
      if (layer.data && shown.has(layer.id) && !shownBefore.current.has(layer.id)) {
        void ensure(layer.data);
      }
    }
    shownBefore.current = shown;
  }, [shownKey]);

  useEffect(() => {
    const shown = shownKey.split(",");
    if (status !== "success" || !EXCHANGE_LIST_LAYERS.some((id) => shown.includes(id))) {
      return;
    }
    const { sources, reload } = useInfraStore.getState();
    const source = sources["peeringdb-sites"];
    if (
      source.status === "unavailable" ||
      (source.status === "ready" && !source.data.complete)
    ) {
      void reload("peeringdb-sites");
    }
  }, [status, shownKey]);
}

function infraInput(sources: InfraSources): InfraInput {
  return {
    peeringdb: readySource(sources, "peeringdb-sites"),
    cloud: readySource(sources, "cloud-regions"),
    cables: readySource(sources, "submarine-cables")
  };
}

// One shared result for all components: the inputs are store values, so
// the same identities mean the same answer.
let lastRoute:
  | { hops: HopResolution[]; saved: Record<string, boolean>; sources: InfraSources; value: RouteInfra }
  | undefined;

function memoRouteInfra(
  { keepUnchanged, routeInfra }: InfraCode,
  hops: HopResolution[],
  saved: Record<string, boolean>,
  sources: InfraSources
): RouteInfra {
  if (!lastRoute || lastRoute.hops !== hops || lastRoute.saved !== saved || lastRoute.sources !== sources) {
    lastRoute = {
      hops,
      saved,
      sources,
      value: keepUnchanged(
        lastRoute?.value,
        routeInfra(hops, layerVisibility(saved), infraInput(sources))
      )
    };
  }
  return lastRoute.value;
}

/** Exchange and data centre links, cloud matches and cable guesses of the current route. */
export function useRouteInfra(): RouteInfra {
  const hops = useTracerouteStore((state) => selectCurrentRun(state)?.hops) ?? NO_HOPS;
  const saved = useUiStore((state) => state.layers);
  const sources = useInfraStore((state) => state.sources);
  const code = useInfraStore((state) => state.code);
  return code ? memoRouteInfra(code, hops, saved, sources) : NO_ROUTE_INFRA;
}

export interface InfraView {
  scene: InfraScene;
  /** The site keys behind a picked marker, for the hover card. */
  members: (specKey: string) => { layer: SiteLayer | "cables"; keys: string[] } | undefined;
}

/**
 * The infrastructure items of the globe scene at a cluster level. Each
 * step is memoised on its own inputs: clustering runs when the data, the
 * switches, the route or the level change. A hover changes nothing here:
 * the adapter restyles the hovered marker (`setHoveredSite`).
 */
export function useInfraScene(level: number): InfraView {
  const saved = useUiStore((state) => state.layers);
  const sources = useInfraStore((state) => state.sources);
  const code = useInfraStore((state) => state.code);
  const route = useRouteInfra();
  const input = useMemo(() => infraInput(sources), [sources]);
  const visibility = useMemo(() => layerVisibility(saved), [saved]);
  const clusters = useMemo(
    () => code?.buildSiteClusters(visibility, level, input, route) ?? NO_CLUSTERS,
    [code, visibility, level, input, route]
  );
  const lines = useMemo(
    () => (code && input.cables ? code.cableLines(input.cables.cables) : []),
    [code, input.cables]
  );
  const cables = useMemo(
    () =>
      code && visibility["submarine-cables"] ? code.cableSpecs(lines, route.cableGuesses) : [],
    [code, visibility, lines, route.cableGuesses]
  );
  const scene = useMemo(
    () =>
      code &&
      (clusters.exchanges.length + clusters.facilities.length + clusters.cloudRegions.length > 0 ||
        cables.length > 0)
        ? code.infraScene(clusters, cables)
        : EMPTY_INFRA_SCENE,
    [code, clusters, cables]
  );
  const members = useMemo(() => {
    const byKey = new Map<string, { layer: SiteLayer | "cables"; keys: string[] }>();
    if (!code) {
      return () => undefined;
    }
    for (const sites of [clusters.exchanges, clusters.facilities, clusters.cloudRegions]) {
      for (const site of sites) {
        byKey.set(code.siteSpecKey(site.layer, site.cluster.key), {
          layer: site.layer,
          keys: site.cluster.members
        });
      }
    }
    return (specKey: string) => {
      const site = byKey.get(specKey);
      if (site) {
        return site;
      }
      // Cable line keys are "<cable key>#<line>"; the cable id may contain "#".
      const hash = specKey.lastIndexOf("#");
      return specKey.startsWith("cable:") && hash > 0
        ? { layer: "cables" as const, keys: [specKey.slice(0, hash)] }
        : undefined;
    };
  }, [code, clusters]);
  return { scene, members };
}
