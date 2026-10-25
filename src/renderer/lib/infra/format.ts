import type { CloudProvider, CloudRegion } from "./sources";

/**
 * Text helpers that the hop details need at start-up; the rest of the
 * infrastructure code loads with the first layer data (lib/infra/code.ts).
 */

/** "12 km", "1,200 km"; a distance that rounds to 0 is "under 1 km". */
export const formatKm = (value: number) =>
  value < 0.5 ? "under 1 km" : `${Math.round(value).toLocaleString("en-US")} km`;

export const regionTitle = (provider: CloudProvider, region: CloudRegion) =>
  `${provider.shortName} ${region.code}${region.city !== region.name ? ` (${region.city})` : ""}`;
