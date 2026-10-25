import type { HopResolution } from "@common/ipc";
import { greatCircleKm, hopPosition } from "../globe";
import type { Exchange, Facility } from "./sources";

/**
 * Which exchanges and data centres the route passes. A hop whose address
 * is on an exchange's peering LAN (the phase 2 IX match) is "on" that
 * exchange. Every hop with a medium or high confidence location also links
 * to the nearest exchange and the nearest data centre within its radius
 * (25 to 100 km): those are where the router most likely is.
 */

export type SiteLinkKind = "on-lan" | "nearest";

export interface SiteLink {
  hopIndex: number;
  kind: SiteLinkKind;
  /** Null for an on-LAN link: the address itself places the hop. */
  distanceKm: number | null;
}

/** Site key → the hops linked to it, in hop order. */
export type SiteLinks = ReadonlyMap<string, readonly SiteLink[]>;

const MIN_NEAR_KM = 25;
const MAX_NEAR_KM = 100;

function nearestWithin<T extends { latitude: number; longitude: number; key: string }>(
  sites: readonly T[],
  point: { latitude: number; longitude: number },
  radiusKm: number
): { site: T; distanceKm: number } | null {
  // A cheap box first: a degree of latitude is about 111 km.
  const latSpan = radiusKm / 111;
  let best: { site: T; distanceKm: number } | null = null;
  for (const site of sites) {
    if (Math.abs(site.latitude - point.latitude) > latSpan) {
      continue;
    }
    const distanceKm = greatCircleKm(point, site);
    if (distanceKm <= radiusKm && (!best || distanceKm < best.distanceKm)) {
      best = { site, distanceKm };
    }
  }
  return best;
}

function add(links: Map<string, SiteLink[]>, key: string, link: SiteLink) {
  const list = links.get(key) ?? [];
  if (!list.some((existing) => existing.hopIndex === link.hopIndex)) {
    list.push(link);
    links.set(key, list);
  }
}

export function linkExchanges(hops: readonly HopResolution[], exchanges: readonly Exchange[]): SiteLinks {
  const links = new Map<string, SiteLink[]>();
  const known = new Set(exchanges.map((exchange) => exchange.key));
  for (const hop of hops) {
    const ixId = hop.location.ixp?.ixId;
    if (ixId != null && known.has(`ix:${ixId}`)) {
      add(links, `ix:${ixId}`, { hopIndex: hop.hopIndex, kind: "on-lan", distanceKm: null });
    }
  }
  for (const hop of hops) {
    const near = nearSite(hop, exchanges);
    if (near && !hop.location.ixp) {
      add(links, near.site.key, { hopIndex: hop.hopIndex, kind: "nearest", distanceKm: near.distanceKm });
    }
  }
  return links;
}

export function linkFacilities(hops: readonly HopResolution[], facilities: readonly Facility[]): SiteLinks {
  const links = new Map<string, SiteLink[]>();
  for (const hop of hops) {
    const near = nearSite(hop, facilities);
    if (near) {
      add(links, near.site.key, { hopIndex: hop.hopIndex, kind: "nearest", distanceKm: near.distanceKm });
    }
  }
  return links;
}

function nearSite<T extends { latitude: number; longitude: number; key: string }>(
  hop: HopResolution,
  sites: readonly T[]
): { site: T; distanceKm: number } | null {
  const position = hopPosition(hop);
  if (!position || position.confidence === "low" || position.rtt?.verdict === "conflict") {
    return null;
  }
  const radiusKm = Math.min(MAX_NEAR_KM, Math.max(MIN_NEAR_KM, position.radiusKm));
  return nearestWithin(sites, position, radiusKm);
}
