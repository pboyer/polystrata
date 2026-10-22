import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    exclude: ["manifold-3d"],
  },
  build: {
    outDir: "dist-demo",
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        benchmark: resolve(__dirname, "benchmark.html"),
      },
    },
  },
});
