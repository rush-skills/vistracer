import type { HopResolution } from "@common/ipc";
import type { CableSpec, GeoPoint, InfraScene, SiteLayer, SiteSpec } from "../globe";
import {
  SITE_COLORS,
  hiddenFilterKeys,
  layerActive,
  type LayerVisibility
} from "../layers";
import { cablePositions, guessCables, type CableGuess } from "./cableGuess";
import { matchCloudRegions, regionTitle, type CloudMatch } from "./cloudMatch";
import { cellKmForLevel, clusterSites, type Cluster } from "./cluster";
import { linkExchanges, linkFacilities, type SiteLinks } from "./routeLinks";
import type {
  CableData,
  CloudProvider,
  CloudRegion,
  CloudRegionData,
  Exchange,
  Facility,
  PeeringDbSiteData,
  SubmarineCable
} from "./sources";

/**
 * Pure mapping from the infrastructure data and the route to what the
 * globe draws for the infrastructure layers, and to what the hop details
 * and hover cards say about them.
 */

export interface InfraInput {
  peeringdb?: PeeringDbSiteData;
  cloud?: CloudRegionData;
  cables?: CableData;
}

/** What the route has to do with the shown sites; empty for hidden layers. */
export interface RouteInfra {
  exchangeLinks: SiteLinks;
  facilityLinks: SiteLinks;
  cloudMatches: ReadonlyMap<number, CloudMatch>;
  cableGuesses: CableGuess[];
  /** The providers whose switch is on. */
  shownProviders: CloudProvider[];
}

const NO_LINKS: SiteLinks = new Map();

export function shownCloud(
  cloud: CloudRegionData | undefined,
  visibility: LayerVisibility
): { providers: CloudProvider[]; regions: CloudRegion[] } {
  if (!cloud || !layerActive(visibility, "cloud-regions")) {
    return { providers: [], regions: [] };
  }
  const hidden = hiddenFilterKeys(visibility, "cloudRegions");
  return {
    providers: cloud.providers.filter((provider) => !hidden.has(provider.id)),
    regions: cloud.regions.filter((region) => !hidden.has(region.provider))
  };
}

export function routeInfra(
  hops: readonly HopResolution[],
  visibility: LayerVisibility,
  input: InfraInput
): RouteInfra {
  const { providers, regions } = shownCloud(input.cloud, visibility);
  return {
    exchangeLinks:
      input.peeringdb && visibility.exchanges
        ? linkExchanges(hops, input.peeringdb.exchanges)
        : NO_LINKS,
    facilityLinks:
      input.peeringdb && visibility["data-centres"]
        ? linkFacilities(hops, input.peeringdb.facilities)
        : NO_LINKS,
    cloudMatches: providers.length > 0 ? matchCloudRegions(hops, providers, regions) : new Map(),
    cableGuesses:
      input.cables && visibility["submarine-cables"] ? guessCables(hops, input.cables.cables) : [],
    shownProviders: providers
  };
}

/** A cluster with what its marker needs; built once per data, zoom and route. */
export interface SiteCluster {
  layer: SiteLayer;
  cluster: Cluster;
  /** The drawn site's provider (cloud regions only). */
  provider?: string;
  /** On the route: a phase 2 exchange match or a high/medium cloud match. */
  onRoute: boolean;
  /** Near a hop, or on the route. */
  linked: boolean;
  label?: string;
}

export interface SiteClusters {
  exchanges: SiteCluster[];
  facilities: SiteCluster[];
  cloudRegions: SiteCluster[];
}

const hopList = (hopIndexes: number[]) =>
  hopIndexes.length === 1 ? `hop ${hopIndexes[0]}` : `hops ${hopIndexes.join(", ")}`;

function exchangeClusters(
  exchanges: readonly Exchange[],
  links: SiteLinks,
  cellKm: number
): SiteCluster[] {
  const byKey = new Map(exchanges.map((exchange) => [exchange.key, exchange]));
  const clusters = clusterSites(
    exchanges.map((exchange) => ({
      key: exchange.key,
      latitude: exchange.latitude,
      longitude: exchange.longitude,
      weight: exchange.networkCount,
      pinned: links.has(exchange.key)
    })),
    cellKm
  );
  return clusters.map((cluster) => {
    const hopsOnLan = (links.get(cluster.key) ?? [])
      .filter((link) => link.kind === "on-lan")
      .map((link) => link.hopIndex);
    const onRoute = hopsOnLan.length > 0;
    return {
      layer: "exchanges",
      cluster,
      onRoute,
      linked: links.has(cluster.key),
      label: onRoute ? `${byKey.get(cluster.key)?.name} · ${hopList(hopsOnLan)}` : undefined
    };
  });
}

function facilityClusters(
  facilities: readonly Facility[],
  links: SiteLinks,
  cellKm: number
): SiteCluster[] {
  return clusterSites(
    facilities.map((facility) => ({
      key: facility.key,
      latitude: facility.latitude,
      longitude: facility.longitude,
      weight: facility.networkCount,
      pinned: links.has(facility.key)
    })),
    cellKm
  ).map((cluster) => ({
    layer: "facilities",
    cluster,
    onRoute: false,
    linked: links.has(cluster.key)
  }));
}

function cloudClusters(
  providers: readonly CloudProvider[],
  regions: readonly CloudRegion[],
  matches: ReadonlyMap<number, CloudMatch>,
  cellKm: number
): SiteCluster[] {
  const byKey = new Map(regions.map((region) => [region.key, region]));
  const matched = new Map<string, CloudMatch[]>();
  for (const match of matches.values()) {
    if (match.region && match.confidence !== "low") {
      matched.set(match.region.key, [...(matched.get(match.region.key) ?? []), match]);
    }
  }
  const regionSites = new Set(
    providers.filter((provider) => provider.sites === "regions").map((p) => p.id)
  );
  return clusterSites(
    regions.map((region) => ({
      key: region.key,
      latitude: region.latitude,
      longitude: region.longitude,
      // A region outranks a CDN data centre in the same city.
      weight: regionSites.has(region.provider) ? 2 : 1,
      pinned: matched.has(region.key)
    })),
    cellKm
  ).map((cluster) => {
    const region = byKey.get(cluster.key);
    const provider = providers.find((candidate) => candidate.id === region?.provider);
    const hopMatches = matched.get(cluster.key) ?? [];
    const label =
      region && provider && hopMatches.length > 0
        ? `${regionTitle(provider, region)} · ${hopMatches
            .map((match) => `hop ${match.hopIndex} (${match.confidence})`)
            .join(", ")}`
        : undefined;
    return {
      layer: "cloudRegions",
      cluster,
      provider: region?.provider,
      onRoute: hopMatches.length > 0,
      linked: hopMatches.length > 0,
      label
    };
  });
}

export function buildSiteClusters(
  visibility: LayerVisibility,
  level: number,
  input: InfraInput,
  route: RouteInfra
): SiteClusters {
  const cellKm = cellKmForLevel(level);
  const { regions } = shownCloud(input.cloud, visibility);
  return {
    exchanges:
      input.peeringdb && visibility.exchanges
        ? exchangeClusters(input.peeringdb.exchanges, route.exchangeLinks, cellKm)
        : [],
    facilities:
      input.peeringdb && visibility["data-centres"]
        ? facilityClusters(input.peeringdb.facilities, route.facilityLinks, cellKm)
        : [],
    cloudRegions:
      route.shownProviders.length > 0
        ? cloudClusters(route.shownProviders, regions, route.cloudMatches, cellKm)
        : []
  };
}

/** Pick ids of site markers: "<layer>|<site key>". */
export const siteSpecKey = (layer: SiteLayer, key: string) => `${layer}|${key}`;

const OUTLINE_ON_ROUTE = "#FFFFFF";

function siteColors(site: SiteCluster): { fill: string; outline: string } {
  if (site.layer === "exchanges") {
    return SITE_COLORS.exchange;
  }
  if (site.layer === "facilities") {
    return SITE_COLORS.facility;
  }
  return SITE_COLORS[site.provider as keyof typeof SITE_COLORS] ?? SITE_COLORS.exchange;
}

/** Marker specs; cheap, so hover emphasis does not cluster again. */
export function siteSpecs(sites: readonly SiteCluster[], hoveredKey: string | undefined): SiteSpec[] {
  const specs = sites.map((site) => {
    const key = siteSpecKey(site.layer, site.cluster.key);
    const { fill, outline } = siteColors(site);
    const extra = Math.min(8, 2 * Math.log2(site.cluster.members.length));
    const hovered = key === hoveredKey;
    const base = site.layer === "facilities" ? 7 : 6;
    const { latitude, longitude } = site.cluster;
    return {
      key,
      layer: site.layer,
      members: site.cluster.members,
      position: { latitude, longitude, height: 0 },
      color: fill,
      outline: site.linked || hovered ? OUTLINE_ON_ROUTE : outline,
      // A ring (facility) needs a wider outline to read as a ring.
      outlineWidth: (site.layer === "facilities" ? 2 : 1) + (site.linked ? 1 : 0),
      pixelSize: base + extra + (site.linked ? 4 : 0) + (hovered ? 2 : 0),
      filterKey: site.provider,
      label: site.label
    };
  });
  // Sites on the route draw last, on top of the others.
  return specs.sort((a, b) => Number(Boolean(a.label)) - Number(Boolean(b.label)));
}

export const CABLE_COLOR = "rgba(120, 196, 232, 0.5)";
export const GUESSED_CABLE_COLOR = "#FFD166";
const CABLE_WIDTH = 1.25;
const GUESSED_CABLE_WIDTH = 3;

/** Positions of every cable line; computed once per cable map. */
export function cableLines(
  cables: readonly SubmarineCable[]
): Array<{ cableKey: string; name: string; positions: GeoPoint[] }> {
  return cables.flatMap((cable) =>
    cable.segments.map((segment) => ({
      cableKey: cable.key,
      name: cable.name,
      positions: cablePositions(segment)
    }))
  );
}

export function cableSpecs(
  lines: ReturnType<typeof cableLines>,
  guesses: readonly CableGuess[]
): CableSpec[] {
  const guessed = new Set(guesses.map((guess) => guess.cableKey));
  const labelled = new Set<string>();
  const specs = lines.map((line, index): CableSpec => {
    const isGuess = guessed.has(line.cableKey);
    let label: CableSpec["label"];
    if (isGuess && !labelled.has(line.cableKey) && line.positions.length > 0) {
      labelled.add(line.cableKey);
      label = {
        position: line.positions[Math.floor(line.positions.length / 2)],
        text: `${line.name}? (a guess)`
      };
    }
    return {
      key: `${line.cableKey}#${index}`,
      positions: line.positions,
      color: isGuess ? GUESSED_CABLE_COLOR : CABLE_COLOR,
      width: isGuess ? GUESSED_CABLE_WIDTH : CABLE_WIDTH,
      label
    };
  });
  // Guessed cables last, on top.
  const guess = (spec: CableSpec) => Number(spec.width === GUESSED_CABLE_WIDTH);
  return specs.sort((a, b) => guess(a) - guess(b));
}

export function infraScene(
  clusters: SiteClusters,
  cables: CableSpec[],
  hoveredKey: string | undefined
): InfraScene {
  return {
    exchanges: siteSpecs(clusters.exchanges, hoveredKey),
    facilities: siteSpecs(clusters.facilities, hoveredKey),
    cloudRegions: siteSpecs(clusters.cloudRegions, hoveredKey),
    cables
  };
}
