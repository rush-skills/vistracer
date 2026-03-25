/* eslint-disable @typescript-eslint/no-explicit-any */
import gifJsSource from "./vendor/gifjs.min.js?raw";
import gifWorkerSource from "./vendor/gif.worker.js?raw";

let initialized = false;
let workerUrl: string | undefined;

const ensureInitialized = () => {
  if (!initialized) {
    const script = document.createElement("script");
    script.type = "text/javascript";
    script.text = gifJsSource;
    document.head.appendChild(script);
    initialized = true;
  }
  if (!workerUrl) {
    workerUrl = URL.createObjectURL(new Blob([gifWorkerSource], { type: "application/javascript" }));
  }
  return {
    GIF: (window as any).GIF,
    workerScript: workerUrl!
  };
};

export type GifJsInstance = {
  addFrame: (element: CanvasImageSource, options?: Record<string, unknown>) => void;
  on: (event: string, handler: (...args: any[]) => void) => void;
  once: (event: string, handler: (...args: any[]) => void) => void;
  render: () => void;
  abort: () => void;
};

export interface GifCreateOptions {
  workers?: number;
  quality?: number;
  repeat?: number;
  background?: string;
}

export const createGif = (options?: GifCreateOptions): GifJsInstance => {
  const { GIF, workerScript } = ensureInitialized();
  if (!GIF) {
    throw new Error("Failed to initialize gif.js");
  }
  const instance = new GIF({
    workers: options?.workers ?? 2,
    quality: options?.quality ?? 10,
    repeat: options?.repeat ?? 0,
    background: options?.background ?? "#000",
    workerScript
  });
  return instance as GifJsInstance;
};
