import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "src", "renderer"),
  publicDir: path.resolve(__dirname, "assets"),
  base: './', // Use relative paths for Electron file:// protocol
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
    assetsInlineLimit: 0, // Don't inline large assets like earth textures
  },
  server: {
    port: 5173
  }
});
