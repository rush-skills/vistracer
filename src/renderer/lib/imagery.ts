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

/** Extra height above Cesium's refinement threshold, for rounding and tile edges. */
const BUNDLED_ONLY_MARGIN = 1.15;

export interface RefinementInputs {
  /**
   * Cesium's geometric error of the last bundled terrain level
   * (`TerrainProvider.getLevelMaximumGeometricError(minimumTerrainLevel - 1)`).
   */
  levelGeometricErrorM: number;
  /** The larger side of the view in CSS pixels: Cesium's field of view spans it. */
  viewportPx: number;
  /** `PerspectiveFrustum.fov`. */
  fovRad: number;
  /** `Globe.maximumScreenSpaceError`. */
  maximumScreenSpaceError: number;
}

/**
 * The lowest camera height at which Cesium draws the globe only from the
 * bundled levels, so no online tile is requested. Cesium loads the next
 * terrain level when a tile's screen-space error,
 * `geometricError × viewportPx / (distance × 2 tan(fov / 2))`, is above
 * `maximumScreenSpaceError` (QuadtreePrimitive `screenSpaceError`; for a
 * landscape view the field of view spans the width). The nearest tile is
 * at the camera height when the camera looks straight down.
 */
export function bundledOnlyHeight(inputs: RefinementInputs): number {
  const threshold =
    (inputs.levelGeometricErrorM * inputs.viewportPx) /
    (inputs.maximumScreenSpaceError * 2 * Math.tan(inputs.fovRad / 2));
  return threshold * BUNDLED_ONLY_MARGIN;
}

/**
 * Whether the online imagery layer may load tiles. A camera move the app
 * makes hides it, and it stays hidden after the move until the user zooms,
 * drags or tilts the globe; from then on only the user's own view loads
 * online tiles. So a view the app chose never loads them, whatever the
 * window size does later. Input during a flight or while input is locked
 * (exports) does not count: Cesium ignores it.
 */
export class OnlineImageryGate {
  private flying = false;
  private locked = false;
  private heldByApp = false;

  get visible(): boolean {
    return !this.heldByApp;
  }

  appFlightStarted(): void {
    this.flying = true;
    this.heldByApp = true;
  }

  appFlightEnded(): void {
    this.flying = false;
  }

  setInputLocked(locked: boolean): void {
    this.locked = locked;
  }

  /** A zoom, drag or tilt from the user. Returns true when it shows the layer again. */
  userMovedCamera(): boolean {
    if (this.flying || this.locked || !this.heldByApp) {
      return false;
    }
    this.heldByApp = false;
    return true;
  }
}

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
