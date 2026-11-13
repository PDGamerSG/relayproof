import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths, so the build works from any sub-path (GitHub Pages, a docs folder).
  base: "./",
  server: { port: 5273, strictPort: true },
});
