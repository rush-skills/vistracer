import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import fs from "node:fs";
import path from "node:path";

// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;

const CESIUM_BUILD = path.resolve(__dirname, "node_modules", "cesium", "Build", "Cesium");
/**
 * The Cesium files the globe loads at run time, relative to CESIUM_BUILD:
 * workers that build globe tile meshes, the IAU 2006 tables for the sun
 * direction, the terrain height table that Cesium's entity display loads at
 * start, and the logo of the (hidden) credit display. Star box, moon and
 * water effects are off, so their textures are not shipped.
 */
const CESIUM_RUNTIME_FILES = [
  "Workers",
  "Assets/IAU2006_XYS",
  "Assets/approximateTerrainHeights.json",
  "Assets/Images"
];
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".png": "image/png",
  ".json": "application/json"
};

/**
 * Serves CESIUM_RUNTIME_FILES under /cesium/ in development and copies them,
 * with Cesium's license, into the build. cesiumGlobe.ts points
 * CESIUM_BASE_URL at that folder.
 */
function cesiumRuntimeFiles(): Plugin {
  let outDir = "";
  let isBuild = false;
  return {
    name: "vistracer-cesium-runtime-files",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      isBuild = config.command === "build";
    },
    configureServer(server) {
      server.middlewares.use("/cesium", (req, res, next) => {
        const relative = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const file = path.resolve(CESIUM_BUILD, relative);
        const allowed = CESIUM_RUNTIME_FILES.some((entry) => {
          const allowedPath = path.join(CESIUM_BUILD, entry);
          return file === allowedPath || file.startsWith(allowedPath + path.sep);
        });
        if (!allowed || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          next();
          return;
        }
        res.setHeader(
          "Content-Type",
          CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream"
        );
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      // Vite also calls this when the dev server stops.
      if (!isBuild) {
        return;
      }
      const target = path.join(outDir, "cesium");
      for (const entry of CESIUM_RUNTIME_FILES) {
        fs.cpSync(path.join(CESIUM_BUILD, entry), path.join(target, entry), { recursive: true });
      }
      fs.copyFileSync(
        path.resolve(CESIUM_BUILD, "..", "..", "LICENSE.md"),
        path.join(target, "LICENSE.md")
      );
    }
  };
}

export default defineConfig({
  root: path.resolve(__dirname, "src", "renderer"),
  // Only files the renderer loads by URL: bundled imagery and country
  // borders. README media in assets/ stays out of the app.
  publicDir: path.resolve(__dirname, "src", "renderer", "public"),
  base: "./",
  plugins: [
    react(),
    tsconfigPaths({
      projects: [path.resolve(__dirname, "tsconfig.renderer.json")]
    }),
    cesiumRuntimeFiles()
  ],
  resolve: {
    alias: {
      meshoptimizer: path.resolve(
        __dirname,
        "src/renderer/modules/app/components/globe/meshoptimizerStub.ts"
      ),
      "#wasm-single-thread": path.resolve(__dirname, "src/renderer/lib/satellites/satelliteWasmStub.ts"),
      "#wasm-multi-thread": path.resolve(__dirname, "src/renderer/lib/satellites/satelliteWasmStub.ts"),
      "@common": path.resolve(__dirname, "src", "common"),
      "@renderer": path.resolve(__dirname, "src", "renderer"),
      "@assets": path.resolve(__dirname, "assets")
    }
  },
  build: {
    outDir: path.resolve(__dirname, "dist", "renderer"),
    emptyOutDir: true,
    sourcemap: true,
    assetsInlineLimit: 0,
    // Cesium is one lazy chunk of about 4 MB; it loads from disk in the app.
    chunkSizeWarningLimit: 5000,
    // Tauri uses Chromium on Windows and WebKit on macOS/Linux
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14"
  },
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 5174 } : undefined,
    watch: {
      // Tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"]
    }
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"]
});
