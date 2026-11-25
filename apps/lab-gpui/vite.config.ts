// The browser mock uses the native client's palette and icons, with local fixture data.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  cacheDir: "node_modules/.vite-native-mock",
  plugins: [react()],
  run: { tasks: { typecheck: { command: "effect-tsgo tsrs --noEmit" } } },
  server: {
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: Number(process.env.PORT ?? 5800),
    strictPort: true,
  },
  build: {
    outDir: process.env.LAB_OUT_DIR ?? "dist",
    emptyOutDir: true,
    rolldownOptions: { input: ["index.html", "image-preview/index.html"] },
  },
});
