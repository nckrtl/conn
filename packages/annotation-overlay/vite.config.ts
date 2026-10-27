import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

// One self-contained IIFE that mounts the overlay when a page runs it.
export default defineConfig({
  plugins: [tailwindcss()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    target: "es2022",
    lib: {
      entry: "src/inject.ts",
      name: "ConnAnnotationOverlayBundle",
      formats: ["iife"],
      fileName: () => "inject.js",
    },
  },
});
