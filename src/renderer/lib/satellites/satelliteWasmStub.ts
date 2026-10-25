/**
 * Replaces the two WebAssembly builds of satellite.js (`#wasm-single-thread`,
 * `#wasm-multi-thread`; see the aliases in vite.config.ts). The app only uses
 * the JavaScript SGP4 functions (lib/satellites/propagate.ts). The builds
 * would compile WebAssembly, which the app's CSP blocks (it has no
 * 'wasm-unsafe-eval'), and one of them starts a Node worker.
 */
export default function createWasmModule(): never {
  throw new Error("The WebAssembly propagator of satellite.js is not part of VisTracer.");
}
