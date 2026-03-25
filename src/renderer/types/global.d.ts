import type { RendererApi } from "@common/bridge";

declare global {
  interface Window {
    visTracer: RendererApi;
  }
}

export {};
