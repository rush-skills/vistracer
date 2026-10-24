import type { RendererApi } from "@common/bridge";

declare global {
  interface Window {
    visTracer: RendererApi;
    /** Where Cesium loads its workers and assets from (set in cesiumGlobe.ts). */
    CESIUM_BASE_URL?: string;
  }
}

export {};
