import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The live console calls /api/shadow/* and /api/demo/* on its own origin. In
// production Vercel rewrites them to the demo backend (vercel.json); in
// development they go to a local front door (bifrost-shadow/deploy, port 10000)
// or wherever SHADOW_BACKEND points.
const backend = process.env.SHADOW_BACKEND ?? "http://localhost:10000";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the build works from any sub-path (GitHub Pages, a docs folder).
  base: "./",
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      "/api/shadow": { target: backend, changeOrigin: true },
      "/api/demo": { target: backend, changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        live: fileURLToPath(new URL("./live.html", import.meta.url)),
      },
    },
  },
});
