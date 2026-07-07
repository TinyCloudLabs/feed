import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e/specs",
  testMatch: "**/*.pw.ts",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 120000,
  expect: { timeout: 60000 },
  use: {
    baseURL: "http://127.0.0.1:4199",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "FEED_HOST_PORT=8787 bun run host/server.ts",
      url: "http://127.0.0.1:8787/health",
      reuseExistingServer: false,
      timeout: 120000,
    },
    {
      command: "bun run dev:vite --host 127.0.0.1 --port 4199",
      url: "http://127.0.0.1:4199",
      reuseExistingServer: false,
      timeout: 120000,
      env: {
        ...process.env,
        VITE_FEED_HOST_URL: "http://127.0.0.1:8787",
        VITE_TINYCLOUD_HOST: "https://node.tinycloud.xyz",
      },
    },
  ],
});
