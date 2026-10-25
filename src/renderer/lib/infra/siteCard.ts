import type { SiteLayer } from "../globe";
import { formatKm as km, regionTitle } from "./format";
import type { InfraInput, RouteInfra } from "./scene";
import type { SiteLink } from "./routeLinks";

/**
 * What the hover card says about a site marker or a cable. Only data the
 * app already has (the loaded layer data and the route): hovering sends
 * nothing anywhere.
 */
export interface SiteCardContent {
  title: string;
  lines: string[];
  /** What the route has to do with the site. */
  route: string[];
  /** Other sites in the cluster. */
  more: string | null;
}

const MORE_NAMES = 3;

const place = (city: string | null, country: string | null) =>
  [city, country].filter(Boolean).join(", ") || null;

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;


function linkText(link: SiteLink, what: string): string {
  return link.kind === "on-lan"
    ? `Hop ${link.hopIndex} is on its peering LAN.`
    : `Nearest ${what} to hop ${link.hopIndex} (${km(link.distanceKm ?? 0)}).`;
}

function more(names: Array<string | undefined>): string | null {
  const known = names.filter((name): name is string => Boolean(name));
  if (known.length === 0) {
    return null;
  }
  const shown = known.slice(0, MORE_NAMES).join(", ");
  const rest = known.length - MORE_NAMES;
  return `Also here: ${shown}${rest > 0 ? ` and ${rest} more` : ""}.`;
}

export function siteCardContent(
  hover: { layer: SiteLayer | "cables"; keys: readonly string[] },
  input: InfraInput,
  route: RouteInfra
): SiteCardContent | null {
  const [first, ...others] = hover.keys;
  if (hover.layer === "exchanges") {
    const byKey = new Map(input.peeringdb?.exchanges.map((site) => [site.key, site]));
    const site = byKey.get(first);
    if (!site) {
      return null;
    }
    return {
      title: site.name,
      lines: [
        "Internet exchange (PeeringDB)",
        place(site.city, site.country),
        `${plural(site.networkCount, "network", "networks")}, ${plural(site.facilityCount, "facility", "facilities")}`
      ].filter((line): line is string => Boolean(line)),
      route: (route.exchangeLinks.get(first) ?? []).map((link) => linkText(link, "exchange")),
      more: more(others.map((key) => byKey.get(key)?.name))
    };
  }
  if (hover.layer === "facilities") {
    const byKey = new Map(input.peeringdb?.facilities.map((site) => [site.key, site]));
    const site = byKey.get(first);
    if (!site) {
      return null;
    }
    return {
      title: site.name,
      lines: [
        "Data centre (PeeringDB)",
        site.org && !site.name.startsWith(site.org) ? site.org : null,
        place(site.city, site.country),
        `${plural(site.networkCount, "network", "networks")}, ${plural(site.exchangeCount, "exchange", "exchanges")}`
      ].filter((line): line is string => Boolean(line)),
      route: (route.facilityLinks.get(first) ?? []).map((link) => linkText(link, "data centre")),
      more: more(others.map((key) => byKey.get(key)?.name))
    };
  }
  if (hover.layer === "cloudRegions") {
    const regions = new Map(input.cloud?.regions.map((region) => [region.key, region]));
    const providers = new Map(input.cloud?.providers.map((provider) => [provider.id, provider]));
    const region = regions.get(first);
    const provider = region && providers.get(region.provider);
    if (!region || !provider) {
      return null;
    }
    const dataCentre = provider.sites === "data-centres";
    return {
      title: regionTitle(provider, region),
      lines: [
        region.name !== region.city ? region.name : null,
        `${region.city}, ${region.country}`,
        dataCentre
          ? `${provider.name} data centre; approximate location (its airport code).`
          : `${provider.name} region; approximate location (the city).`
      ].filter((line): line is string => Boolean(line)),
      route: [...route.cloudMatches.values()]
        .filter((match) => match.region?.key === region.key)
        .map((match) => `Hop ${match.hopIndex}, ${match.confidence} confidence: ${match.reason}`),
      more: more(
        others.map((key) => {
          const other = regions.get(key);
          const owner = other && providers.get(other.provider);
          return other && owner ? regionTitle(owner, other) : undefined;
        })
      )
    };
  }
  const cable = input.cables?.cables.find((candidate) => candidate.key === first);
  if (!cable) {
    return null;
  }
  return {
    title: cable.name,
    lines: ["Submarine cable. Data: TeleGeography Submarine Cable Map, CC BY-NC-SA 3.0."],
    route: route.cableGuesses
      .filter((guess) => guess.cableKey === cable.key)
      .map(
        (guess) =>
          `A guess: it lands near hop ${guess.fromHopIndex} (${km(guess.fromKm)}) and hop ${guess.toHopIndex} (${km(guess.toKm)}). The route may use another cable.`
      ),
    more: null
  };
}
