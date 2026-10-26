import type { HopResolution } from "@common/ipc";
import type { SatelliteGroupId } from "./groups";

/**
 * Does the route cross a satellite link? A hop in the network (ASN) of a
 * satellite internet provider says the route likely has one next to that
 * network. Traceroute cannot show which link is in space, so the match is a
 * guess with a confidence. It reads only the hop's ASN and RTT, which the
 * run already has, so it needs no layer and sends nothing.
 */

export interface SatelliteIsp {
  asn: number;
  name: string;
  /** Whose network the ASN is, for "AS14593 is …". */
  network: string;
  orbit: "low Earth orbit" | "geostationary";
  /** The group whose satellites the layer highlights for this provider. */
  group: SatelliteGroupId;
}

/** Network names checked in PeeringDB (www.peeringdb.com/api/net?asn=…), 2026-10-25. */
export const SATELLITE_ISPS: readonly SatelliteIsp[] = [
  {
    asn: 14593,
    name: "Starlink",
    network: "SpaceX's Starlink network",
    orbit: "low Earth orbit",
    group: "starlink"
  },
  {
    asn: 800,
    name: "OneWeb",
    network: "Eutelsat's OneWeb network",
    orbit: "low Earth orbit",
    group: "oneweb"
  },
  { asn: 7155, name: "Viasat", network: "Viasat's network", orbit: "geostationary", group: "geo" },
  {
    asn: 6621,
    name: "HughesNet",
    network: "the HughesNet network of Hughes Network Systems",
    orbit: "geostationary",
    group: "geo"
  },
  {
    asn: 29286,
    name: "Eutelsat Skylogic",
    network: "Eutelsat's Skylogic network",
    orbit: "geostationary",
    group: "geo"
  }
];

/**
 * A round trip through a geostationary satellite covers at least four times
 * 35,786 km (up and down, there and back): 477 ms at the speed of light.
 * Slightly lower, for rounding in the RTT.
 */
export const GEO_MIN_RTT_MS = 470;

interface SatelliteLinkBase {
  hopIndex: number;
  isp: SatelliteIsp;
  /** Says what the guess rests on, for the hop details. */
  reason: string;
}

/** A low confidence always says why, in a few words (the hover card). */
export type SatelliteLink = SatelliteLinkBase &
  ({ confidence: "low"; doubt: string } | { confidence: "medium" | "high"; doubt: null });

const ms = (value: number) => `${Math.round(value).toLocaleString("en-US")} ms`;

export function satelliteLink(hop: HopResolution): SatelliteLink | null {
  const asn = hop.asn?.asn;
  const isp = asn == null ? undefined : SATELLITE_ISPS.find((entry) => entry.asn === asn);
  if (!isp || hop.isPrivate) {
    return null;
  }
  const network = `AS${isp.asn} is ${isp.network}`;
  if (isp.orbit === "low Earth orbit") {
    return {
      hopIndex: hop.hopIndex,
      isp,
      confidence: "medium",
      reason: `${network}. ${isp.name} carries its users' traffic through satellites in low Earth orbit to ground stations, so the route likely has a satellite link next to this network. Traceroute does not show which link is in space, and the network also has routers on the ground.`,
      doubt: null
    };
  }
  const rtt = hop.latency.minRttMs ?? hop.latency.avgRttMs;
  if (rtt == null) {
    return {
      hopIndex: hop.hopIndex,
      isp,
      confidence: "medium",
      reason: `${network}, which carries traffic through geostationary satellites. This hop has no RTT, so the guess cannot be checked.`,
      doubt: null
    };
  }
  return rtt >= GEO_MIN_RTT_MS
    ? {
        hopIndex: hop.hopIndex,
        isp,
        confidence: "high",
        reason: `${network}, and the round trip to this hop takes ${ms(rtt)}. A geostationary satellite link adds at least 477 ms, so one is likely between you and this hop.`,
        doubt: null
      }
    : {
        hopIndex: hop.hopIndex,
        isp,
        confidence: "low",
        reason: `${network}, which carries traffic through geostationary satellites, but the round trip to this hop (${ms(rtt)}) is too short for one between you and this hop. A satellite link, if there is one, comes after it.`,
        doubt: `a ${ms(rtt)} round trip is too short for a geostationary link`
      };
}

/**
 * How the hop details name a link: "likely" only for medium and high
 * confidence; a low one is a possibility, not a likely link.
 */
export function satelliteLinkTitle(link: SatelliteLink): string {
  return link.confidence === "low"
    ? `Possible ${link.isp.name} satellite link`
    : `Likely ${link.isp.name} link`;
}

/** The hover card's line, with the confidence and, when it is low, why. */
export function satelliteLinkSummary(link: SatelliteLink): string {
  return link.confidence === "low"
    ? `Possible ${link.isp.name} satellite link (low confidence: ${link.doubt})`
    : `Likely satellite link: ${link.isp.name}, ${link.confidence} confidence`;
}

export function satelliteLinks(hops: readonly HopResolution[]): Map<number, SatelliteLink> {
  const links = new Map<number, SatelliteLink>();
  for (const hop of hops) {
    const link = satelliteLink(hop);
    if (link) {
      links.set(hop.hopIndex, link);
    }
  }
  return links;
}

/** The groups to highlight: those of providers with a likely link (medium or high). */
export function routeConstellations(
  links: ReadonlyMap<number, SatelliteLink>
): Set<SatelliteGroupId> {
  return new Set(
    [...links.values()].filter((link) => link.confidence !== "low").map((link) => link.isp.group)
  );
}
