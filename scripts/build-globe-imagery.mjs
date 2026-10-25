#!/usr/bin/env node
// Downloads the low-resolution globe imagery that the app bundles, so the
// globe has day and night imagery with no network:
// src/renderer/public/imagery/{layer}/{z}/{x}/{y}.jpg
//
//   node scripts/build-globe-imagery.mjs src/renderer/public/imagery
//
// Tiles use Cesium's GeographicTilingScheme: level z has 2^(z+1) columns and
// 2^z rows of 256 x 256 px, x from 180°W, y from 90°N. GIBS's own EPSG:4326
// tile matrices do not match that scheme, so each tile is a WMS GetMap with
// its exact bounding box. Source: NASA GIBS (no key; NASA imagery is not
// subject to copyright in the US). See docs/third-party-data.md.
//
// The layer ids and levels must match BUNDLED_IMAGERY in
// src/renderer/lib/imagery.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
const LAYERS = [
  { id: "blue-marble", gibs: "BlueMarble_ShadedRelief_Bathymetry", maxLevel: 4 },
  { id: "black-marble", gibs: "VIIRS_Black_Marble", time: "2016-01-01", maxLevel: 4 }
];
const TILE_SIZE = 256;
const CONCURRENCY = 4;
const ATTEMPTS = 4;

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: build-globe-imagery.mjs <output dir>");
  process.exit(2);
}

function tileUrl(layer, z, x, y) {
  const size = 180 / 2 ** z;
  const west = -180 + x * size;
  const north = 90 - y * size;
  const params = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.3.0",
    LAYERS: layer.gibs,
    STYLES: "",
    CRS: "EPSG:4326",
    // WMS 1.3.0 with EPSG:4326 takes latitude first.
    BBOX: [north - size, west, north, west + size].join(","),
    WIDTH: String(TILE_SIZE),
    HEIGHT: String(TILE_SIZE),
    FORMAT: "image/jpeg"
  });
  if (layer.time) {
    params.set("TIME", layer.time);
  }
  return `${WMS}?${params}`;
}

async function fetchTile(url) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url);
      const type = response.headers.get("content-type") ?? "";
      const bytes = Buffer.from(await response.arrayBuffer());
      // GIBS answers some errors with HTTP 200 and an XML ServiceException.
      if (response.ok && type.startsWith("image/jpeg") && bytes[0] === 0xff && bytes[1] === 0xd8) {
        return bytes;
      }
      throw new Error(`HTTP ${response.status} ${type} (${bytes.length} bytes)`);
    } catch (error) {
      if (attempt >= ATTEMPTS) {
        throw new Error(`${url}: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

const jobs = LAYERS.flatMap((layer) => {
  const tiles = [];
  for (let z = 0; z <= layer.maxLevel; z += 1) {
    for (let x = 0; x < 2 ** (z + 1); x += 1) {
      for (let y = 0; y < 2 ** z; y += 1) {
        tiles.push({ layer, z, x, y });
      }
    }
  }
  return tiles;
});

const totals = new Map();
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const { layer, z, x, y } = jobs[next];
    next += 1;
    const bytes = await fetchTile(tileUrl(layer, z, x, y));
    const file = path.join(outDir, layer.id, String(z), String(x), `${y}.jpg`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    const total = totals.get(layer.id) ?? { tiles: 0, bytes: 0 };
    totals.set(layer.id, { tiles: total.tiles + 1, bytes: total.bytes + bytes.length });
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
for (const [id, { tiles, bytes }] of totals) {
  console.log(`${id}: ${tiles} tiles, ${(bytes / 1e6).toFixed(2)} MB`);
}
