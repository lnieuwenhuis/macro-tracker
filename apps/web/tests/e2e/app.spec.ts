import { expect, test, type Page } from "@playwright/test";

async function signInAs(page: Page, email = "coach@example.com") {
  await page.goto(`/api/test/session?email=${encodeURIComponent(email)}`);
  await expect(page).toHaveURL(/\?date=/);
  await expect(page.getByRole("heading", { name: "Food Log" })).toBeVisible();
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
  await page.getByRole("button", { name: "Add food" }).click();
  await page.getByRole("button", { name: "Custom" }).click();

  const draftCard = page.locator("article").last();
  await draftCard
    .getByPlaceholder("Chicken breast, rice, banana...")
    .fill(input.label);
  await draftCard.getByLabel("Protein").fill(input.proteinG);
  await draftCard.getByLabel("Carbs").fill(input.carbsG);
  await draftCard.getByLabel("Fat").fill(input.fatG);
  await draftCard.getByLabel("Calories").fill(input.caloriesKcal);
  await draftCard.getByRole("button", { name: "Save" }).click();
}

async function saveGoals(page: Page) {
  await page.goto("/goals?date=2026-03-19");
  await page.getByLabel("Calories").fill("2200");
  await page.getByLabel("Protein").fill("180");
  await page.getByLabel("Carbs").fill("220");
  await page.getByLabel("Fat").fill("70");
  await page.getByRole("button", { name: "Save goals" }).click();
  await expect(page.getByRole("button", { name: "Saved!" })).toBeVisible();
}

test("redirects unauthenticated users to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByText("Daily macros, built for your phone."),
  ).toBeVisible();
});

test("goal-enabled users see remaining today and best fits, and quick add appends an unsaved draft", async ({
  page,
}) => {
  await signInAs(page);
  await saveGoals(page);

  await page.goto("/?date=2026-03-19");
  await addCustomFood(page, {
    label: "Quick Add Yogurt",
    proteinG: "30",
    carbsG: "20",
    fatG: "5",
    caloriesKcal: "245",
  });

  await expect(
    page.getByRole("heading", { name: "Remaining Today" }),
  ).toBeVisible();
  await expect(page.getByText("Best Fits")).toBeVisible();

  const quickAddButton = page.getByRole("button", {
    name: "Add Quick Add Yogurt",
  }).first();
  await expect(quickAddButton).toBeVisible();
  await quickAddButton.click();

  const latestDraft = page.locator("article").last();
  await expect(
    latestDraft.getByPlaceholder("Chicken breast, rice, banana..."),
  ).toHaveValue("Quick Add Yogurt");
  await expect(latestDraft.getByLabel("Protein")).toHaveValue("30");
  await expect(latestDraft.getByLabel("Carbs")).toHaveValue("20");
  await expect(latestDraft.getByLabel("Fat")).toHaveValue("5");
  await expect(latestDraft.getByLabel("Calories")).toHaveValue("245");
  await expect(latestDraft.getByRole("button", { name: "Save" })).toBeVisible();
});

test("users without goals see the quick add fallback and no best fits rail", async ({
  page,
}) => {
  await signInAs(page);

  await page.goto("/goals?date=2026-03-19");
  await page.getByRole("button", { name: "Clear all" }).click();
  await page.getByRole("button", { name: "Save goals" }).click();
  await expect(page.getByRole("button", { name: "Saved!" })).toBeVisible();

  await page.goto("/?date=2026-03-19");

  await expect(
    page.getByRole("heading", { name: "Remaining Today" }),
  ).toBeVisible();
  await expect(
    page.getByText("Set calorie or macro targets to see what is left for the day."),
  ).toBeVisible();
  await expect(
    page.getByText("Set goals to unlock Best Fits based on what is left for today."),
  ).toBeVisible();
  await expect(page.getByText("Best Fits")).not.toBeVisible();
});

test("blocks non-allowlisted test logins", async ({ request }) => {
  const response = await request.post("/api/test/session", {
    data: { email: "stranger@example.com" },
  });

  expect(response.status()).toBe(403);
});
