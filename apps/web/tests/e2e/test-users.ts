import type { Page, TestInfo } from "@playwright/test";

type TestUserBase = "coach" | "owner" | "admin" | "user" | "setup";

const TEST_ROUTE_SECRET_HEADER = "x-test-route-secret";

function getTestRouteSecret() {
  const testRouteSecret = process.env.TEST_ROUTES_SECRET;

  if (!testRouteSecret) {
    throw new Error("TEST_ROUTES_SECRET is required for Playwright test routes.");
  }

  return testRouteSecret;
}

export function testRouteHeaders() {
  return {
    [TEST_ROUTE_SECRET_HEADER]: getTestRouteSecret(),
  };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export function uniqueTestEmail(base: TestUserBase, testInfo: TestInfo) {
  const slug = slugify(testInfo.title);
  return `${base}+w${testInfo.workerIndex}-r${testInfo.retry}-l${testInfo.line}-${slug}@example.com`;
}

/**
 * Waits until React has hydrated the app shell and attached its event
 * listeners (`AppShell` sets this attribute in a mount effect). Interacting
 * before that point races hydration: on slow CI runners a `fill()` on the
 * controlled date picker was silently reverted to the server-rendered value
 * and button clicks were dropped. Call this after any full page load of an
 * app-shell screen and before the first interaction.
 */
export async function waitForAppReady(page: Page) {
  await page.waitForSelector("html[data-app-hydrated]", { state: "attached" });
}

export async function createTestSession(
  page: Page,
  email: string,
  options?: {
    onboarded?: boolean;
  },
) {
  const params = new URLSearchParams({ email });

  if (options?.onboarded === false) {
    params.set("onboarded", "false");
  }

  await page.setExtraHTTPHeaders(testRouteHeaders());
  await page.goto(`/api/test/session?${params.toString()}`);

  // Not-onboarded sessions land on /onboarding, which renders no AppShell
  // and therefore never sets the hydration beacon.
  if (options?.onboarded !== false) {
    await waitForAppReady(page);
  }
}
