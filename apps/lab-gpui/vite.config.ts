// The browser mock uses the native client's palette and icons, with local fixture data.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  cacheDir: "../node_modules/.vite-lab-gpui",
  plugins: [react()],
  server: {
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: Number(process.env.PORT ?? 5800),
    strictPort: true,
    // The mock reads GPUI's icons and fonts and the shared themes in crates/.
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
  },
  build: {
    outDir: process.env.LAB_OUT_DIR ?? "dist",
    emptyOutDir: true,
    rolldownOptions: { input: ["index.html", "image-preview/index.html"] },
  },
});
