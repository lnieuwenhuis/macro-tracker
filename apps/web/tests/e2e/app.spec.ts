import { expect, test } from "@playwright/test";

test("redirects unauthenticated users to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByText("Daily macros, built for your phone."),
  ).toBeVisible();
});

test("allows an allowlisted user to track meals across days", async ({
  page,
}) => {
  await page.goto("/api/test/session?email=coach@example.com");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Signed in as coach@example.com")).toBeVisible();

  const datePicker = page.getByLabel("Pick a day");

  await datePicker.fill("2026-03-17");
  await expect(page).toHaveURL(/date=2026-03-17/);
  await page.getByRole("button", { name: "Add meal" }).click();
  const firstMealCard = page.locator("article").last();
  const firstMealName = firstMealCard.getByPlaceholder(
    "Lunch, post-workout, late snack...",
  );
  await firstMealName.fill("Lunch");
  await firstMealCard.getByLabel("Protein").fill("30");
  await firstMealCard.getByLabel("Carbs").fill("40");
  await firstMealCard.getByLabel("Fat").fill("10");
  await firstMealCard.getByLabel("Calories").fill("370");
  await firstMealCard.getByRole("button", { name: "Save meal" }).click();

  await datePicker.fill("2026-03-19");
  await expect(page).toHaveURL(/date=2026-03-19/);
  await page.getByRole("button", { name: "Add meal" }).click();
  const secondMealCard = page.locator("article").last();
  const secondMealName = secondMealCard.getByPlaceholder(
    "Lunch, post-workout, late snack...",
  );
  await secondMealName.fill("Dinner");
  await secondMealCard.getByLabel("Protein").fill("50");
  await secondMealCard.getByLabel("Carbs").fill("60");
  await secondMealCard.getByLabel("Fat").fill("20");
  await secondMealCard.getByLabel("Calories").fill("620");
  await secondMealCard.getByRole("button", { name: "Save meal" }).click();

  const dailyTotalsCard = page.locator("section").filter({ hasText: "Daily totals" }).first();
  await expect(dailyTotalsCard).toContainText("50g");
  await expect(dailyTotalsCard).toContainText("60g");
  await expect(dailyTotalsCard).toContainText("20g");
  await expect(dailyTotalsCard).toContainText("620 kcal");

  const rolling7Card = page
    .locator("section")
    .filter({ hasText: "Rolling 7 days" })
    .first();
  await expect(rolling7Card).toContainText("2 logged days");
});

test("blocks non-allowlisted test logins", async ({ request }) => {
  const response = await request.post("/api/test/session", {
    data: { email: "stranger@example.com" },
  });

  expect(response.status()).toBe(403);
});
