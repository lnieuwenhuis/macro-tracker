import { expect, test, type Page } from "@playwright/test";

async function enableExperimentalUi(page: Page) {
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("switch", { name: /Experimental UI/i }).click();
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();
}

test("users can switch between legacy and experimental ui modes", async ({ page }) => {
  await page.goto("/api/test/session?email=coach@example.com");
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();

  await enableExperimentalUi(page);

  await expect(page.getByRole("link", { name: "Food Log" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Progress" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add food" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Recipes" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Summary" })).toBeVisible();
  await expect(page.getByText("Your Records")).toHaveCount(0);

  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByText("Theme", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await page.getByRole("switch", { name: /Experimental UI/i }).click();

  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
});

test("experimental mode supports the bottom add flow and merged progress routes", async ({
  page,
}) => {
  await page.goto("/api/test/session?email=user@example.com");
  await enableExperimentalUi(page);

  await page.goto("/summary?date=2026-03-19");
  await expect(page.getByRole("link", { name: "Summary" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByLabel("Pick a day")).toHaveCount(0);
  await expect(page.getByText("Daily Snapshot")).toHaveCount(0);
  await expect(page.getByText("Last 7 Days")).toBeVisible();

  await page.getByRole("button", { name: "Add food" }).click();
  await expect(page.getByRole("button", { name: "Custom" })).toBeVisible();
  await page.getByRole("button", { name: "Custom" }).click();

  await expect(page).toHaveURL(/\/\?date=2026-03-19$/);
  const mealCard = page.locator("article").last();
  await expect(mealCard.getByRole("button", { name: "Save" })).toBeVisible();

  await page.getByRole("link", { name: "Progress" }).click();
  await expect(page).toHaveURL(/\/progress\?date=2026-03-19&tab=goals/);
  await expect(page.getByText("Daily Goals")).toBeVisible();

  await page.getByRole("tab", { name: "Weight" }).click();
  await expect(page).toHaveURL(/\/progress\?date=2026-03-19&tab=weight/);
  await expect(page.getByText("Log Weight")).toBeVisible();

  await page.goto("/weight?date=2026-03-19");
  await expect(page).toHaveURL(/\/progress\?date=2026-03-19&tab=weight/);

  await page.goto("/stats?date=2026-03-19");
  await expect(page).toHaveURL(/\/summary\?date=2026-03-19/);
});
