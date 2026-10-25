import { greatCircleKm } from "../globe";

/**
 * Declutters the site markers of the infrastructure layers. Sites closer
 * than one cell join the most important site near them (a "seed"), so the
 * globe shows one marker per area at every zoom: a few hundred far out,
 * single buildings close up. The cell size follows the camera height in
 * steps (`clusterLevel`), so clusters change only at a few heights and not
 * on every frame of a zoom.
 */

/** Target distance between two markers on screen, in CSS pixels. */
export const CLUSTER_SPACING_PX = 36;
/** Cells are 2^level km: level 0 (1 km, one campus) to level 12 (4,096 km). */
export const MAX_CLUSTER_LEVEL = 12;

/**
 * The cluster level for a view: `kmPerPx` is the ground distance of one
 * pixel at the centre of the view. The cell is the smallest power of two
 * at least `CLUSTER_SPACING_PX` pixels wide.
 */
export function clusterLevel(kmPerPx: number): number {
  if (!Number.isFinite(kmPerPx) || kmPerPx <= 0) {
    return MAX_CLUSTER_LEVEL;
  }
  const level = Math.ceil(Math.log2(kmPerPx * CLUSTER_SPACING_PX));
  return Math.min(MAX_CLUSTER_LEVEL, Math.max(0, level));
}

export const cellKmForLevel = (level: number): number => 2 ** level;

/**
 * Ground distance per pixel at the centre of a top-down view, for a
 * perspective camera `heightM` above the ground with horizontal field of
 * view `fovRad` over `widthPx` pixels.
 */
export function kmPerPixel(heightM: number, fovRad: number, widthPx: number): number {
  return (2 * heightM * Math.tan(fovRad / 2)) / Math.max(1, widthPx) / 1000;
}

export interface ClusterPoint {
  key: string;
  latitude: number;
  longitude: number;
  /** Larger first: the seed of a cluster is its most important site. */
  weight: number;
  /** Always a seed and never joins another site (sites on the route). */
  pinned?: boolean;
}

export interface Cluster {
  /** The seed's key. */
  key: string;
  latitude: number;
  longitude: number;
  /** Keys of the sites in the cluster, the seed first. */
  members: string[];
  pinned: boolean;
}

const KM_PER_DEGREE = 111.195;
const EARTH_RADIUS_KM = 6371;

/**
 * How many columns to each side can hold a site within `cellKm` of a site
 * at `latitude`. From the haversine formula, hav(d) ≥ cos φ1 · cos φ2 ·
 * hav(Δλ), and both latitudes are at most one cell further from the
 * equator, so sin(Δλ / 2) ≤ sin(d / 2R) / cos(|φ| + cell). Near a pole
 * every column can.
 */
function columnReach(latitude: number, cellKm: number, cellDeg: number, columns: number): number {
  const all = Math.ceil(columns / 2);
  const extreme = Math.abs(latitude) + cellDeg;
  if (extreme >= 90) {
    return all;
  }
  const bound = Math.sin(cellKm / (2 * EARTH_RADIUS_KM)) / Math.cos((extreme * Math.PI) / 180);
  if (bound >= 1) {
    return all;
  }
  const spanDeg = (2 * Math.asin(bound) * 180) / Math.PI;
  return Math.min(all, Math.ceil(spanDeg / cellDeg) + 1);
}

/**
 * Greedy clustering: pinned sites first, then by weight (then key, so the
 * result never depends on the input order). Each site joins the nearest
 * seed within `cellKm`, or becomes a seed. Seeds sit at a real site, never
 * at an average that could fall in the sea.
 */
export function clusterSites(points: readonly ClusterPoint[], cellKm: number): Cluster[] {
  const cellDeg = Math.max(cellKm / KM_PER_DEGREE, 1e-6);
  const columns = Math.max(1, Math.ceil(360 / cellDeg));
  const grid = new Map<string, Cluster[]>();
  const cellOf = (lat: number, lon: number) => ({
    row: Math.floor((lat + 90) / cellDeg),
    column: Math.min(columns - 1, Math.floor((lon + 180) / cellDeg))
  });
  const ordered = [...points].sort(
    (a, b) =>
      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
      b.weight - a.weight ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
  const clusters: Cluster[] = [];
  for (const point of ordered) {
    const { row, column } = cellOf(point.latitude, point.longitude);
    let nearest: Cluster | undefined;
    if (!point.pinned) {
      let best = cellKm;
      const reach = columnReach(point.latitude, cellKm, cellDeg, columns);
      for (let r = row - 1; r <= row + 1; r += 1) {
        for (let c = column - reach; c <= column + reach; c += 1) {
          const wrapped = ((c % columns) + columns) % columns;
          for (const seed of grid.get(`${r}:${wrapped}`) ?? []) {
            const distance = greatCircleKm(seed, point);
            if (distance <= best) {
              best = distance;
              nearest = seed;
            }
          }
        }
      }
    }
    if (nearest) {
      nearest.members.push(point.key);
      continue;
    }
    const seed: Cluster = {
      key: point.key,
      latitude: point.latitude,
      longitude: point.longitude,
      members: [point.key],
      pinned: Boolean(point.pinned)
    };
    clusters.push(seed);
    const cell = `${row}:${column}`;
    grid.set(cell, [...(grid.get(cell) ?? []), seed]);
  }
  return clusters;
}
