import type { CameraFocus, GlobeScene, ViewInsets } from "@renderer/lib/globe";
import type { ImageryOptions } from "@renderer/lib/layers";

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
  destroy(): void;
}

export interface GlobeCallbacks {
  onSelectHop(hopIndex: number): void;
  /** `at`: the pointer in client pixels, while a hop is under it. */
  onHoverHop(hopIndex: number | undefined, at?: { x: number; y: number }): void;
  /** A site marker or cable under the pointer (its spec key), when no hop is. */
  onHoverSite(key: string | undefined, at?: { x: number; y: number }): void;
  /**
   * The cluster level of the view changed (lib/infra/cluster.ts). Reported
   * from frames that are drawn anyway, so it adds none.
   */
  onClusterLevel(level: number): void;
  /** A detailed tile failed to load; the bundled imagery shows instead. */
  onImageryError(message: string): void;
}

export type CreateGlobe = (container: HTMLElement, callbacks: GlobeCallbacks) => GlobeController;
