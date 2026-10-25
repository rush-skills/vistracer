import type { CameraFocus, GlobeScene } from "@renderer/lib/globe";
import type { ImageryOptions } from "@renderer/lib/layers";

/**
 * The seam between React and Cesium. GlobeViewport only talks to this
 * interface; cesiumGlobe.ts implements it and is the only module that
 * imports Cesium, so the rest stays testable without WebGL.
 */
export interface GlobeController {
  setScene(scene: GlobeScene): void;
  flyTo(focus: CameraFocus): void;
  setInputEnabled(enabled: boolean): void;
  /** Day/night shading and online imagery (layer panel switches). */
  setImagery(options: ImageryOptions): void;
  destroy(): void;
}

export interface GlobeCallbacks {
  onSelectHop(hopIndex: number): void;
  onHoverHop(hopIndex: number | undefined): void;
  /** A detailed tile failed to load; the bundled imagery shows instead. */
  onImageryError(message: string): void;
}

export type CreateGlobe = (container: HTMLElement, callbacks: GlobeCallbacks) => GlobeController;
