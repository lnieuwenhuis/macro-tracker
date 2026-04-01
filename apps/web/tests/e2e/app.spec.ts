import { expect, test } from "@playwright/test";

test("redirects unauthenticated users to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByText("Daily macros, built for your phone."),
  ).toBeVisible();
});

test("allows an allowlisted user to track food items across days", async ({
  page,
}) => {
  await page.goto("/api/test/session?email=coach@example.com");
  await expect(page.getByText("Signed in as coach@example.com")).toBeVisible();

  const datePicker = page.getByLabel("Pick a day");
  const currentBrowserDate = await page.evaluate(() => {
    const value = new Date();
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
  });

  await expect(page).toHaveURL(new RegExp(`\\?date=${currentBrowserDate}$`));
  await expect(datePicker).toHaveValue(currentBrowserDate);

  await datePicker.fill("2026-03-17");
  await expect(page).toHaveURL(/date=2026-03-17/);
  await page.getByRole("button", { name: "Add food" }).click();
  const firstMealCard = page.locator("article").last();
  const firstMealName = firstMealCard.getByPlaceholder(
    "500g quark, banana, oats, chicken breast...",
  );
  await firstMealName.fill("Greek yogurt");
  await firstMealCard.getByLabel("Protein").fill("30");
  await firstMealCard.getByLabel("Carbs").fill("40");
  await firstMealCard.getByLabel("Fat").fill("10");
  await firstMealCard.getByLabel("Calories").fill("370");
  await firstMealCard.getByRole("button", { name: "Save food" }).click();

  await datePicker.fill("2026-03-19");
  await expect(page).toHaveURL(/date=2026-03-19/);
  await page.getByRole("button", { name: "Add food" }).click();
  const secondMealCard = page.locator("article").last();
  const secondMealName = secondMealCard.getByPlaceholder(
    "500g quark, banana, oats, chicken breast...",
  );
  await secondMealName.fill("Chicken breast");
  await secondMealCard.getByLabel("Protein").fill("50");
  await secondMealCard.getByLabel("Carbs").fill("60");
  await secondMealCard.getByLabel("Fat").fill("20");
  await secondMealCard.getByLabel("Calories").fill("620");
  await secondMealCard.getByRole("button", { name: "Save food" }).click();

  const dailyTotalsCard = page.locator("section").filter({ hasText: "Daily totals" }).first();
  await expect(dailyTotalsCard).toContainText("50g");
  await expect(dailyTotalsCard).toContainText("60g");
  await expect(dailyTotalsCard).toContainText("20g");
  await expect(dailyTotalsCard).toContainText("620 kcal");

  await page.goto("/summary?date=2026-03-19");
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
