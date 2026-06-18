import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));

// Pure-client viewer: no server, no /api proxy. `web/` is the app root; the
// build emits a static bundle to `dist/` that talks to TinyCloud directly via
// the browser web-SDK.
export default defineConfig({
  root: "web",
  envDir: repoRoot,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
