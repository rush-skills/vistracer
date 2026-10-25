import type { SatelliteElements, SatelliteGroupData } from "../infra/sources";
import { MAX_SATELLITES_PER_GROUP, SATELLITE_GROUPS, type SatelliteGroupId } from "./groups";

/**
 * What the globe draws for the satellites layer: one point collection per
 * shown group. Positions are not part of it: the adapter computes them
 * from `satellites` with SGP4 (lib/satellites/propagate.ts) at a bounded
 * rate (lib/satellites/clock.ts).
 */

export interface SatelliteGroupDrawing {
  group: SatelliteGroupId;
  /**
   * The drawn satellites, at most MAX_SATELLITES_PER_GROUP. The same array
   * while the group's data is the same, so the adapter keeps its SGP4 records.
   */
  satellites: readonly SatelliteElements[];
  color: string;
  /** 0–1. */
  opacity: number;
  pixelSize: number;
  /** A satellite internet provider of this group is on the route. */
  highlighted: boolean;
}

const drawn = new WeakMap<SatelliteGroupData, readonly SatelliteElements[]>();

/** `max` elements spread evenly over `items` (all of them when there are fewer). */
export function thinEvenly<T>(items: readonly T[], max: number): readonly T[] {
  if (items.length <= max) {
    return items;
  }
  return Array.from({ length: max }, (_, i) => items[Math.floor((i * items.length) / max)]);
}

export function satelliteDrawing(
  groups: readonly SatelliteGroupData[],
  highlighted: ReadonlySet<SatelliteGroupId>
): SatelliteGroupDrawing[] {
  return groups.map((data) => {
    let satellites = drawn.get(data);
    if (!satellites) {
      satellites = thinEvenly(data.satellites, MAX_SATELLITES_PER_GROUP);
      drawn.set(data, satellites);
    }
    const style = SATELLITE_GROUPS[data.group];
    const lit = highlighted.has(data.group);
    return {
      group: data.group,
      satellites,
      color: style.color,
      // The constellation the route uses stands out: opaque and larger.
      opacity: lit ? 1 : 0.8,
      pixelSize: style.pixelSize + (lit ? 2 : 0),
      highlighted: lit
    };
  });
}

/** The point under the pointer: larger, with a white outline. */
export function hoveredSatelliteStyle(drawing: SatelliteGroupDrawing): {
  pixelSize: number;
  outlineWidth: number;
} {
  return { pixelSize: drawing.pixelSize + 4, outlineWidth: 2 };
}
