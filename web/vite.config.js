import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Single-source the version from the ROOT package.json and stamp a build time, so the UI
// can show exactly which build is running (helps spot a stale packaged app).
const rootPkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

// Dev server proxies /api to the backend so the browser only ever talks to one origin.
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        // SSE needs buffering disabled; Vite/http-proxy streams fine by default.
      },
    },
  },
  build: { outDir: "dist" },
});
