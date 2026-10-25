import { describe, expect, it } from "vitest";
import { ONLINE_IMAGERY_LAYER_ID } from "@common/ipc";
import type { GlobeScene } from "@renderer/lib/globe";
import {
  LAYERS,
  LAYER_GROUPS,
  imageryForLayers,
  layerVisibility,
  sceneForLayers
} from "@renderer/lib/layers";

const point = { latitude: 0, longitude: 0, height: 0 };
const scene: GlobeScene = {
  markers: [{ hopIndex: 1, position: point, color: "#fff", emphasis: "normal" }],
  arcs: [{ fromHopIndex: 1, toHopIndex: 2, positions: [point], color: "#fff" }],
  rings: [
    {
      hopIndex: 1,
      radiusKm: 50,
      confidence: "high",
      color: "#fff",
      positions: [point],
      opacity: 1,
      dashed: false,
      lineWidth: 2
    }
  ],
  reaches: [
    { hopIndex: 3, referenceHopIndex: 1, radiusKm: 700, color: "#fff", opacity: 1, positions: [point] }
  ],
  labels: [{ hopIndex: 1, position: point, text: "1 · Somewhere" }]
};

describe("layer registry", () => {
  it("has unique ids that the backend accepts and a known group for each layer", () => {
    const ids = LAYERS.map((layer) => layer.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      // persistence.rs `is_registry_id`
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    }
    const groups = new Set(LAYER_GROUPS.map((group) => group.id));
    expect(LAYERS.every((layer) => groups.has(layer.group))).toBe(true);
  });

  it("covers every item of the globe scene", () => {
    const sceneItems = LAYERS.flatMap((layer) =>
      layer.target.kind === "scene" ? [layer.target.items] : []
    );
    expect(sceneItems.sort()).toEqual(Object.keys(scene).sort());
  });

  it("has the online imagery switch the tile cache enforces, on by default", () => {
    const online = LAYERS.find((layer) => layer.id === ONLINE_IMAGERY_LAYER_ID);
    expect(online?.target).toEqual({ kind: "imagery", option: "online" });
    expect(online?.defaultVisible).toBe(true);
  });
});

describe("layerVisibility", () => {
  it("uses the defaults, then the saved switches, and ignores unknown ids", () => {
    expect(Object.values(layerVisibility({})).every(Boolean)).toBe(true);
    const visibility = layerVisibility({ rings: false, "ixp-sites": true });
    expect(visibility.rings).toBe(false);
    expect(visibility.arcs).toBe(true);
    expect("ixp-sites" in visibility).toBe(false);
  });
});

describe("sceneForLayers", () => {
  it("drops only the items of hidden layers", () => {
    const shown = sceneForLayers(scene, layerVisibility({ rings: false, labels: false }));
    expect(shown.rings).toEqual([]);
    expect(shown.labels).toEqual([]);
    expect(shown.markers).toBe(scene.markers);
    expect(shown.arcs).toBe(scene.arcs);
    expect(shown.reaches).toBe(scene.reaches);
    // The input scene is not changed.
    expect(scene.rings).toHaveLength(1);
  });
});

describe("imageryForLayers", () => {
  it("maps the globe switches to the adapter's imagery options", () => {
    expect(imageryForLayers(layerVisibility({}))).toEqual({ dayNight: true, online: true });
    expect(
      imageryForLayers(layerVisibility({ "day-night": false, [ONLINE_IMAGERY_LAYER_ID]: false }))
    ).toEqual({ dayNight: false, online: false });
  });
});
