import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "polystrata",
      formats: ["es", "cjs"],
      fileName: (format) => (format === "es" ? "index.js" : "index.cjs"),
    },
  },
});
