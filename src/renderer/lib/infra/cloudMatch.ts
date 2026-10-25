import type { HopResolution, LocationConfidence } from "@common/ipc";
import { greatCircleKm, hopPosition } from "../globe";
import type { CloudProvider, CloudRegion } from "./sources";

/**
 * Is a hop likely inside a cloud region? The network (ASN) says whose
 * router it is; the location estimate says which region it is near. Only
 * the two together give high confidence: every large city has a region,
 * and a provider's network also has edge sites far from any region.
 */

/** A region this close to the hop's estimate (or inside its radius) matches. */
export const REGION_MATCH_KM = 100;
/** Estimates less precise than this cannot place a hop in one region. */
const PRECISE_ESTIMATE_KM = 200;
/** Within this, the provider's region is a guess (medium). */
const NEAR_REGION_KM = 500;
/** Without an ASN, only a precise estimate this close counts (low). */
const PROXIMITY_ONLY_KM = 50;

export interface CloudMatch {
  hopIndex: number;
  provider: CloudProvider;
  /** Null when the hop has no location. */
  region: CloudRegion | null;
  distanceKm: number | null;
  confidence: LocationConfidence;
  /** Says what the match rests on, for the hop details and the card. */
  reason: string;
}

const km = (value: number) => `${Math.round(value).toLocaleString("en-US")} km`;

export const regionTitle = (provider: CloudProvider, region: CloudRegion) =>
  `${provider.shortName} ${region.code}${region.city !== region.name ? ` (${region.city})` : ""}`;

function nearest(
  regions: readonly CloudRegion[],
  point: { latitude: number; longitude: number }
): { region: CloudRegion; distanceKm: number } | null {
  let best: { region: CloudRegion; distanceKm: number } | null = null;
  for (const region of regions) {
    const distanceKm = greatCircleKm(point, region);
    if (!best || distanceKm < best.distanceKm) {
      best = { region, distanceKm };
    }
  }
  return best;
}

/**
 * The cloud match of one hop against the regions of the shown providers.
 *
 * - high: the hop's ASN is the provider's and one of its regions is within
 *   `REGION_MATCH_KM` (or the estimate's radius) of a precise estimate.
 * - medium: the provider's ASN, a region within `NEAR_REGION_KM`.
 * - low: the provider's ASN with no region near (an edge site, or no
 *   location); or no ASN at all and a precise estimate next to a region.
 * - none: the ASN belongs to another network, however close a region is.
 */
export function matchCloudRegion(
  hop: HopResolution,
  providers: readonly CloudProvider[],
  regions: readonly CloudRegion[]
): CloudMatch | null {
  if (hop.isPrivate || !hop.ipAddress) {
    return null;
  }
  const asn = hop.asn?.asn;
  const position = hopPosition(hop);
  const owner = asn != null ? providers.find((provider) => provider.asns.includes(asn)) : undefined;
  if (asn != null && !owner) {
    return null;
  }
  const kind = (provider: CloudProvider) =>
    provider.sites === "regions" ? "region" : "data centre";

  if (owner) {
    const network = `AS${asn} is ${owner.name}'s network`;
    const own = regions.filter((region) => region.provider === owner.id);
    if (!position) {
      const why = hop.location.anycast ? "it is anycast" : "it has no location";
      return {
        hopIndex: hop.hopIndex,
        provider: owner,
        region: null,
        distanceKm: null,
        confidence: "low",
        reason: `${network}, but ${why}, so the ${kind(owner)} is unknown.`
      };
    }
    const found = nearest(own, position);
    if (!found) {
      return null;
    }
    const { region, distanceKm } = found;
    const title = regionTitle(owner, region);
    const limit = Math.max(REGION_MATCH_KM, position.radiusKm);
    const confidence: LocationConfidence =
      distanceKm <= limit && position.radiusKm <= PRECISE_ESTIMATE_KM
        ? "high"
        : distanceKm <= NEAR_REGION_KM
          ? "medium"
          : "low";
    const reason =
      confidence === "high"
        ? `${network}, and ${title} is ${km(distanceKm)} from the hop's estimate.`
        : confidence === "medium"
          ? `${network}; ${title} is ${km(distanceKm)} from the hop's estimate (±${km(position.radiusKm)}), so the ${kind(owner)} is a guess.`
          : `${network}, but the nearest ${owner.shortName} ${kind(owner)}, ${title}, is ${km(distanceKm)} away: probably an edge site.`;
    return { hopIndex: hop.hopIndex, provider: owner, region, distanceKm, confidence, reason };
  }

  // No ASN for this hop: proximity alone, and only for a precise estimate.
  if (!position || position.radiusKm > REGION_MATCH_KM) {
    return null;
  }
  const found = nearest(regions, position);
  if (!found || found.distanceKm > PROXIMITY_ONLY_KM) {
    return null;
  }
  const regionOwner = providers.find((provider) => provider.id === found.region.provider);
  if (!regionOwner) {
    return null;
  }
  return {
    hopIndex: hop.hopIndex,
    provider: regionOwner,
    region: found.region,
    distanceKm: found.distanceKm,
    confidence: "low",
    reason: `No network (ASN) is known for this hop. It is ${km(found.distanceKm)} from ${regionTitle(regionOwner, found.region)}, which alone proves little.`
  };
}

export function matchCloudRegions(
  hops: readonly HopResolution[],
  providers: readonly CloudProvider[],
  regions: readonly CloudRegion[]
): Map<number, CloudMatch> {
  const matches = new Map<number, CloudMatch>();
  for (const hop of hops) {
    const match = matchCloudRegion(hop, providers, regions);
    if (match) {
      matches.set(hop.hopIndex, match);
    }
  }
  return matches;
}
