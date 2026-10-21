import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
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
