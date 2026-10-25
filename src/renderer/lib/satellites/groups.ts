/**
 * The satellite groups of the opt-in satellites layer. Each is one CelesTrak
 * GP query (`GROUP` name) and one child switch in the layer registry. The
 * backend has the same table (`SATELLITE_GROUPS` in
 * src-tauri/src/commands/satellites.rs) and requests no other group.
 */

export type SatelliteGroupId = "starlink" | "oneweb" | "gps" | "stations" | "geo";

/** The data source of a group in the infra store (`LayerDefinition.data`). */
export type SatelliteSourceId = `celestrak-${SatelliteGroupId}`;

export interface SatelliteGroup {
  id: SatelliteGroupId;
  /** CelesTrak's GROUP name. */
  celestrak: string;
  label: string;
  /** Point colour (theme-independent, like the globe; 3:1 on the dark globe). */
  color: string;
  /** Pixels: small for the large constellations, so they do not hide the route. */
  pixelSize: number;
}

export const SATELLITE_GROUPS: Readonly<Record<SatelliteGroupId, SatelliteGroup>> = {
  starlink: {
    id: "starlink",
    celestrak: "starlink",
    label: "Starlink",
    color: "#DCE6F2",
    pixelSize: 2
  },
  oneweb: { id: "oneweb", celestrak: "oneweb", label: "OneWeb", color: "#4FD1C5", pixelSize: 3 },
  gps: { id: "gps", celestrak: "gps-ops", label: "GPS", color: "#FF9F43", pixelSize: 5 },
  stations: {
    id: "stations",
    celestrak: "stations",
    label: "Space stations",
    color: "#FF6F91",
    pixelSize: 6
  },
  geo: {
    id: "geo",
    celestrak: "geo",
    label: "Geostationary",
    color: "#A5B4FC",
    pixelSize: 3
  }
};

export const SATELLITE_GROUP_IDS = Object.keys(SATELLITE_GROUPS) as SatelliteGroupId[];

export const satelliteSourceId = (group: SatelliteGroupId): SatelliteSourceId =>
  `celestrak-${group}`;

/**
 * At most this many satellites of one group are drawn (Starlink had 11,113
 * on 2026-10-25). A larger group is thinned evenly, and the layer panel says so.
 */
export const MAX_SATELLITES_PER_GROUP = 12_000;

/**
 * The backend reuses a downloaded group for 12 hours
 * (`SATELLITE_TTL_MS`); after that, turning the group on again asks for it.
 */
export const SATELLITE_DATA_TTL_MS = 12 * 3_600_000;
