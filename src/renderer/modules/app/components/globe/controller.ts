import type { CameraFocus, GlobeScene, ViewInsets } from "@renderer/lib/globe";
import type { ImageryOptions } from "@renderer/lib/layers";
import type { SatelliteGroupDrawing } from "@renderer/lib/satellites/scene";

/**
 * The seam between React and Cesium. GlobeViewport only talks to this
 * interface; cesiumGlobe.ts implements it and is the only module that
 * imports Cesium, so the rest stays testable without WebGL.
 */
export interface GlobeController {
  /** Redraws only the item groups whose lists changed (by identity). */
  setScene(scene: GlobeScene): void;
  /** `insets`: pixels of the canvas the panels cover; the hop is framed in the rest. */
  flyTo(focus: CameraFocus, insets?: ViewInsets): void;
  setInputEnabled(enabled: boolean): void;
  /** Day/night shading and online imagery (layer panel switches). */
  setImagery(options: ImageryOptions): void;
  /** Emphasises the site marker or satellite with this key (or none); rebuilds nothing. */
  setHoveredSite(key: string | undefined): void;
  /**
   * The satellite groups to draw; an empty list draws none and stops their
   * updates. Groups whose `satellites` keep their identity keep their points.
   */
  setSatellites(groups: readonly SatelliteGroupDrawing[]): void;
  destroy(): void;
}

export interface GlobeCallbacks {
  onSelectHop(hopIndex: number): void;
  /** `at`: the pointer in client pixels, while a hop is under it. */
  onHoverHop(hopIndex: number | undefined, at?: { x: number; y: number }): void;
  /**
   * A site marker, cable or satellite under the pointer (its key), when no
   * hop is. `heightKm`: a satellite's height when the pointer reached it.
   */
  onHoverSite(key: string | undefined, at?: { x: number; y: number }, heightKm?: number): void;
  /** The satellite code did not load; the layer cannot be drawn. */
  onSatelliteError(message: string): void;
  /**
   * The cluster level of the view changed (lib/infra/cluster.ts). Reported
   * from frames that are drawn anyway, so it adds none.
   */
  onClusterLevel(level: number): void;
  /** A detailed tile failed to load; the bundled imagery shows instead. */
  onImageryError(message: string): void;
}

export type CreateGlobe = (container: HTMLElement, callbacks: GlobeCallbacks) => GlobeController;
