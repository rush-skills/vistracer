import { useEffect, useMemo } from "react";
import type { HopResolution } from "@common/ipc";
import { EMPTY_INFRA_SCENE, type InfraScene, type SiteLayer } from "@renderer/lib/globe";
import { layerVisibility, sourcesForLayers } from "@renderer/lib/layers";
import {
  buildSiteClusters,
  cableLines,
  cableSpecs,
  infraScene,
  routeInfra,
  siteSpecKey,
  type InfraInput,
  type RouteInfra
} from "@renderer/lib/infra/scene";
import type { InfraSourceId } from "@renderer/lib/infra/sources";
import { readySource, useInfraStore, type InfraSources } from "@renderer/state/infraStore";
import { selectCurrentRun, useTracerouteStore } from "@renderer/state/tracerouteStore";
import { useUiStore } from "@renderer/state/uiStore";

const NO_HOPS: HopResolution[] = [];

/**
 * Loads the data of the infrastructure layers the user shows, the first
 * time each is shown. It runs when the set of needed sources changes (a
 * user action), so a failed load is tried again only when the user turns
 * the layer on again. After a trace, a missing or old PeeringDB list is read
 * again: exchange matching may have downloaded one during the trace.
 */
export function useInfraLoading(): void {
  const saved = useUiStore((state) => state.layers);
  const needed = useMemo(() => [...sourcesForLayers(layerVisibility(saved))].sort(), [saved]);
  const neededKey = needed.join(",");
  const status = useTracerouteStore((state) => state.status);

  useEffect(() => {
    const { ensure } = useInfraStore.getState();
    for (const id of neededKey ? (neededKey.split(",") as InfraSourceId[]) : []) {
      void ensure(id);
    }
  }, [neededKey]);

  useEffect(() => {
    if (status !== "success" || !neededKey.split(",").includes("peeringdb-sites")) {
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
  }, [status, neededKey]);
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
  hops: HopResolution[],
  saved: Record<string, boolean>,
  sources: InfraSources
): RouteInfra {
  if (!lastRoute || lastRoute.hops !== hops || lastRoute.saved !== saved || lastRoute.sources !== sources) {
    lastRoute = {
      hops,
      saved,
      sources,
      value: routeInfra(hops, layerVisibility(saved), infraInput(sources))
    };
  }
  return lastRoute.value;
}

/** Exchange and data centre links, cloud matches and cable guesses of the current route. */
export function useRouteInfra(): RouteInfra {
  const hops = useTracerouteStore((state) => selectCurrentRun(state)?.hops) ?? NO_HOPS;
  const saved = useUiStore((state) => state.layers);
  const sources = useInfraStore((state) => state.sources);
  return memoRouteInfra(hops, saved, sources);
}

export interface InfraView {
  scene: InfraScene;
  /** The site keys behind a picked marker, for the hover card. */
  members: (specKey: string) => { layer: SiteLayer | "cables"; keys: string[] } | undefined;
}

/**
 * The infrastructure items of the globe scene at a cluster level. Each
 * step is memoised on its own inputs: clustering runs when the data, the
 * switches, the route or the level change; a hover only restyles markers.
 */
export function useInfraScene(level: number, hoveredKey: string | undefined): InfraView {
  const saved = useUiStore((state) => state.layers);
  const sources = useInfraStore((state) => state.sources);
  const route = useRouteInfra();
  const input = useMemo(() => infraInput(sources), [sources]);
  const visibility = useMemo(() => layerVisibility(saved), [saved]);
  const clusters = useMemo(
    () => buildSiteClusters(visibility, level, input, route),
    [visibility, level, input, route]
  );
  const lines = useMemo(() => (input.cables ? cableLines(input.cables.cables) : []), [input.cables]);
  const cables = useMemo(
    () => (visibility["submarine-cables"] ? cableSpecs(lines, route.cableGuesses) : []),
    [visibility, lines, route.cableGuesses]
  );
  const scene = useMemo(
    () =>
      clusters.exchanges.length + clusters.facilities.length + clusters.cloudRegions.length > 0 ||
      cables.length > 0
        ? infraScene(clusters, cables, hoveredKey)
        : EMPTY_INFRA_SCENE,
    [clusters, cables, hoveredKey]
  );
  const members = useMemo(() => {
    const byKey = new Map<string, { layer: SiteLayer | "cables"; keys: string[] }>();
    for (const sites of [clusters.exchanges, clusters.facilities, clusters.cloudRegions]) {
      for (const site of sites) {
        byKey.set(siteSpecKey(site.layer, site.cluster.key), {
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
      const cable = /^(cable:[^#]+)#\d+$/.exec(specKey);
      return cable ? { layer: "cables" as const, keys: [cable[1]] } : undefined;
    };
  }, [clusters]);
  return { scene, members };
}
