import type { SiteCardContent } from "../infra/siteCard";
import type { SatelliteGroupData } from "../infra/sources";
import { SATELLITE_GROUPS, type SatelliteGroupId } from "./groups";
import type { SatelliteLink } from "./isp";

/**
 * What the hover card says about a satellite: name, NORAD catalogue number,
 * height and the age of its elements. From the loaded data and the height
 * the globe measured when the pointer reached the point; nothing is sent.
 */

const HOUR_MS = 3_600_000;

/** "under an hour", "14 hours", "3 days". */
export function formatAge(ms: number): string {
  if (ms < HOUR_MS) {
    return "under an hour";
  }
  if (ms < 48 * HOUR_MS) {
    const hours = Math.round(ms / HOUR_MS);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${Math.round(ms / (24 * HOUR_MS))} days`;
}

/** The group and NORAD id of a satellite key, "sat|<group>|<NORAD id>". */
export function parseSatelliteKey(
  key: string
): { group: SatelliteGroupId; noradId: number } | null {
  const [kind, group, id] = key.split("|");
  const noradId = Number(id);
  return kind === "sat" && group in SATELLITE_GROUPS && Number.isInteger(noradId)
    ? { group: group as SatelliteGroupId, noradId }
    : null;
}

export function satelliteCardContent(
  hover: { keys: readonly string[]; heightKm?: number },
  groups: Partial<Record<SatelliteGroupId, SatelliteGroupData>>,
  links: ReadonlyMap<number, SatelliteLink>,
  nowMs: number
): SiteCardContent | null {
  const parsed = parseSatelliteKey(hover.keys[0] ?? "");
  const data = parsed ? groups[parsed.group] : undefined;
  const satellite = data?.satellites.find((entry) => entry.noradId === parsed?.noradId);
  if (!parsed || !satellite) {
    return null;
  }
  const group = SATELLITE_GROUPS[parsed.group];
  return {
    title: satellite.name,
    lines: [
      [group.label, `NORAD ${satellite.noradId}`, satellite.objectId].filter(Boolean).join(" · "),
      hover.heightKm != null && Number.isFinite(hover.heightKm)
        ? `Altitude ${Math.round(hover.heightKm).toLocaleString("en-US")} km`
        : null,
      `Orbital elements from ${formatAge(Math.max(0, nowMs - satellite.epochMs))} ago (CelesTrak); the position is an SGP4 estimate.`
    ].filter((line): line is string => line !== null),
    route: [...links.values()]
      .filter((link) => link.isp.group === parsed.group && link.confidence !== "low")
      .map(
        (link) =>
          `Hop ${link.hopIndex} (AS${link.isp.asn}) is likely a ${link.isp.name} link (${link.confidence} confidence).`
      ),
    more: null
  };
}
