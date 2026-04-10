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
    include: ["tests/e2e/**/*.test.ts"],
  },
  resolve: { alias }
});
