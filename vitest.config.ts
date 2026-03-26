import { defineConfig } from "vitest/config";
import path from "node:path";
import react from "@vitejs/plugin-react";

const alias = {
  "@common": path.resolve(__dirname, "src/common"),
  "@renderer": path.resolve(__dirname, "src/renderer"),
  "@assets": path.resolve(__dirname, "assets")
};

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: [path.resolve(__dirname, "vitest.setup.ts")],
    // Main-process and common tests run under Node; renderer tests use jsdom (default)
    projects: [
      {
        test: {
          name: "node",
          include: ["src/main/**/*.test.ts", "src/common/**/*.test.ts"],
          environment: "node",
          globals: true
        },
        resolve: { alias }
      },
      {
        test: {
          name: "renderer",
          include: ["src/renderer/**/*.test.ts"],
          environment: "jsdom",
          setupFiles: [path.resolve(__dirname, "vitest.setup.ts")],
          globals: true
        },
        resolve: { alias }
      }
    ]
  },
  resolve: { alias }
});
