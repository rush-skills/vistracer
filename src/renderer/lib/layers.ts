import { ONLINE_IMAGERY_LAYER_ID, SUBMARINE_CABLES_LAYER_ID } from "@common/ipc";
import type { GlobeScene } from "./globe";
import type { InfraSourceId } from "./infra/sources";

/**
 * The globe layers the user can show or hide. The layer panel, the command
 * bar and the globe read this registry; a new layer is a new entry here plus
 * the code that draws it, with no change to the panel.
 */

export type LayerGroupId = "route" | "infrastructure" | "cloud" | "globe";

export const LAYER_GROUPS: ReadonlyArray<{ id: LayerGroupId; label: string }> = [
  { id: "route", label: "Route" },
  { id: "infrastructure", label: "Infrastructure" },
  { id: "cloud", label: "Cloud" },
  { id: "globe", label: "Globe" }
];

/** Imagery switches of the globe adapter (GlobeController.setImagery). */
export interface ImageryOptions {
  /** Sun lighting from the clock and city lights on the dark side. */
  dayNight: boolean;
  /** NASA GIBS tiles past the bundled levels. */
  online: boolean;
}

/** How the route is drawn (buildGlobeScene). */
export interface SceneStyle {
  /** Arcs, markers and rings in one colour per network (ASN). */
  asnColors: boolean;
}

/** Scene items that a filter switch thins before clustering (`hiddenFilterKeys`). */
export type FilterableItems = "cloudRegions";

/**
 * What a layer switch changes: items of the scene, a part of those items
 * (by their filter key, applied before clustering), a style of the route,
 * or an imagery option.
 */
export type LayerTarget =
  | { readonly kind: "scene"; readonly items: keyof GlobeScene }
  | { readonly kind: "filter"; readonly items: FilterableItems; readonly key: string }
  | { readonly kind: "style"; readonly option: keyof SceneStyle }
  | { readonly kind: "imagery"; readonly option: keyof ImageryOptions };

/**
 * A notice the user must accept before a layer is shown the first time:
 * data with licence terms, or a download from a third-party host. Accepted
 * once, saved in `preferences.ui.consents`.
 */
export interface LayerConsent {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly accept: string;
}

/** `Id`: the registry's ids, so a link to another entry is checked (see `defineLayers`). */
export interface LayerDefinition<Id extends string = string> {
  readonly id: Id;
  readonly label: string;
  readonly description: string;
  readonly group: LayerGroupId;
  readonly defaultVisible: boolean;
  readonly target: LayerTarget;
  /** In the command bar ("Show …"); default: the label in lower case. */
  readonly commandName?: string;
  /** A switch under another layer: it only has an effect while that one is on. */
  readonly parent?: Id;
  /** Data the layer loads (lib/infra/sources.ts) when it is first shown. */
  readonly data?: InfraSourceId;
  readonly consent?: LayerConsent;
  /** Sample of the marker, for the panel: fill and outline colours. */
  readonly swatch?: { readonly fill: string; readonly outline: string };
}

/** Marker colours of the site layers (theme-independent, like the globe). */
export const SITE_COLORS = {
  exchange: { fill: "#57C7E3", outline: "#0A0E16" },
  facility: { fill: "#0A0E16", outline: "#C4A7FF" },
  aws: { fill: "#FFB547", outline: "#FFFFFF" },
  gcp: { fill: "#7ED67E", outline: "#FFFFFF" },
  azure: { fill: "#5AA9F5", outline: "#FFFFFF" },
  cloudflare: { fill: "#FF8A65", outline: "#FFFFFF" }
} as const;

export const SUBMARINE_CABLE_CONSENT: LayerConsent = {
  title: "Show submarine cables?",
  paragraphs: [
    "The cable routes come from TeleGeography's Submarine Cable Map. TeleGeography published the map under the Creative Commons licence CC BY-NC-SA 3.0, and VisTracer applies those terms: non-commercial use only, with attribution to TeleGeography, and adaptations under the same licence. TeleGeography's current terms can be different. The credits list TeleGeography while the layer is on.",
    "Turning the layer on downloads the cable map (about 0.75 MB) from TeleGeography's server, www.submarinecablemap.com. The request shows TeleGeography your IP address and nothing about your traces. VisTracer keeps a copy in its cache folder and asks again at most once a week, only while the layer is on.",
    "While the layer is off, VisTracer sends nothing to TeleGeography."
  ],
  accept: "Show and download"
};

/**
 * Keeps the entries' literal types, and makes a `parent` that is not the id
 * of an entry a type error.
 */
function defineLayers<const L extends readonly LayerDefinition<Extract<L[number]["id"], string>>[]>(
  layers: L
): L {
  return layers;
}

export const LAYERS = defineLayers([
  {
    id: "arcs",
    label: "Route arcs",
    description: "Great-circle arcs between hops, coloured by latency.",
    group: "route",
    defaultVisible: true,
    target: { kind: "scene", items: "arcs" }
  },
  {
    id: "markers",
    label: "Hop markers",
    description: "A point at each hop's estimated location.",
    group: "route",
    defaultVisible: true,
    target: { kind: "scene", items: "markers" }
  },
  {
    id: "rings",
    label: "Confidence rings",
    description: "How far off each location can be, true to scale.",
    group: "route",
    defaultVisible: true,
    target: { kind: "scene", items: "rings" }
  },
  {
    id: "anycast-reach",
    label: "Anycast reach",
    description: "The area an anycast hop answered from.",
    group: "route",
    defaultVisible: true,
    target: { kind: "scene", items: "reaches" }
  },
  {
    id: "labels",
    label: "Labels",
    description: "Names of the selected and the hovered hop.",
    group: "route",
    defaultVisible: true,
    target: { kind: "scene", items: "labels" }
  },
  {
    id: "asn-colors",
    label: "Network colours",
    description:
      "Arcs, markers and rings in one colour per network (ASN), with a legend. Off: arcs by latency.",
    group: "route",
    defaultVisible: false,
    target: { kind: "style", option: "asnColors" }
  },
  {
    id: "exchanges",
    label: "Internet exchanges",
    description:
      "PeeringDB exchanges (IXPs); the ones your route uses or passes stand out. From the list that exchange matching downloads; nothing more is sent.",
    group: "infrastructure",
    defaultVisible: false,
    target: { kind: "scene", items: "exchanges" },
    data: "peeringdb-sites",
    swatch: SITE_COLORS.exchange
  },
  {
    id: "data-centres",
    label: "Data centres",
    description:
      "PeeringDB facilities; the nearest one to each hop stands out. Same list as the exchanges.",
    group: "infrastructure",
    defaultVisible: false,
    target: { kind: "scene", items: "facilities" },
    data: "peeringdb-sites",
    swatch: SITE_COLORS.facility
  },
  {
    id: SUBMARINE_CABLES_LAYER_ID,
    label: "Submarine cables",
    description:
      "TeleGeography's cable map (CC BY-NC-SA 3.0, non-commercial). Opt-in: downloads from www.submarinecablemap.com.",
    group: "infrastructure",
    defaultVisible: false,
    target: { kind: "scene", items: "cables" },
    data: "submarine-cables",
    consent: SUBMARINE_CABLE_CONSENT
  },
  {
    id: "cloud-regions",
    label: "Cloud regions",
    description:
      "AWS, Google Cloud and Azure regions and Cloudflare data centres (bundled, approximate). Marks hops that are likely inside one.",
    group: "cloud",
    defaultVisible: false,
    target: { kind: "scene", items: "cloudRegions" },
    data: "cloud-regions"
  },
  {
    id: "cloud-aws",
    label: "AWS",
    commandName: "AWS regions",
    description: "Amazon Web Services regions.",
    group: "cloud",
    parent: "cloud-regions",
    defaultVisible: true,
    target: { kind: "filter", items: "cloudRegions", key: "aws" },
    swatch: SITE_COLORS.aws
  },
  {
    id: "cloud-gcp",
    label: "Google Cloud",
    commandName: "Google Cloud regions",
    description: "Google Cloud regions.",
    group: "cloud",
    parent: "cloud-regions",
    defaultVisible: true,
    target: { kind: "filter", items: "cloudRegions", key: "gcp" },
    swatch: SITE_COLORS.gcp
  },
  {
    id: "cloud-azure",
    label: "Azure",
    commandName: "Azure regions",
    description: "Microsoft Azure regions.",
    group: "cloud",
    parent: "cloud-regions",
    defaultVisible: true,
    target: { kind: "filter", items: "cloudRegions", key: "azure" },
    swatch: SITE_COLORS.azure
  },
  {
    id: "cloud-cloudflare",
    label: "Cloudflare",
    commandName: "Cloudflare data centres",
    description: "Cloudflare data centres (Cloudflare has no regions).",
    group: "cloud",
    parent: "cloud-regions",
    defaultVisible: true,
    target: { kind: "filter", items: "cloudRegions", key: "cloudflare" },
    swatch: SITE_COLORS.cloudflare
  },
  {
    id: "day-night",
    label: "Day and night",
    description: "Sunlight for the current time, city lights on the dark side.",
    group: "globe",
    defaultVisible: true,
    target: { kind: "imagery", option: "dayNight" }
  },
  {
    id: ONLINE_IMAGERY_LAYER_ID,
    label: "Online imagery",
    description:
      "Sharper NASA GIBS tiles when you zoom in. Off: only the bundled imagery, nothing is downloaded.",
    group: "globe",
    defaultVisible: true,
    target: { kind: "imagery", option: "online" }
  }
]);

export type LayerId = (typeof LAYERS)[number]["id"];
export type LayerVisibility = Record<LayerId, boolean>;

/** The registry with each entry typed as the general definition, ids as `LayerId`. */
export const LAYER_LIST: readonly LayerDefinition<LayerId>[] = LAYERS;

export function layerById(id: LayerId): LayerDefinition<LayerId> | undefined {
  return LAYER_LIST.find((layer) => layer.id === id);
}

/** Saved switches over the registry defaults; unknown saved ids are ignored. */
export function layerVisibility(saved: Readonly<Record<string, boolean>>): LayerVisibility {
  return Object.fromEntries(
    LAYERS.map((layer) => [layer.id, saved[layer.id] ?? layer.defaultVisible])
  ) as LayerVisibility;
}

/** On, and (for a child switch) its parent on too. */
export function layerActive(visibility: LayerVisibility, id: LayerId): boolean {
  const parent = layerById(id)?.parent;
  return visibility[id] && (parent == null || visibility[parent]);
}

/** The data sources that the shown layers need. */
export function sourcesForLayers(visibility: LayerVisibility): Set<InfraSourceId> {
  const sources = new Set<InfraSourceId>();
  for (const layer of LAYER_LIST) {
    if (layer.data && layerActive(visibility, layer.id)) {
      sources.add(layer.data);
    }
  }
  return sources;
}

/** Filter keys switched off for `items` (applied before clustering). */
export function hiddenFilterKeys(visibility: LayerVisibility, items: FilterableItems): Set<string> {
  const hidden = new Set<string>();
  for (const layer of LAYER_LIST) {
    const { target } = layer;
    if (target.kind === "filter" && target.items === items && !visibility[layer.id]) {
      hidden.add(target.key);
    }
  }
  return hidden;
}

const NONE: readonly never[] = Object.freeze([]);

/**
 * The scene without the items of hidden scene layers. Hidden items become
 * one shared empty list, so the adapter sees that nothing changed.
 */
export function sceneForLayers(scene: GlobeScene, visibility: LayerVisibility): GlobeScene {
  const shown = { ...scene };
  for (const layer of LAYERS) {
    if (layer.target.kind === "scene" && !visibility[layer.id]) {
      (shown as Record<keyof GlobeScene, readonly unknown[]>)[layer.target.items] = NONE;
    }
  }
  return shown;
}

export function styleForLayers(visibility: LayerVisibility): SceneStyle {
  const style: SceneStyle = { asnColors: false };
  for (const layer of LAYERS) {
    if (layer.target.kind === "style") {
      style[layer.target.option] = visibility[layer.id];
    }
  }
  return style;
}

export function imageryForLayers(visibility: LayerVisibility): ImageryOptions {
  const options: ImageryOptions = { dayNight: true, online: true };
  for (const layer of LAYERS) {
    if (layer.target.kind === "imagery") {
      options[layer.target.option] = visibility[layer.id];
    }
  }
  return options;
}
