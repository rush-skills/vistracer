import type { SatelliteElements } from "../infra/sources";
import type { SatelliteGroupId } from "./groups";
import type { SatelliteGroupDrawing } from "./scene";

/**
 * What the globe adapter does with its point collections for a new
 * drawing. A group whose `satellites` are the same array keeps its points
 * and SGP4 records and only takes the new style (the route's highlight);
 * a drawn group that is gone or has other satellites is removed; a new or
 * changed group is built. So a highlight change or another group switched
 * on never rebuilds Starlink's 11,000 points.
 */
export function planSatelliteGroups(
  drawn: ReadonlyMap<SatelliteGroupId, readonly SatelliteElements[]>,
  next: readonly SatelliteGroupDrawing[]
): {
  remove: SatelliteGroupId[];
  keep: SatelliteGroupDrawing[];
  build: SatelliteGroupDrawing[];
} {
  const wanted = new Map(next.map((drawing) => [drawing.group, drawing]));
  const remove = [...drawn.entries()]
    .filter(([group, satellites]) => wanted.get(group)?.satellites !== satellites)
    .map(([group]) => group);
  const keep = next.filter((drawing) => drawn.get(drawing.group) === drawing.satellites);
  const build = next.filter((drawing) => drawn.get(drawing.group) !== drawing.satellites);
  return { remove, keep, build };
}
