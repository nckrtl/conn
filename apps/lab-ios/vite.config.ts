// Conn iOS design lab: web mocks of the iOS screens (src), for fast design iteration without the
// simulator. `npm run lab:ios` in apps/ serves index.html on 127.0.0.1:5801; screen, theme, state
// and scale live in the URL (src/urlState.ts).
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  cacheDir: "../node_modules/.vite-lab-ios",
  plugins: [react()],
  server: {
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: Number(process.env.PORT ?? 5801),
    strictPort: true,
    // The mock reads GPUI's brand icons, assets/conn and the shared themes in crates/.
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
  },
  build: { outDir: process.env.LAB_OUT_DIR ?? "dist", emptyOutDir: true },
});
