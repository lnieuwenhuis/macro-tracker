import { expect, test, type Page } from "@playwright/test";

async function startCustomFoodDraft(page: Page) {
  const addCustomButton = page.getByRole("button", { name: "Add custom" });

  if (await addCustomButton.isVisible()) {
    await addCustomButton.click();
    return;
  }

  await page.getByRole("button", { name: "Add food" }).click();
  await page.getByRole("button", { name: "Custom" }).click();
}

async function addCustomFood(
  page: Page,
  input: {
    label: string;
    proteinG: string;
    carbsG: string;
    fatG: string;
    caloriesKcal: string;
  },
) {
  await startCustomFoodDraft(page);

  const mealCard = page.locator("article").last();
  const mealName = mealCard.getByPlaceholder("Chicken breast, rice, banana...");

  await expect(mealName).toBeVisible();
  await mealName.fill(input.label);
  await mealCard.getByLabel("Protein").fill(input.proteinG);
  await mealCard.getByLabel("Carbs").fill(input.carbsG);
  await mealCard.getByLabel("Fat").fill(input.fatG);
  await mealCard.getByLabel("Calories").fill(input.caloriesKcal);
  await mealCard.getByRole("button", { name: "Save" }).click();
  await expect(mealCard.getByRole("button", { name: "Expand", exact: true })).toBeVisible();
}

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
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();

  const datePicker = page.getByLabel("Pick a day");
  const currentBrowserDate = await page.evaluate(() => {
    const value = new Date();
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");

    return `${year}-${month}-${day}`;
  });

  await expect(datePicker).toHaveValue(currentBrowserDate);

  await datePicker.fill("2026-03-17");
  await expect(page).toHaveURL(/date=2026-03-17/);
  await addCustomFood(page, {
    label: "Greek yogurt",
    proteinG: "30",
    carbsG: "40",
    fatG: "10",
    caloriesKcal: "370",
  });

  await datePicker.fill("2026-03-19");
  await expect(page).toHaveURL(/date=2026-03-19/);
  await addCustomFood(page, {
    label: "Chicken breast",
    proteinG: "50",
    carbsG: "60",
    fatG: "20",
    caloriesKcal: "620",
  });

  const dailyTotalsCard = page.locator("section").filter({ hasText: "Daily Report" }).first();
  await expect(dailyTotalsCard).toContainText("50g");
  await expect(dailyTotalsCard).toContainText("60g");
  await expect(dailyTotalsCard).toContainText("20g");
  await expect(dailyTotalsCard).toContainText("620 kcal");

  await page.goto("/summary?date=2026-03-19");
  const rolling7Card = page
    .locator("section")
    .filter({ hasText: "Rolling 7 days" })
    .first();
  await expect(rolling7Card).toContainText("2 days");
});

test("blocks non-allowlisted test logins", async ({ request }) => {
  const response = await request.post("/api/test/session", {
    data: { email: "stranger@example.com" },
  });

  expect(response.status()).toBe(403);
});

test("fresh users see the current dashboard empty states", async ({
  page,
}) => {
  await page.goto("/api/test/session?email=user@example.com");
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();

  await expect(page.getByText("Daily Report")).toBeVisible();
  await expect(page.getByText("Quick Add")).toBeVisible();
  await expect(
    page.getByText("Log some foods or add presets to see suggestions here."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Add custom" })).toBeVisible();
});

test("recent foods appear in quick add and create a prefilled draft", async ({
  page,
}) => {
  const label = `Quick Add Item ${Date.now()}`;

  await page.goto("/api/test/session?email=user@example.com");
  await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();

  const datePicker = page.getByLabel("Pick a day");
  await datePicker.fill("2026-03-17");
  await expect(page).toHaveURL(/date=2026-03-17/);

  await addCustomFood(page, {
    label,
    proteinG: "24",
    carbsG: "18",
    fatG: "7",
    caloriesKcal: "231",
  });

  await datePicker.fill("2026-03-18");
  await expect(page).toHaveURL(/date=2026-03-18/);

  const quickAddCard = page.getByRole("button", { name: `Quick add ${label}` });
  await expect(quickAddCard).toBeVisible();

  const articlesBefore = await page.locator("article").count();
  await quickAddCard.click();

  const draftCard = page.locator("article").last();
  await expect(draftCard.getByText(label)).toBeVisible();
  await expect(draftCard.getByRole("button", { name: "Save" })).toBeVisible();

  const articlesAfter = await page.locator("article").count();
  expect(articlesAfter).toBeGreaterThan(articlesBefore);
});
