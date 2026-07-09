import { randomUUID } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

const appPort = process.env.PLAYWRIGHT_PORT ?? "3000";
const appUrl = `http://localhost:${appPort}`;
const testRoutesSecret = process.env.TEST_ROUTES_SECRET ?? randomUUID();
process.env.TEST_ROUTES_SECRET = testRoutesSecret;
const backendUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:4410";
const e2eDatabaseUrl =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:55432/macro_tracker";

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 30_000,
  use: {
    baseURL: appUrl,
    trace: "on-first-retry",
    extraHTTPHeaders: {
      "x-test-route-secret": testRoutesSecret,
    },
    ...devices["Pixel 7"],
  },
  webServer: {
    command: `node ./node_modules/next/dist/bin/next dev --port ${appPort}`,
    url: appUrl,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: e2eDatabaseUrl,
      BACKEND_URL: backendUrl,
      APP_URL: appUrl,
      SESSION_SECRET: "test-secret",
      ENABLE_TEST_ROUTES: "true",
      TEST_ROUTES_SECRET: testRoutesSecret,
      SHOO_BASE_URL: "https://shoo.dev",
      ADMIN_OWNER_EMAILS: "owner@example.com",
    },
  },
});
