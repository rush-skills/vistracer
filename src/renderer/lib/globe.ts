import { Vector3 } from "three";
import type { HopResolution } from "@common/ipc";

export interface ArcDescriptor {
  id: string;
  from: HopResolution;
  to: HopResolution;
  points: Vector3[];
  color: string;
}

const EARTH_RADIUS = 5;

export function latLngToVector3(latitude: number, longitude: number, radius = EARTH_RADIUS): Vector3 {
  const phi = ((90 - latitude) * Math.PI) / 180;
  const theta = ((longitude + 180) * Math.PI) / 180;

  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);

  return new Vector3(x, y, z);
}

export function interpolateGreatCircle(
  start: Vector3,
  end: Vector3,
  steps = 32,
  radius = EARTH_RADIUS
): Vector3[] {
  const points: Vector3[] = [];
  const startNormalized = start.clone().normalize();
  const endNormalized = end.clone().normalize();

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const interpolated = startNormalized.clone().lerp(endNormalized, t).normalize().multiplyScalar(radius);
    points.push(interpolated);
  }

  return points;
}

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

// Generate a distinct color for each hop index
export function hopIndexToColor(hopIndex: number): string {
  const colors = [
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
    "#3498DB", // Blue
  ];

  return colors[hopIndex % colors.length];
}

export function buildArcDescriptors(hops: HopResolution[]): ArcDescriptor[] {
  const arcs: ArcDescriptor[] = [];

  // Filter hops to only those with valid geo data
  const hopsWithGeo = hops.filter(hop => {
    if (!hop.geo) return false;

    // Validate that coordinates are valid numbers
    if (
      !isFinite(hop.geo.latitude) ||
      !isFinite(hop.geo.longitude)
    ) {
      return false;
    }

    return true;
  });

  // Connect consecutive hops with geo data (skipping unknown hops)
  for (let i = 0; i < hopsWithGeo.length - 1; i += 1) {
    const current = hopsWithGeo[i];
    const next = hopsWithGeo[i + 1];

    const start = latLngToVector3(current.geo!.latitude, current.geo!.longitude);
    const end = latLngToVector3(next.geo!.latitude, next.geo!.longitude);

    // Validate that the resulting vectors are valid
    if (!isFinite(start.x) || !isFinite(start.y) || !isFinite(start.z) ||
        !isFinite(end.x) || !isFinite(end.y) || !isFinite(end.z)) {
      continue;
    }

    // Increase steps for smoother, more solid-looking lines
    const points = interpolateGreatCircle(start, end, 64);
    // Use latency-based color for the arc
    arcs.push({
      id: `${current.hopIndex}-${next.hopIndex}`,
      from: current,
      to: next,
      points,
      color: latencyToColor(current.latency.avgRttMs)
    });
  }

  return arcs;
}

export const EARTH_RADIUS_UNITS = EARTH_RADIUS;

/**
 * Calculate the sun's direction vector based on current date/time.
 * Uses a simplified solar position algorithm.
 *
 * @param date - The date/time to calculate for (defaults to now)
 * @returns Vector3 pointing from Earth center towards the sun
 */
export function calculateSunDirection(date: Date = new Date()): Vector3 {
  // Get Julian date (days since Jan 1, 2000, 12:00 UTC)
  const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0);
  const julianDate = (date.getTime() - J2000) / 86400000; // Convert ms to days

  // Calculate solar declination (angle of sun north/south of equator)
  // Varies from -23.5° to +23.5° throughout the year
  const n = julianDate + 1; // Day number
  const L = (280.460 + 0.9856474 * n) % 360; // Mean longitude of sun
  const g = (357.528 + 0.9856003 * n) % 360; // Mean anomaly
  const gRad = (g * Math.PI) / 180;

  // Ecliptic longitude
  const lambda = (L + 1.915 * Math.sin(gRad) + 0.020 * Math.sin(2 * gRad)) % 360;
  const lambdaRad = (lambda * Math.PI) / 180;

  // Solar declination
  const epsilon = 23.439 - 0.0000004 * n; // Obliquity of ecliptic
  const epsilonRad = (epsilon * Math.PI) / 180;
  const declination = Math.asin(Math.sin(epsilonRad) * Math.sin(lambdaRad));

  // Calculate hour angle (east-west position of sun)
  // Based on current UTC time
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  const utcHours = hours + minutes / 60 + seconds / 3600;

  // Hour angle: 0° at solar noon (12:00 UTC at 0° longitude)
  // 15° per hour (360° / 24 hours)
  // Sun moves westward as time increases
  const hourAngle = (utcHours - 12) * 15;
  const hourAngleRad = (hourAngle * Math.PI) / 180;

  // Convert to Cartesian coordinates matching Three.js coordinate system
  // At solar noon (12:00 UTC), sun should point toward +X (Greenwich meridian at 0°)
  // At 18:00 UTC (6 PM), sun should point toward +Z (90° West)
  // Y axis = north-south (declination)
  // X-Z plane = equatorial plane
  const x = Math.cos(declination) * Math.cos(hourAngleRad);
  const y = Math.sin(declination);
  const z = Math.cos(declination) * Math.sin(hourAngleRad);

  return new Vector3(x, y, z).normalize();
}
