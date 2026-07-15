import { defineConfig, devices } from "@playwright/test";

// Smoke ports are overridable so the suite can run beside live dev services
// (which usually hold 8787/5173): FEED_SMOKE_HOST_PORT / FEED_SMOKE_WEB_PORT.
const HOST_PORT = process.env.FEED_SMOKE_HOST_PORT ?? "8787";
const WEB_PORT = process.env.FEED_SMOKE_WEB_PORT ?? "4199";

export default defineConfig({
  testDir: "e2e/specs",
  testMatch: "**/*.pw.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 360000,
  expect: { timeout: 180000 },
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    // This suite uses a real TinyCloud authority. Playwright traces retain
    // request headers/bodies (delegations and actor cookies), and screenshots
    // can retain private Feed content, so neither is safe as a CI artifact.
    trace: "off",
    screenshot: "off",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: `FEED_HOST_PORT=${HOST_PORT} bun run host/server.ts`,
      url: `http://127.0.0.1:${HOST_PORT}/health`,
      reuseExistingServer: false,
      timeout: 120000,
      env: {
        ...process.env,
        FEED_HOST_ALLOWED_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
      },
    },
    {
      command: `bun run dev:vite --host 127.0.0.1 --port ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120000,
      env: {
        ...process.env,
        VITE_FEED_HOST_URL: `http://127.0.0.1:${HOST_PORT}`,
        VITE_TINYCLOUD_HOST: process.env.VITE_TINYCLOUD_HOST ?? "https://node.tinycloud.xyz",
        // The smoke host always runs current code, so keep the traced-request
        // path exercised here even though production defaults it off.
        VITE_FEED_TRACE_HEADER: "1",
      },
    },
  ],
});
