import type { HopResolution, LocationConfidence, LocationEstimate } from "@common/ipc";
import { asnColor, assignAsnColors } from "./infra/asnColors";

/**
 * Pure mapping from hop data to what the globe draws. Positions are degrees
 * and metres above the ellipsoid; the Cesium adapter
 * (modules/app/components/globe/cesiumGlobe.ts) only converts and draws.
 */

const EARTH_RADIUS_KM = 6371;
/** A ring this large covers a continent and tells the user nothing. */
export const MAX_RING_RADIUS_KM = 5000;
/** Ring segments are at most this long, so the ring stays round. */
const RING_SEGMENT_KM = 50;
/** Arc peak height as a share of the hop distance, within the limits below. */
const ARC_HEIGHT_RATIO = 0.12;
const ARC_MIN_PEAK_M = 2_000;
const ARC_MAX_PEAK_M = 1_500_000;
/** Hops closer than this share one spot; an arc between them is invisible. */
const MIN_ARC_KM = 1;
const ARC_SEGMENT_KM = 100;

export interface GeoPoint {
  longitude: number;
  latitude: number;
  /** Metres above the ellipsoid. */
  height: number;
}

export type Emphasis = "normal" | "hovered" | "selected";

export interface MarkerSpec {
  hopIndex: number;
  position: GeoPoint;
  color: string;
  emphasis: Emphasis;
}

export interface ArcSpec {
  fromHopIndex: number;
  toHopIndex: number;
  positions: GeoPoint[];
  color: string;
}

export interface RingStyle {
  opacity: number;
  dashed: boolean;
  /** Pixels. */
  lineWidth: number;
}

/** Solid for high confidence, dashed and fainter as confidence drops. */
export const RING_STYLES: Record<LocationConfidence, RingStyle> = {
  high: { opacity: 0.9, dashed: false, lineWidth: 2 },
  medium: { opacity: 0.6, dashed: true, lineWidth: 1.75 },
  low: { opacity: 0.4, dashed: true, lineWidth: 1.5 }
};

export interface RingSpec extends RingStyle {
  hopIndex: number;
  radiusKm: number;
  confidence: LocationConfidence;
  color: string;
  positions: GeoPoint[];
}

/**
 * The area an anycast hop answered from: a circle around the reference hop
 * with the RTT bound as radius. Drawn dotted, with no point, because the
 * site that answered is somewhere inside it.
 */
export interface ReachSpec {
  hopIndex: number;
  referenceHopIndex: number;
  radiusKm: number;
  color: string;
  opacity: number;
  positions: GeoPoint[];
}

export interface LabelSpec {
  hopIndex: number;
  position: GeoPoint;
  text: string;
}

export interface RouteScene {
  markers: MarkerSpec[];
  arcs: ArcSpec[];
  rings: RingSpec[];
  reaches: ReachSpec[];
  labels: LabelSpec[];
}

export type SiteLayer = "exchanges" | "facilities" | "cloudRegions";

/**
 * A marker of an infrastructure layer: one site, or a cluster of sites
 * drawn at its most important one (lib/infra/scene.ts).
 */
export interface SiteSpec {
  /** Pick id: unique in the scene. */
  key: string;
  layer: SiteLayer;
  /** Site keys (lib/infra/sources.ts), the one drawn first. */
  members: string[];
  position: GeoPoint;
  color: string;
  outline: string;
  pixelSize: number;
  outlineWidth: number;
  /** The layer filter this site belongs to (a cloud provider). */
  filterKey?: string;
  /** Sites on the route are labelled. */
  label?: string;
}

export interface CableSpec {
  key: string;
  positions: GeoPoint[];
  color: string;
  width: number;
  /** Guessed cables are named on the globe. */
  label?: { position: GeoPoint; text: string };
}

export interface InfraScene {
  exchanges: SiteSpec[];
  facilities: SiteSpec[];
  cloudRegions: SiteSpec[];
  cables: CableSpec[];
}

export type GlobeScene = RouteScene & InfraScene;

export const EMPTY_INFRA_SCENE: InfraScene = {
  exchanges: [],
  facilities: [],
  cloudRegions: [],
  cables: []
};

export function latencyToColor(avgRttMs: number | null | undefined): string {
  if (avgRttMs == null) {
    return "#4F5D75";
  }

  if (avgRttMs < 50) {
    return "#4bd67f";
  }
  if (avgRttMs < 150) {
    return "#ffc773";
  }
  return "#ff5f5f";
}

const HOP_COLORS = [
  "#FF4444", // Bright Red
  "#00D9FF", // Bright Cyan
  "#9B59B6", // Purple
  "#FFA07A", // Light Salmon
  "#2ECC71", // Emerald Green
  "#F7DC6F", // Yellow
  "#E74C3C", // Red-Orange
  "#45B7D1", // Sky Blue
  "#F8B739", // Orange
  "#1ABC9C", // Turquoise
  "#E63946", // Dark Red
  "#457B9D", // Steel Blue
  "#FF9F1C", // Bright Orange
  "#2A9D8F", // Dark Teal
  "#E76F51", // Terra Cotta
  "#8338EC", // Violet
  "#FF006E", // Pink
  "#06FFA5", // Neon Green
  "#FFB703", // Gold
  "#3498DB" // Blue
];

/** A distinct colour per hop, shared by the globe and the hop table. */
export function hopIndexToColor(hopIndex: number): string {
  return HOP_COLORS[hopIndex % HOP_COLORS.length];
}

/**
 * The estimate to draw for a hop. Anycast hops and hops whose candidates
 * the RTT rules out have none, so they get no marker, ring or arc.
 */
export function hopPosition(hop: HopResolution): LocationEstimate | null {
  const best = hop.location.best;
  if (!best || !isFinite(best.latitude) || !isFinite(best.longitude)) {
    return null;
  }
  return best;
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
const toDegrees = (radians: number) => (radians * 180) / Math.PI;
const normaliseLongitude = (longitude: number) => ((((longitude + 180) % 360) + 360) % 360) - 180;

/** Great-circle distance on a sphere of radius `EARTH_RADIUS_KM`. */
export function greatCircleKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number }
): number {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The point `distanceKm` from `from` along the initial bearing `bearingRad`. */
function destination(
  from: { latitude: number; longitude: number },
  bearingRad: number,
  distanceKm: number
): { latitude: number; longitude: number } {
  const angle = distanceKm / EARTH_RADIUS_KM;
  const lat1 = toRadians(from.latitude);
  const lon1 = toRadians(from.longitude);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angle) + Math.cos(lat1) * Math.sin(angle) * Math.cos(bearingRad)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(angle) * Math.cos(lat1),
      Math.cos(angle) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { latitude: toDegrees(lat2), longitude: normaliseLongitude(toDegrees(lon2)) };
}

/**
 * All points `radiusKm` along the surface from the centre, closed (the last
 * point repeats the first). Segments are at most `RING_SEGMENT_KM` long.
 */
export function circlePositions(latitude: number, longitude: number, radiusKm: number): GeoPoint[] {
  const circumference = 2 * Math.PI * EARTH_RADIUS_KM * Math.sin(radiusKm / EARTH_RADIUS_KM);
  const segments = Math.min(720, Math.max(48, Math.ceil(circumference / RING_SEGMENT_KM)));
  const points: GeoPoint[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const bearing = ((i % segments) / segments) * 2 * Math.PI;
    points.push({ ...destination({ latitude, longitude }, bearing, radiusKm), height: 0 });
  }
  return points;
}

/**
 * Points along the great circle from `from` to `to`, raised in the middle
 * (a sine profile) so the route stands out from the surface.
 */
export function arcPositions(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number }
): GeoPoint[] {
  const distanceKm = greatCircleKm(from, to);
  const peak = Math.min(
    ARC_MAX_PEAK_M,
    Math.max(ARC_MIN_PEAK_M, distanceKm * 1000 * ARC_HEIGHT_RATIO)
  );
  const segments = Math.min(128, Math.max(16, Math.ceil(distanceKm / ARC_SEGMENT_KM)));
  const angle = distanceKm / EARTH_RADIUS_KM;
  const toUnit = (point: { latitude: number; longitude: number }) => {
    const lat = toRadians(point.latitude);
    const lon = toRadians(point.longitude);
    return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  };
  const a = toUnit(from);
  const b = toUnit(to);
  // Same or antipodal points have no unique great circle: interpolate the
  // vectors linearly instead of dividing by sin(angle) ≈ 0.
  const degenerate = Math.abs(Math.sin(angle)) < 1e-9;
  const points: GeoPoint[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const wa = degenerate ? 1 - t : Math.sin((1 - t) * angle) / Math.sin(angle);
    const wb = degenerate ? t : Math.sin(t * angle) / Math.sin(angle);
    const [x, y, z] = [0, 1, 2].map((k) => wa * a[k] + wb * b[k]);
    points.push({
      latitude: toDegrees(Math.atan2(z, Math.hypot(x, y))),
      longitude: toDegrees(Math.atan2(y, x)),
      height: peak * Math.sin(Math.PI * t)
    });
  }
  return points;
}

interface LocatedHop {
  hop: HopResolution;
  position: LocationEstimate;
}

function locatedHops(hops: HopResolution[]): LocatedHop[] {
  return hops.flatMap((hop) => {
    const position = hopPosition(hop);
    return position ? [{ hop, position }] : [];
  });
}

function emphasisOf(hopIndex: number, selected?: number, hovered?: number): Emphasis {
  if (hopIndex === selected) {
    return "selected";
  }
  return hopIndex === hovered ? "hovered" : "normal";
}

/** The colour of a hop's marker and ring. */
type HopColor = (hop: HopResolution) => string;

const byHopIndex: HopColor = (hop) => hopIndexToColor(hop.hopIndex);

/**
 * Arcs between consecutive located hops. By default coloured by the first
 * hop's latency. With `asnColor`, an arc between two networks is split in
 * the middle: the first half in the colour of the network it leaves, the
 * second in the one it enters, so the colour changes where the route hands
 * over to the next network.
 */
export function buildArcs(hops: HopResolution[], asnColorOf?: HopColor): ArcSpec[] {
  const located = locatedHops(hops);
  const arcs: ArcSpec[] = [];
  for (let i = 0; i < located.length - 1; i += 1) {
    const from = located[i];
    const to = located[i + 1];
    if (greatCircleKm(from.position, to.position) < MIN_ARC_KM) {
      continue;
    }
    const positions = arcPositions(from.position, to.position);
    const base = { fromHopIndex: from.hop.hopIndex, toHopIndex: to.hop.hopIndex };
    if (!asnColorOf) {
      arcs.push({ ...base, positions, color: latencyToColor(from.hop.latency.avgRttMs) });
      continue;
    }
    const [leaving, entering] = [asnColorOf(from.hop), asnColorOf(to.hop)];
    if (leaving === entering) {
      arcs.push({ ...base, positions, color: leaving });
      continue;
    }
    const middle = Math.floor(positions.length / 2);
    arcs.push({ ...base, positions: positions.slice(0, middle + 1), color: leaving });
    arcs.push({ ...base, positions: positions.slice(middle), color: entering });
  }
  return arcs;
}

/** One uncertainty ring per drawn hop, true to its radius in km. */
export function buildRings(
  hops: HopResolution[],
  selectedHopIndex?: number,
  hoveredHopIndex?: number,
  colorOf: HopColor = byHopIndex
): RingSpec[] {
  return locatedHops(hops).flatMap(({ hop, position }) => {
    if (position.radiusKm <= 0 || position.radiusKm > MAX_RING_RADIUS_KM) {
      return [];
    }
    // A conflict keeps its confidence for ranking, but the RTT check
    // disagrees with it, so its ring looks as uncertain as a low estimate.
    const style =
      position.rtt?.verdict === "conflict" ? RING_STYLES.low : RING_STYLES[position.confidence];
    const emphasised = emphasisOf(hop.hopIndex, selectedHopIndex, hoveredHopIndex) !== "normal";
    return [
      {
        hopIndex: hop.hopIndex,
        radiusKm: position.radiusKm,
        confidence: position.confidence,
        color: colorOf(hop),
        positions: circlePositions(position.latitude, position.longitude, position.radiusKm),
        opacity: emphasised ? 1 : style.opacity,
        dashed: style.dashed,
        lineWidth: emphasised ? style.lineWidth + 1 : style.lineWidth
      }
    ];
  });
}

/** Reach circles of anycast hops whose RTT bound is known. */
function buildReaches(
  hops: HopResolution[],
  selectedHopIndex?: number,
  hoveredHopIndex?: number
): ReachSpec[] {
  return hops.flatMap((hop) => {
    const anycast = hop.location.anycast;
    if (!anycast || anycast.maxDistanceKm == null || anycast.referenceHopIndex == null) {
      return [];
    }
    const radiusKm = anycast.maxDistanceKm;
    const reference = hops.find((candidate) => candidate.hopIndex === anycast.referenceHopIndex);
    const centre = reference ? hopPosition(reference) : null;
    if (!centre || radiusKm <= 0 || radiusKm > MAX_RING_RADIUS_KM) {
      return [];
    }
    const emphasised = emphasisOf(hop.hopIndex, selectedHopIndex, hoveredHopIndex) !== "normal";
    return [
      {
        hopIndex: hop.hopIndex,
        referenceHopIndex: anycast.referenceHopIndex,
        radiusKm,
        color: hopIndexToColor(hop.hopIndex),
        opacity: emphasised ? 0.95 : 0.5,
        positions: circlePositions(centre.latitude, centre.longitude, radiusKm)
      }
    ];
  });
}

export function buildMarkers(
  hops: HopResolution[],
  selectedHopIndex?: number,
  hoveredHopIndex?: number,
  colorOf: HopColor = byHopIndex
): MarkerSpec[] {
  const markers = locatedHops(hops).map(({ hop, position }) => ({
    hopIndex: hop.hopIndex,
    position: { latitude: position.latitude, longitude: position.longitude, height: 0 },
    color: colorOf(hop),
    emphasis: emphasisOf(hop.hopIndex, selectedHopIndex, hoveredHopIndex)
  }));
  // Emphasised markers last, so they draw on top of hops at the same place.
  const rank: Record<Emphasis, number> = { normal: 0, hovered: 1, selected: 2 };
  return markers.sort((a, b) => rank[a.emphasis] - rank[b.emphasis]);
}

/** Labels for the selected and the hovered hop. */
function buildLabels(
  hops: HopResolution[],
  reaches: ReachSpec[],
  selectedHopIndex?: number,
  hoveredHopIndex?: number
): LabelSpec[] {
  const wanted = [...new Set([selectedHopIndex, hoveredHopIndex])].filter(
    (index): index is number => index != null
  );
  return wanted.flatMap((hopIndex) => {
    const hop = hops.find((candidate) => candidate.hopIndex === hopIndex);
    if (!hop) {
      return [];
    }
    const position = hopPosition(hop);
    if (position) {
      return [
        {
          hopIndex,
          position: { latitude: position.latitude, longitude: position.longitude, height: 0 },
          text: `${hopIndex} · ${position.label}`
        }
      ];
    }
    const reach = reaches.find((candidate) => candidate.hopIndex === hopIndex);
    if (reach && hop.location.anycast) {
      // The northernmost point of the circle: on the area, not at a site.
      return [
        {
          hopIndex,
          position: reach.positions[0],
          text: `${hopIndex} · anycast (${hop.location.anycast.service}), within ${Math.round(
            reach.radiusKm
          ).toLocaleString("en-US")} km of hop ${reach.referenceHopIndex}`
        }
      ];
    }
    return [];
  });
}

/** The route items of the scene; `style.asnColors` colours them by network. */
export function buildGlobeScene(
  hops: HopResolution[],
  selectedHopIndex?: number,
  hoveredHopIndex?: number,
  style: { asnColors: boolean } = { asnColors: false }
): RouteScene {
  const reaches = buildReaches(hops, selectedHopIndex, hoveredHopIndex);
  const colors = style.asnColors ? assignAsnColors(hops) : undefined;
  const colorOf: HopColor = colors ? (hop) => asnColor(colors, hop) : byHopIndex;
  return {
    markers: buildMarkers(hops, selectedHopIndex, hoveredHopIndex, colorOf),
    arcs: buildArcs(hops, colors ? colorOf : undefined),
    rings: buildRings(hops, selectedHopIndex, hoveredHopIndex, colorOf),
    reaches,
    labels: buildLabels(hops, reaches, selectedHopIndex, hoveredHopIndex)
  };
}

/** Where the camera looks for a hop: its estimate, or an anycast hop's reach. */
function hopFocus(
  hops: HopResolution[],
  hopIndex: number
): { latitude: number; longitude: number; radiusKm: number } | null {
  const hop = hops.find((candidate) => candidate.hopIndex === hopIndex);
  if (!hop) {
    return null;
  }
  const position = hopPosition(hop);
  if (position) {
    return {
      latitude: position.latitude,
      longitude: position.longitude,
      radiusKm: position.radiusKm
    };
  }
  const reach = buildReaches(hops).find((candidate) => candidate.hopIndex === hopIndex);
  if (!reach) {
    return null;
  }
  const reference = hops.find((candidate) => candidate.hopIndex === reach.referenceHopIndex);
  const centre = reference ? hopPosition(reference) : null;
  return centre
    ? { latitude: centre.latitude, longitude: centre.longitude, radiusKm: reach.radiusKm }
    : null;
}

export interface CameraFocus {
  latitude: number;
  longitude: number;
  radiusKm: number;
}

/** What the camera last reacted to. */
export interface CameraTracker {
  runKey?: string;
  locatedCount: number;
  selectedHopIndex?: number;
}

export const INITIAL_CAMERA_TRACKER: CameraTracker = { locatedCount: 0 };

/**
 * Decides where to fly: to a newly selected hop, else to the newest hop
 * that got a location during the run. Returns no target when nothing the
 * user cares about changed (enrichment updates of the same hops).
 */
export function nextCameraFocus(
  previous: CameraTracker,
  runKey: string | undefined,
  hops: HopResolution[],
  selectedHopIndex: number | undefined
): { tracker: CameraTracker; focus: CameraFocus | null } {
  const sameRun = previous.runKey === runKey;
  const located = locatedHops(hops);
  const tracker: CameraTracker = { runKey, locatedCount: located.length, selectedHopIndex };
  const lastSelected = sameRun ? previous.selectedHopIndex : undefined;
  if (selectedHopIndex != null && selectedHopIndex !== lastSelected) {
    const focus = hopFocus(hops, selectedHopIndex);
    if (focus) {
      return { tracker, focus };
    }
  }
  const lastCount = sameRun ? previous.locatedCount : 0;
  if (located.length > lastCount) {
    const newest = located[located.length - 1].position;
    return {
      tracker,
      focus: { latitude: newest.latitude, longitude: newest.longitude, radiusKm: newest.radiusKm }
    };
  }
  return { tracker, focus: null };
}

/** Camera heights in metres above the ellipsoid. */
export const CAMERA_LIMITS = {
  minHeight: 20_000,
  maxHeight: 40_000_000,
  initialHeight: 14_000_000
};

/**
 * Keeps the user's zoom when flying to a hop, but high enough to show the
 * hop's whole ring and never below `floorM`.
 */
export function flyHeight(currentHeightM: number, radiusKm: number, floorM: number): number {
  const fitRing = radiusKm * 1000 * 4;
  return Math.min(
    CAMERA_LIMITS.maxHeight,
    Math.max(CAMERA_LIMITS.minHeight, currentHeightM, fitRing, floorM)
  );
}

export interface CameraPosition {
  latitude: number;
  longitude: number;
  /** Metres above the ellipsoid. */
  height: number;
}

export interface FlightStep extends CameraPosition {
  /** `rise` goes straight up; `move` goes to the hop at a constant height. */
  kind: "rise" | "move";
}

/** Pixels of each canvas edge that panels cover. */
export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The canvas and its camera, to frame a hop in the area the panels leave free. */
export interface ViewFrame {
  insets: ViewInsets;
  widthPx: number;
  heightPx: number;
  /** Horizontal field of view of the camera. */
  fovRad: number;
}

/** A free area smaller than this share of the canvas is not worth framing in. */
const MIN_FREE_SHARE = 0.3;

function freeArea(frame: ViewFrame): { width: number; height: number } | null {
  const width = frame.widthPx - frame.insets.left - frame.insets.right;
  const height = frame.heightPx - frame.insets.top - frame.insets.bottom;
  return width >= frame.widthPx * MIN_FREE_SHARE && height >= frame.heightPx * MIN_FREE_SHARE
    ? { width, height }
    : null;
}

/**
 * Where a top-down camera at `heightM` must look so that `focus` appears at
 * the centre of the free area instead of the centre of the canvas. The
 * offset is the pixel offset times the ground distance of a pixel at the
 * centre, so it is exact near the ground and an estimate far out, where
 * the Earth curves away.
 */
export function framedTarget(
  focus: { latitude: number; longitude: number },
  heightM: number,
  frame: ViewFrame
): { latitude: number; longitude: number } {
  if (!freeArea(frame)) {
    return { latitude: focus.latitude, longitude: focus.longitude };
  }
  // Panels on the right push the free centre left: the camera looks right
  // (east) of the hop so the hop shows left of the canvas centre.
  const dxPx = (frame.insets.right - frame.insets.left) / 2;
  const dyPx = (frame.insets.bottom - frame.insets.top) / 2;
  if (dxPx === 0 && dyPx === 0) {
    return { latitude: focus.latitude, longitude: focus.longitude };
  }
  const kmPerPx = (2 * heightM * Math.tan(frame.fovRad / 2)) / frame.widthPx / 1000;
  // North is up in a top-down view: panels at the bottom move the camera south.
  const bearing = Math.atan2(dxPx, -dyPx);
  const target = destination(focus, bearing, Math.hypot(dxPx, dyPx) * kmPerPx);
  return {
    latitude: Math.max(-89, Math.min(89, target.latitude)),
    longitude: target.longitude
  };
}

/**
 * Camera moves the app makes itself (following a trace, selecting a hop,
 * exports) stay at or above `floorM`, the height where the globe uses only
 * bundled imagery (`bundledOnlyHeight`). Online tiles show NASA the areas
 * they cover, so only zooms the user makes may fetch them. From below the
 * floor, the camera first rises over the place the user zoomed into, then
 * moves to the hop; it never crosses new ground below the floor.
 *
 * With `frame`, the hop is framed in the area the panels leave free: the
 * ring must fit that area, and the camera looks past the hop so the hop
 * sits at the free area's centre.
 */
export function planFlight(
  current: CameraPosition,
  focus: CameraFocus,
  floorM: number,
  frame?: ViewFrame
): FlightStep[] {
  const free = frame ? freeArea(frame) : null;
  const shrink =
    frame && free ? Math.max(frame.widthPx / free.width, frame.heightPx / free.height) : 1;
  const height = flyHeight(current.height, focus.radiusKm * shrink, floorM);
  const target = frame ? framedTarget(focus, height, frame) : focus;
  const move: FlightStep = {
    kind: "move",
    latitude: target.latitude,
    longitude: target.longitude,
    height
  };
  if (current.height >= floorM) {
    return [move];
  }
  return [{ ...current, kind: "rise", height: Math.min(floorM, CAMERA_LIMITS.maxHeight) }, move];
}

/** Country outlines from a GeoJSON FeatureCollection, as [lon, lat] rings. */
export function borderRings(geojson: unknown): Array<Array<[number, number]>> {
  const isPosition = (value: unknown): value is [number, number] =>
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    isFinite(value[0]) &&
    isFinite(value[1]);
  const toRing = (ring: unknown): Array<[number, number]> | null =>
    Array.isArray(ring) && ring.length > 1 && ring.every(isPosition)
      ? ring.map(([lon, lat]) => [lon, lat])
      : null;
  if (typeof geojson !== "object" || geojson === null || !("features" in geojson)) {
    return [];
  }
  const features = (geojson as { features: unknown }).features;
  if (!Array.isArray(features)) {
    return [];
  }
  const rings: Array<Array<[number, number]>> = [];
  for (const feature of features) {
    const geometry = (feature as { geometry?: { type?: unknown; coordinates?: unknown } } | null)
      ?.geometry;
    if (!geometry || !Array.isArray(geometry.coordinates)) {
      continue;
    }
    const polygons =
      geometry.type === "Polygon"
        ? [geometry.coordinates]
        : geometry.type === "MultiPolygon"
          ? geometry.coordinates
          : [];
    for (const polygon of polygons) {
      if (!Array.isArray(polygon)) {
        continue;
      }
      for (const ring of polygon) {
        const parsed = toRing(ring);
        if (parsed) {
          rings.push(parsed);
        }
      }
    }
  }
  return rings;
}
