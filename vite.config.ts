import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "node:path";

// https://v2.tauri.app/start/frontend/vite/
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  root: path.resolve(__dirname, "src", "renderer"),
  publicDir: path.resolve(__dirname, "assets"),
  base: "./",
  plugins: [
    react(),
    tsconfigPaths({
      projects: [path.resolve(__dirname, "tsconfig.renderer.json")]
    })
  ],
  resolve: {
    alias: {
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
