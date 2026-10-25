import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ONLINE_IMAGERY_LAYER_ID,
  SATELLITES_LAYER_ID,
  SUBMARINE_CABLES_LAYER_ID
} from "@common/ipc";
import type { GlobeScene } from "@renderer/lib/globe";
import {
  LAYERS,
  LAYER_GROUPS,
  LAYER_LIST,
  hiddenFilterKeys,
  imageryForLayers,
  layerActive,
  layerById,
  layerVisibility,
  satelliteGroupsForLayers,
  sceneForLayers,
  styleForLayers
} from "@renderer/lib/layers";
import { parseCloudRegions } from "@renderer/lib/infra/sources";

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
  labels: [{ hopIndex: 1, position: point, text: "1 · Somewhere" }],
  exchanges: [],
  facilities: [],
  cloudRegions: [],
  cables: []
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

  it("adds the infrastructure layers off by default, each with its data source", () => {
    const infra = LAYER_LIST.filter((layer) => layer.group === "infrastructure" || layer.group === "cloud");
    expect(infra.filter((layer) => !layer.parent).every((layer) => !layer.defaultVisible)).toBe(true);
    expect(layerById("exchanges")?.data).toBe("peeringdb-sites");
    expect(layerById("data-centres")?.data).toBe("peeringdb-sites");
    expect(layerById("cloud-regions")?.data).toBe("cloud-regions");
    expect(layerById("asn-colors")).toMatchObject({
      defaultVisible: false,
      target: { kind: "style", option: "asnColors" }
    });
  });

  it("puts the submarine cables behind a notice that names the licence and the host", () => {
    const cables = layerById(SUBMARINE_CABLES_LAYER_ID);
    expect(cables?.defaultVisible).toBe(false);
    expect(cables?.data).toBe("submarine-cables");
    const text = cables?.consent?.paragraphs.join(" ") ?? "";
    expect(text).toContain("CC BY-NC-SA 3.0");
    expect(text).toContain("non-commercial");
    expect(text).toContain("attribution");
    expect(text).toContain("www.submarinecablemap.com");
    // Only the two layers that download from a new host ask for consent.
    expect(LAYER_LIST.filter((layer) => layer.consent).map((layer) => layer.id)).toEqual([
      SUBMARINE_CABLES_LAYER_ID,
      SATELLITES_LAYER_ID
    ]);
  });

  it("puts the satellites behind a notice that names CelesTrak, its limits and the host", () => {
    const satellites = layerById(SATELLITES_LAYER_ID);
    expect(satellites).toMatchObject({ defaultVisible: false, group: "space" });
    expect(satellites?.data).toBeUndefined();
    const text = satellites?.consent?.paragraphs.join(" ") ?? "";
    for (const part of ["celestrak.org", "CelesTrak", "usage policy", "IP address", "12 hours", "2 hours", "sends nothing"]) {
      expect(text).toContain(part);
    }
  });

  it("has one switch under the satellites per group, with the backend's defaults", () => {
    const groups = LAYER_LIST.filter(
      (layer) => layer.target.kind === "satellites" && layer.target.group
    );
    expect(groups.map((layer) => layer.id)).toEqual([
      "satellites-starlink",
      "satellites-oneweb",
      "satellites-gps",
      "satellites-stations",
      "satellites-geo"
    ]);
    for (const layer of groups) {
      expect(layer.parent).toBe(SATELLITES_LAYER_ID);
      expect(layer.data).toBe(`celestrak-${layer.target.kind === "satellites" ? layer.target.group : ""}`);
    }
    // The backend decides from the same ids and defaults (commands/satellites.rs).
    const rust = fs.readFileSync(
      path.resolve(__dirname, "../../../../src-tauri/src/commands/satellites.rs"),
      "utf8"
    );
    const table = [...rust.matchAll(/layer: "([a-z-]+)",\s*group: "([a-z-]+)",\s*default_on: (true|false)/g)];
    expect(table.map(([, layer, , on]) => [layer, on === "true"])).toEqual(
      groups.map((layer) => [layer.id, layer.defaultVisible])
    );
    expect(table.map(([, , group]) => group)).toEqual(["starlink", "oneweb", "gps-ops", "stations", "geo"]);
  });

  it("has one provider switch under cloud regions per provider of the snapshot", () => {
    const snapshot = parseCloudRegions(
      JSON.parse(
        fs.readFileSync(path.resolve(__dirname, "../../public/infra/cloud-regions.json"), "utf8")
      )
    );
    const filters = LAYER_LIST.filter((layer) => layer.target.kind === "filter");
    expect(filters.every((layer) => layer.parent === "cloud-regions" && layer.defaultVisible)).toBe(true);
    expect(filters.map((layer) => (layer.target.kind === "filter" ? layer.target.key : "")).sort()).toEqual(
      snapshot.providers.map((provider) => provider.id).sort()
    );
  });

  it("has the online imagery switch the tile cache enforces, on by default", () => {
    const online = LAYERS.find((layer) => layer.id === ONLINE_IMAGERY_LAYER_ID);
    expect(online?.target).toEqual({ kind: "imagery", option: "online" });
    expect(online?.defaultVisible).toBe(true);
  });
});

describe("layerVisibility", () => {
  it("uses the defaults, then the saved switches, and ignores unknown ids", () => {
    const defaults = layerVisibility({});
    for (const layer of LAYERS) {
      expect(defaults[layer.id]).toBe(layer.defaultVisible);
    }
    const visibility = layerVisibility({ rings: false, "ixp-sites": true });
    expect(visibility.rings).toBe(false);
    expect(visibility.arcs).toBe(true);
    expect("ixp-sites" in visibility).toBe(false);
  });
});

describe("data sources, filters and styles", () => {
  it("shows a child switch only with its parent on", () => {
    const parentOff = layerVisibility({ "cloud-aws": true });
    expect(layerActive(parentOff, "cloud-aws")).toBe(false);
    expect(layerActive(layerVisibility({ "cloud-regions": true }), "cloud-aws")).toBe(true);
  });

  it("shows the satellite groups only with the satellites layer on", () => {
    expect(satelliteGroupsForLayers(layerVisibility({}))).toEqual([]);
    const groupOnly = layerVisibility({ "satellites-geo": true });
    expect(satelliteGroupsForLayers(groupOnly)).toEqual([]);
    expect(layerActive(groupOnly, "satellites-geo")).toBe(false);
    const on = layerVisibility({ [SATELLITES_LAYER_ID]: true });
    expect(satelliteGroupsForLayers(on)).toEqual(["starlink", "gps", "stations"]);
    expect(
      satelliteGroupsForLayers(
        layerVisibility({ [SATELLITES_LAYER_ID]: true, "satellites-starlink": false, "satellites-geo": true })
      )
    ).toEqual(["gps", "stations", "geo"]);
  });

  it("lists the provider filters that are switched off", () => {
    expect(hiddenFilterKeys(layerVisibility({}), "cloudRegions")).toEqual(new Set());
    expect(
      hiddenFilterKeys(layerVisibility({ "cloud-azure": false, "cloud-cloudflare": false }), "cloudRegions")
    ).toEqual(new Set(["azure", "cloudflare"]));
  });

  it("maps the network colour switch to the route style", () => {
    expect(styleForLayers(layerVisibility({}))).toEqual({ asnColors: false });
    expect(styleForLayers(layerVisibility({ "asn-colors": true }))).toEqual({ asnColors: true });
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

  it("gives hidden items one shared empty list, so the adapter sees no change", () => {
    const first = sceneForLayers(scene, layerVisibility({}));
    const second = sceneForLayers({ ...scene, cables: [] }, layerVisibility({}));
    expect(first.cables).toBe(second.cables);
    expect(first.exchanges).toBe(second.facilities);
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
