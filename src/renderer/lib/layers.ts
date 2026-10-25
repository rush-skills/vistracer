import { ONLINE_IMAGERY_LAYER_ID } from "@common/ipc";
import type { GlobeScene } from "./globe";

/**
 * The globe layers the user can show or hide. The layer panel, the command
 * bar and the globe read this registry; a new layer is a new entry here plus
 * the code that draws it, with no change to the panel.
 */

export type LayerGroupId = "route" | "globe";

export const LAYER_GROUPS: ReadonlyArray<{ id: LayerGroupId; label: string }> = [
  { id: "route", label: "Route" },
  { id: "globe", label: "Globe" }
];

/** Imagery switches of the globe adapter (GlobeController.setImagery). */
export interface ImageryOptions {
  /** Sun lighting from the clock and city lights on the dark side. */
  dayNight: boolean;
  /** NASA GIBS tiles past the bundled levels. */
  online: boolean;
}

/** What a layer switch changes: items of the scene, or an imagery option. */
export type LayerTarget =
  | { readonly kind: "scene"; readonly items: keyof GlobeScene }
  | { readonly kind: "imagery"; readonly option: keyof ImageryOptions };

export interface LayerDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly group: LayerGroupId;
  readonly defaultVisible: boolean;
  readonly target: LayerTarget;
}

export const LAYERS = [
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
] as const satisfies readonly LayerDefinition[];

export type LayerId = (typeof LAYERS)[number]["id"];
export type LayerVisibility = Record<LayerId, boolean>;

/** Saved switches over the registry defaults; unknown saved ids are ignored. */
export function layerVisibility(saved: Readonly<Record<string, boolean>>): LayerVisibility {
  return Object.fromEntries(
    LAYERS.map((layer) => [layer.id, saved[layer.id] ?? layer.defaultVisible])
  ) as LayerVisibility;
}

/** The scene without the items of hidden scene layers. */
export function sceneForLayers(scene: GlobeScene, visibility: LayerVisibility): GlobeScene {
  const shown = { ...scene };
  for (const layer of LAYERS) {
    if (layer.target.kind === "scene" && !visibility[layer.id]) {
      shown[layer.target.items] = [];
    }
  }
  return shown;
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
