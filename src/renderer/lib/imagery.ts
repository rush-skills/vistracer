/**
 * Globe imagery sources. Bundled tiles cover levels 0-4 with no network;
 * the Rust tile cache (`vistiles` scheme, src-tauri/src/commands/tile_cache.rs)
 * serves NASA GIBS tiles for closer zoom.
 */

/**
 * NASA Blue Marble (day) and Black Marble 2016 (night) from GIBS, in
 * Cesium's GeographicTilingScheme, 256 px JPEG. Built by
 * scripts/build-globe-imagery.mjs; the levels must match.
 */
export const BUNDLED_IMAGERY = {
  maximumLevel: 4,
  day: "./imagery/blue-marble/{z}/{x}/{y}.jpg",
  night: "./imagery/black-marble/{z}/{x}/{y}.jpg"
} as const;

/**
 * Online day tiles (EPSG:3857, GoogleMapsCompatible_Level8). Mirrors
 * `TILE_LAYERS` in tile_cache.rs. The night imagery fades out as the camera
 * comes close (`nightImageryShare`), where the bundled levels would blur, so
 * it has no online layer.
 */
export const ONLINE_IMAGERY = {
  layer: "blue-marble",
  extension: "jpg",
  maximumLevel: 8,
  /** Below this terrain level the bundled tiles are as sharp, so nothing is fetched. */
  minimumTerrainLevel: BUNDLED_IMAGERY.maximumLevel + 1
} as const;

/**
 * Cesium darkens the night side to 30 % of the imagery colour; the city
 * lights are brightened to make up for it.
 */
export const NIGHT_BRIGHTNESS = 3;

/**
 * How much the night imagery covers the dark side, from the camera distance
 * to the Earth's centre: 1 far out, 0 close up, on the same scale as
 * Cesium's lighting fade (`Globe.lightingFadeOutDistance` to
 * `lightingFadeInDistance`). Cesium itself picks the night layers by sun
 * direction only, so without this a zoomed-in view of the dark side would
 * show blurred night tiles while the shading says "lit".
 */
export function nightImageryShare(
  cameraDistanceM: number,
  fadeOutM: number,
  fadeInM: number
): number {
  if (!(fadeInM > fadeOutM)) {
    return 1;
  }
  return Math.min(1, Math.max(0, (cameraDistanceM - fadeOutM) / (fadeInM - fadeOutM)));
}

export const IMAGERY_CREDIT =
  "Imagery: NASA Blue Marble and Black Marble, served by NASA GIBS (ESDIS)";

/**
 * URL template for online tiles, or null outside the desktop app (a plain
 * browser has no `vistiles` scheme). `convertFileSrc` is Tauri's helper,
 * which knows the scheme form of each platform: `vistiles://localhost/` on
 * macOS and Linux, `http://vistiles.localhost/` on Windows.
 */
export function onlineTileTemplate(
  convertFileSrc: ((path: string, protocol: string) => string) | undefined
): string | null {
  if (!convertFileSrc) {
    return null;
  }
  const base = convertFileSrc("", "vistiles").replace(/\/*$/, "/");
  return `${base}${ONLINE_IMAGERY.layer}/{z}/{y}/{x}.${ONLINE_IMAGERY.extension}`;
}
