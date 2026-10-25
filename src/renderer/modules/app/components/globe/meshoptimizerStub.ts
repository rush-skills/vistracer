/**
 * Replaces the `meshoptimizer` package in the Cesium bundle (see the alias in
 * vite.config.ts). Cesium only uses it for meshopt-compressed glTF models and
 * 3D Tiles terrain, which the globe never loads. The real package compiles
 * five WebAssembly modules as soon as it is imported, which the app's CSP
 * blocks (it has no 'wasm-unsafe-eval').
 */
const unsupported = (): never => {
  throw new Error("Meshopt-compressed data is not supported by the VisTracer globe.");
};

export const MeshoptDecoder = {
  supported: false,
  ready: Promise.resolve(),
  decodeGltfBuffer: unsupported,
  decodeVertexBuffer: unsupported,
  decodeIndexBuffer: unsupported,
  decodeIndexSequence: unsupported
};
