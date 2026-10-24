// gif.js is a UMD bundle that sets window.GIF. It is loaded as a same-origin
// script file (not inline text) so that the app CSP can keep script-src 'self'.
import gifJsUrl from "./vendor/gifjs.min.js?url";
import gifWorkerSource from "./vendor/gif.worker.js?raw";

export interface GifCreateOptions {
  workers?: number;
  quality?: number;
  repeat?: number;
  background?: string;
}

interface GifConstructorOptions extends Required<GifCreateOptions> {
  workerScript: string;
}

/** The part of the gif.js API that VisTracer uses. */
export interface GifJsInstance {
  addFrame(element: CanvasImageSource, options?: { copy?: boolean; delay?: number }): void;
  on(event: "finished", handler: (blob: Blob) => void): void;
  on(event: "abort", handler: () => void): void;
  render(): void;
}

type GifConstructor = new (options: GifConstructorOptions) => GifJsInstance;

let gifConstructorPromise: Promise<GifConstructor> | undefined;
let workerUrl: string | undefined;

const loadGifConstructor = (): Promise<GifConstructor> => {
  if (!gifConstructorPromise) {
    gifConstructorPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = gifJsUrl;
      script.onload = () => {
        const GIF = (window as Window & { GIF?: GifConstructor }).GIF;
        if (typeof GIF === "function") {
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

export const createGif = async (options?: GifCreateOptions): Promise<GifJsInstance> => {
  const GIF = await loadGifConstructor();
  return new GIF({
    workers: options?.workers ?? 2,
    quality: options?.quality ?? 10,
    repeat: options?.repeat ?? 0,
    background: options?.background ?? "#000",
    workerScript: getWorkerUrl()
  });
};
