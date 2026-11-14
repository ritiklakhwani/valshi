import { defineConfig } from "vite";

// Built into ../docs/play so GitHub Pages can serve it from the /docs folder.
export default defineConfig({
  base: "./",
  build: { outDir: "../docs/play", emptyOutDir: true },
});
