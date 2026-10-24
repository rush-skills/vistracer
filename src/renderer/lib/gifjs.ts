/* eslint-disable @typescript-eslint/no-explicit-any */
// gif.js is a UMD bundle that sets window.GIF. It is loaded as a same-origin
// script file (not inline text) so that the app CSP can keep script-src 'self'.
import gifJsUrl from "./vendor/gifjs.min.js?url";
import gifWorkerSource from "./vendor/gif.worker.js?raw";

let gifConstructorPromise: Promise<any> | undefined;
let workerUrl: string | undefined;

const loadGifConstructor = (): Promise<any> => {
  if (!gifConstructorPromise) {
    gifConstructorPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = gifJsUrl;
      script.onload = () => {
        const GIF = (window as any).GIF;
        if (GIF) {
          resolve(GIF);
        } else {
          reject(new Error("gif.js loaded but did not register window.GIF"));
        }
      };
      script.onerror = () => {
        gifConstructorPromise = undefined;
        reject(new Error("Failed to load the gif.js encoder script"));
      };
      document.head.appendChild(script);
    });
  }
  return gifConstructorPromise;
};

const getWorkerUrl = (): string => {
  if (!workerUrl) {
    workerUrl = URL.createObjectURL(new Blob([gifWorkerSource], { type: "application/javascript" }));
  }
  return workerUrl;
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

export const createGif = async (options?: GifCreateOptions): Promise<GifJsInstance> => {
  const GIF = await loadGifConstructor();
  const instance = new GIF({
    workers: options?.workers ?? 2,
    quality: options?.quality ?? 10,
    repeat: options?.repeat ?? 0,
    background: options?.background ?? "#000",
    workerScript: getWorkerUrl()
  });
  return instance as GifJsInstance;
};
