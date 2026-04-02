import { defineConfig, devices } from "@playwright/test";

const appUrl = "http://localhost:3000";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: appUrl,
    trace: "on-first-retry",
    ...devices["Pixel 7"],
  },
  webServer: {
    command: "pnpm dev --port 3000",
    url: appUrl,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: "memory:",
      APP_URL: appUrl,
      SESSION_SECRET: "test-secret",
      ENABLE_TEST_ROUTES: "true",
      SHOO_BASE_URL: "https://shoo.dev",
    },
  },
});
