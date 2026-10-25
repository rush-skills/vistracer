import type { HopResolution } from "@common/ipc";
import { greatCircleKm, hopPosition, type GeoPoint } from "../globe";
import type { SubmarineCable } from "./sources";

/**
 * Cable geometry for the globe and the guess of which cables a route may
 * use. The guess only looks at landing points: TeleGeography's line ends.
 * It cannot see which cable carries the traffic, so the app labels it as a
 * guess.
 */

/** Long hops only: a shorter link is rarely a submarine cable. */
export const MIN_CROSSING_KM = 1500;
/** A cable end this close to a hop's estimate counts as landing near it. */
export const LANDING_NEAR_KM = 400;
const MAX_GUESSES_PER_CROSSING = 2;
/** Cables lie on the sea floor; drawn a little above it to stay visible. */
const CABLE_HEIGHT_M = 1500;
const CABLE_SEGMENT_KM = 100;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;

/**
 * Points along each great circle between the given points, at most
 * `CABLE_SEGMENT_KM` apart. A straight line between two far points would
 * run through the globe and be hidden.
 */
export function cablePositions(points: ReadonlyArray<readonly [number, number]>): GeoPoint[] {
  const out: GeoPoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const [lon, lat] = points[i];
    if (i > 0) {
      const [lon0, lat0] = points[i - 1];
      const from = { latitude: lat0, longitude: lon0 };
      const to = { latitude: lat, longitude: lon };
      const steps = Math.ceil(greatCircleKm(from, to) / CABLE_SEGMENT_KM);
      const a = unit(from);
      const b = unit(to);
      const angle = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
      for (let s = 1; s < steps && Math.sin(angle) > 1e-9; s += 1) {
        const t = s / steps;
        const wa = Math.sin((1 - t) * angle) / Math.sin(angle);
        const wb = Math.sin(t * angle) / Math.sin(angle);
        const [x, y, z] = [0, 1, 2].map((k) => wa * a[k] + wb * b[k]);
        out.push({
          latitude: toDegrees(Math.atan2(z, Math.hypot(x, y))),
          longitude: toDegrees(Math.atan2(y, x)),
          height: CABLE_HEIGHT_M
        });
      }
    }
    out.push({ latitude: lat, longitude: lon, height: CABLE_HEIGHT_M });
  }
  return out;
}

function unit(point: { latitude: number; longitude: number }): [number, number, number] {
  const lat = toRadians(point.latitude);
  const lon = toRadians(point.longitude);
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

export interface CableGuess {
  cableKey: string;
  name: string;
  fromHopIndex: number;
  toHopIndex: number;
  /** Distances from each hop's estimate to the nearest end of the cable. */
  fromKm: number;
  toKm: number;
}

function ends(cable: SubmarineCable): Array<{ latitude: number; longitude: number }> {
  return cable.segments.flatMap((segment) =>
    [segment[0], segment[segment.length - 1]].map(([longitude, latitude]) => ({ latitude, longitude }))
  );
}

function nearestEnd(
  points: ReadonlyArray<{ latitude: number; longitude: number }>,
  target: { latitude: number; longitude: number }
) {
  let best: { point: { latitude: number; longitude: number }; distanceKm: number } | null = null;
  for (const point of points) {
    const distanceKm = greatCircleKm(point, target);
    if (!best || distanceKm < best.distanceKm) {
      best = { point, distanceKm };
    }
  }
  return best;
}

/**
 * For each pair of consecutive located hops at least `MIN_CROSSING_KM`
 * apart, the cables (at most two) with one end near each hop, closest
 * first. Low-confidence estimates are left out: a wrong place would give a
 * wrong cable.
 */
export function guessCables(
  hops: readonly HopResolution[],
  cables: readonly SubmarineCable[]
): CableGuess[] {
  const located = hops.flatMap((hop) => {
    const position = hopPosition(hop);
    return position && position.confidence !== "low" ? [{ hop, position }] : [];
  });
  const cableEnds = cables.map((cable) => ({ cable, ends: ends(cable) }));
  const guesses: CableGuess[] = [];
  for (let i = 1; i < located.length; i += 1) {
    const from = located[i - 1];
    const to = located[i];
    if (greatCircleKm(from.position, to.position) < MIN_CROSSING_KM) {
      continue;
    }
    const candidates = cableEnds.flatMap(({ cable, ends: points }) => {
      const near = nearestEnd(points, from.position);
      const far = nearestEnd(points, to.position);
      if (!near || !far || near.distanceKm > LANDING_NEAR_KM || far.distanceKm > LANDING_NEAR_KM) {
        return [];
      }
      // Both hops near the same end is not a crossing on this cable.
      if (greatCircleKm(near.point, far.point) < MIN_CROSSING_KM / 2) {
        return [];
      }
      return [
        {
          cableKey: cable.key,
          name: cable.name,
          fromHopIndex: from.hop.hopIndex,
          toHopIndex: to.hop.hopIndex,
          fromKm: near.distanceKm,
          toKm: far.distanceKm
        }
      ];
    });
    candidates.sort((a, b) => a.fromKm + a.toKm - (b.fromKm + b.toKm) || a.name.localeCompare(b.name));
    guesses.push(...candidates.slice(0, MAX_GUESSES_PER_CROSSING));
  }
  return guesses;
}
