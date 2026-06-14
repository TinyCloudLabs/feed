import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Pure-client viewer: no server, no /api proxy. `web/` is the app root; the
// build emits a static bundle to `dist/` that talks to TinyCloud directly via
// the browser web-SDK.
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
