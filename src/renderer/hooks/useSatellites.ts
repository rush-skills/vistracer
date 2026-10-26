import { useMemo, useRef } from "react";
import type { HopResolution } from "@common/ipc";
import type { SatelliteGroupData } from "@renderer/lib/infra/sources";
import { layerVisibility, satelliteGroupsForLayers } from "@renderer/lib/layers";
import {
  SATELLITE_GROUP_IDS,
  satelliteSourceId,
  type SatelliteGroupId
} from "@renderer/lib/satellites/groups";
import { routeConstellations, satelliteLinks, type SatelliteLink } from "@renderer/lib/satellites/isp";
import type { SatelliteGroupDrawing } from "@renderer/lib/satellites/scene";
import { readySource, useInfraStore, type InfraSources } from "@renderer/state/infraStore";
import { selectCurrentRun, useTracerouteStore } from "@renderer/state/tracerouteStore";
import { useUiStore } from "@renderer/state/uiStore";

const NO_HOPS: HopResolution[] = [];
const NO_DRAWING: readonly SatelliteGroupDrawing[] = Object.freeze([]);

/** Likely or possible satellite links of the current route, by hop, from the hops' ASNs. */
export function useSatelliteLinks(): ReadonlyMap<number, SatelliteLink> {
  const hops = useTracerouteStore((state) => selectCurrentRun(state)?.hops) ?? NO_HOPS;
  return useMemo(() => satelliteLinks(hops), [hops]);
}

/** The loaded data of every satellite group, shown or not. */
export function satelliteData(
  sources: InfraSources
): Partial<Record<SatelliteGroupId, SatelliteGroupData>> {
  const data: Partial<Record<SatelliteGroupId, SatelliteGroupData>> = {};
  for (const group of SATELLITE_GROUP_IDS) {
    const ready = readySource(sources, satelliteSourceId(group));
    if (ready) {
      data[group] = ready;
    }
  }
  return data;
}

/**
 * What the globe draws for the satellites layer. The result keeps its
 * identity while the shown groups' data and the highlighted groups are the
 * same, so another source loading or a hop event does not make the adapter
 * rebuild thousands of points.
 */
export function useSatelliteDrawing(): readonly SatelliteGroupDrawing[] {
  const saved = useUiStore((state) => state.layers);
  const sources = useInfraStore((state) => state.sources);
  const code = useInfraStore((state) => state.code);
  const links = useSatelliteLinks();
  const last = useRef<
    { inputs: readonly unknown[]; drawing: readonly SatelliteGroupDrawing[] } | undefined
  >(undefined);

  const shown = satelliteGroupsForLayers(layerVisibility(saved));
  const data = satelliteData(sources);
  const groups = shown.flatMap((group) => (data[group] ? [data[group]] : []));
  const highlighted = [...routeConstellations(links)].sort();
  const inputs = [code, ...groups, "|", ...highlighted];
  const previous = last.current;
  if (
    previous &&
    previous.inputs.length === inputs.length &&
    previous.inputs.every((input, i) => input === inputs[i])
  ) {
    return previous.drawing;
  }
  const drawing =
    code && groups.length > 0 ? code.satelliteDrawing(groups, new Set(highlighted)) : NO_DRAWING;
  last.current = { inputs, drawing };
  return drawing;
}
