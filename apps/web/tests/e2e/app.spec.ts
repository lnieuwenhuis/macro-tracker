import { expect, test, type Page } from "@playwright/test";

import { createTestSession, testRouteHeaders, uniqueTestEmail } from "./test-users";

async function startCustomFoodDraft(page: Page) {
  const addCustomButton = page.getByRole("button", { name: "Add custom" });

  if (await addCustomButton.isVisible()) {
    await addCustomButton.click();
    return;
  }

  await page.getByRole("button", { name: "Add food" }).click();
  await page.getByRole("button", { name: /^Custom\b/ }).click();
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
  const unsavedCards = page.locator("article").filter({
    has: page.getByRole("button", { name: "Save" }),
  });
  const unsavedBefore = await unsavedCards.count();
  await startCustomFoodDraft(page);

  await expect(unsavedCards).toHaveCount(unsavedBefore + 1);
  const mealCard = unsavedCards.last();
  const mealName = mealCard.getByPlaceholder("Chicken breast, rice, banana...");

  await expect(mealName).toBeVisible();
  await mealName.fill(input.label);
  await mealCard.getByLabel("Protein").fill(input.proteinG);
  await mealCard.getByLabel("Carbs").fill(input.carbsG);
  await mealCard.getByLabel("Fat").fill(input.fatG);
  await mealCard.getByLabel("Calories").fill(input.caloriesKcal);
  await mealCard.getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByRole("heading", { name: input.label }).last(),
  ).toBeVisible();
  await expect(unsavedCards).toHaveCount(unsavedBefore);
}

type DayTemplateSeedItem = {
  label: string;
  mealGroupLabel?: string;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
};

async function seedDayTemplate(
  page: Page,
  input: { label: string; items: DayTemplateSeedItem[] },
) {
  const seedResult = await page.evaluate(
    async ({ headers, input }) => {
      const response = await fetch("/api/test/templates", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          type: "day",
          label: input.label,
          items: input.items,
        }),
      });
      return { ok: response.ok, status: response.status };
    },
    { headers: testRouteHeaders(), input },
  );

  expect(seedResult).toEqual({ ok: true, status: 200 });
}

async function applyDayTemplate(page: Page, input: { date: string; label: string }) {
  await page.goto(`/?date=${input.date}`);
  await page.getByRole("button", { name: "From template" }).click();
  const modal = page.getByRole("dialog", { name: "Meal Templates" });
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: /Days/ }).click();
  await expect(modal.getByText(input.label)).toBeVisible();
  const templateRow = modal
    .getByText(input.label)
    .locator("xpath=ancestor::div[contains(@class,'flex items-center gap-2')][1]");
  await templateRow.getByRole("button", { name: "Add" }).click();
  await expect(modal).toBeHidden();
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
}, testInfo) => {
  await createTestSession(page, uniqueTestEmail("coach", testInfo));
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();

  const datePicker = page.getByLabel("Pick a day").first();
  await expect(page.getByLabel("Pick a day")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Pick a day" })).toHaveCount(0);
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
  await expect(
    page.getByRole("heading", { name: "Last 7 Days" }),
  ).toBeVisible();
  await expect(page.locator("body")).toContainText(/13 Mar to 19 Mar .* 2 days/);
});

test("blocks non-allowlisted test logins", async ({ request }) => {
  const response = await request.post("/api/test/session", {
    headers: testRouteHeaders(),
    data: { email: "stranger@example.com" },
  });

  expect(response.status()).toBe(403);
});

test("new users can calculate daily goals during setup", async ({ page }, testInfo) => {
  await createTestSession(page, uniqueTestEmail("setup", testInfo), {
    onboarded: false,
  });
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(
    page.getByRole("heading", { name: "Set up your tracker" }),
  ).toBeVisible();

  await expect(page.getByRole("heading", { name: "Macro calculator" })).toBeVisible();
  await page.getByRole("spinbutton", { name: "Age yrs" }).fill("30");
  await page.getByRole("spinbutton", { name: "Height cm" }).fill("180");
  await page.getByRole("spinbutton", { name: "Weight kg" }).fill("80");
  await page.getByRole("button", { name: /Moderate cut/ }).click();
  await page.getByRole("button", { name: "Apply to daily goals" }).click();

  const dailyGoals = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Daily goals" }),
  });
  await expect(dailyGoals.getByRole("spinbutton", { name: "Calories kcal" })).toHaveValue("2259");
  await expect(dailyGoals.getByRole("spinbutton", { name: "Protein g" })).toHaveValue("144");
  await expect(dailyGoals.getByRole("spinbutton", { name: "Carbs g" })).toHaveValue("210.4");
  await expect(dailyGoals.getByRole("spinbutton", { name: "Fat g" })).toHaveValue("93.5");

  await page.getByRole("button", { name: "Start tracking" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();
});

test("fresh users see the current dashboard empty states", async ({
  page,
}, testInfo) => {
  await createTestSession(page, uniqueTestEmail("user", testInfo));
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "Daily Report" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Quick Add" }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Log some foods or add templates to see suggestions here.").first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Add custom" })).toBeVisible();
});

test("recent foods appear in quick add and create a prefilled draft", async ({
  page,
}, testInfo) => {
  const label = `Quick Add Item ${Date.now()}`;

  await createTestSession(page, uniqueTestEmail("user", testInfo));
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();

  await page.goto("/?date=2026-03-17");

  await addCustomFood(page, {
    label,
    proteinG: "24",
    carbsG: "18",
    fatG: "7",
    caloriesKcal: "231",
  });

  await page.goto("/?date=2026-03-18");

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

test("applies a saved day template as collapsed planned entries", async ({
  page,
}, testInfo) => {
  const suffix = Date.now();
  const firstItem = `Template oats ${suffix}`;
  const secondItem = `Template yogurt ${suffix}`;
  const templateLabel = `Two item day ${suffix}`;

  await createTestSession(page, uniqueTestEmail("user", testInfo));
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();
  await seedDayTemplate(page, {
    label: templateLabel,
    items: [
      {
        label: firstItem,
        mealGroupLabel: "Breakfast",
        proteinG: 20,
        carbsG: 40,
        fatG: 8,
        caloriesKcal: 312,
      },
      {
        label: secondItem,
        mealGroupLabel: "Lunch",
        proteinG: 25,
        carbsG: 12,
        fatG: 2,
        caloriesKcal: 166,
      },
    ],
  });
  await applyDayTemplate(page, { date: "2026-04-02", label: templateLabel });
  const firstCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: firstItem }),
  });
  const secondCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: secondItem }),
  });

  await expect(firstCard).toBeVisible();
  await expect(secondCard).toBeVisible();
  await expect(firstCard).toContainText("planned");
  await expect(secondCard).toContainText("planned");
  await expect(firstCard.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(secondCard.getByRole("button", { name: "Save" })).toHaveCount(0);

  const dailyReport = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Daily Report" }),
  }).first();
  await expect(dailyReport).toContainText("Projected 478 kcal");
  await expect(dailyReport).toContainText(/Planned\s*478 kcal/);
  await expect(dailyReport.getByTestId("macro-bar-calories-planned-fill")).toHaveCSS("opacity", "0.28");
  await expect(dailyReport.getByTestId("macro-bar-protein-planned-fill")).toHaveCSS("opacity", "0.28");
  await expect(dailyReport.getByTestId("macro-bar-carbs-planned-fill")).toHaveCSS("opacity", "0.28");
  await expect(dailyReport.getByTestId("macro-bar-fat-planned-fill")).toHaveCSS("opacity", "0.28");
});

test("planner shopping mode copies planned items for the selected range", async ({
  page,
}, testInfo) => {
  const suffix = Date.now();
  const firstItem = `Shopping oats ${suffix}`;
  const secondItem = `Shopping yogurt ${suffix}`;
  const templateLabel = `Shopping day ${suffix}`;
  const plannedDate = "2026-04-09";

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await createTestSession(page, uniqueTestEmail("user", testInfo));
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();
  await seedDayTemplate(page, {
    label: templateLabel,
    items: [
      {
        label: firstItem,
        mealGroupLabel: "Breakfast",
        proteinG: 20,
        carbsG: 40,
        fatG: 8,
        caloriesKcal: 312,
      },
      {
        label: secondItem,
        mealGroupLabel: "Lunch",
        proteinG: 25,
        carbsG: 12,
        fatG: 2,
        caloriesKcal: 166,
      },
    ],
  });
  await applyDayTemplate(page, { date: plannedDate, label: templateLabel });

  await page.goto(`/planner?date=${plannedDate}`);
  await page.getByRole("tab", { name: "Shopping" }).click();
  await expect(page.getByRole("heading", { name: "Shopping List" })).toBeVisible();
  await expect(page.getByText(firstItem)).toBeVisible();
  await expect(page.getByText(secondItem)).toBeVisible();

  await page.getByRole("button", { name: "Copy list" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboardText).toContain(firstItem);
  expect(clipboardText).toContain(secondItem);
});

test("stats and weight pages load without day navigation chrome", async ({
  page,
}, testInfo) => {
  await createTestSession(page, uniqueTestEmail("coach", testInfo));
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();

  await page.goto("/stats?date=2026-03-19");
  await expect(page).toHaveURL(/\/summary\?date=2026-03-19/);
  await expect(
    page.getByRole("heading", { name: "Macro Trends", exact: true }),
  ).toBeVisible();
  await expect(page.locator("body")).toContainText(/No stats yet|Overview/);
  await expect(page.getByRole("button", { name: "Previous day" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next day" })).toHaveCount(0);
  await expect(page.getByLabel("Pick a day")).toHaveCount(0);

  await page.goto("/weight?date=2026-03-19");
  await expect(page).toHaveURL(/\/progress\?date=2026-03-19&tab=weight/);
  await expect(
    page.getByRole("heading", { name: "Log Weight" }).first(),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous day" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Next day" })).toHaveCount(0);
  await expect(page.getByLabel("Pick a day")).toHaveCount(0);
});

test("macro trend chart shows planned intake as a translucent projection", async ({
  page,
}, testInfo) => {
  const suffix = Date.now();
  const eatenLabel = `Projected lunch ${suffix}`;
  const plannedLabel = `Projected dinner ${suffix}`;
  const templateLabel = `Projected day ${suffix}`;
  const plannedDate = "2026-07-04";

  await createTestSession(page, uniqueTestEmail("user", testInfo));
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();
  await seedDayTemplate(page, {
    label: templateLabel,
    items: [
      {
        label: eatenLabel,
        proteinG: 30,
        carbsG: 40,
        fatG: 10,
        caloriesKcal: 370,
      },
      {
        label: plannedLabel,
        proteinG: 25,
        carbsG: 50,
        fatG: 15,
        caloriesKcal: 435,
      },
    ],
  });
  await applyDayTemplate(page, { date: plannedDate, label: templateLabel });

  const eatenCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: eatenLabel }),
  });
  const plannedCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: plannedLabel }),
  });
  await expect(eatenCard).toContainText("planned");
  await expect(plannedCard).toContainText("planned");
  await Promise.all([
    page.waitForResponse((response) => {
      const request = response.request();
      return (
        request.method() === "POST" &&
        response.url().includes(`date=${plannedDate}`) &&
        response.status() < 400
      );
    }),
    eatenCard.getByRole("button", { name: "Mark eaten", exact: true }).click(),
  ]);
  await expect(eatenCard).toContainText("eaten");
  await expect(plannedCard).toContainText("planned");

  await page.goto(`/summary?date=${plannedDate}`);
  const trendSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Calories Trend" }),
  }).last();

  await expect(trendSection).toContainText("Projected 4 Jul:");
  await expect(trendSection).toContainText("805 kcal");
  await expect(trendSection).toContainText("370 eaten + 435 planned");
  expect(await trendSection.locator('svg rect[opacity="0.28"]').count()).toBeGreaterThan(0);
});

test("weight goal validation errors stay visible on the page", async ({
  page,
}, testInfo) => {
  await createTestSession(page, uniqueTestEmail("user", testInfo));
  await page.goto("/weight?date=2026-03-19");

  await expect(
    page.getByRole("heading", { name: "Log Weight" }).first(),
  ).toBeVisible();
  await page.locator("#weight-entry-form").getByRole("spinbutton", { name: "Weight (kg)" }).fill("82.5");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.getByLabel("Target (kg)").first()).toBeVisible();

  await page.getByLabel("Target (kg)").first().fill("0");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect(
    page.getByText("Enter a valid goal weight."),
  ).toBeVisible();
});

test("weight entries can be edited from the progress weight tab", async ({
  page,
}, testInfo) => {
  await createTestSession(page, uniqueTestEmail("user", testInfo));
  await page.goto("/weight?date=2026-03-19");
  await expect(page).toHaveURL(/\/progress\?date=2026-03-19&tab=weight/);
  await expect(
    page.getByRole("heading", { name: "Log Weight" }).first(),
  ).toBeVisible();

  const entryForm = page.locator("#weight-entry-form");
  const weightInput = entryForm.getByRole("spinbutton", { name: "Weight (kg)" });
  const bodyFatInput = entryForm.getByRole("spinbutton", { name: "Body fat %" });
  const notesInput = entryForm.getByRole("textbox", { name: "Notes" });

  await weightInput.fill("82.5");
  await bodyFatInput.fill("18.4");
  await notesInput.fill("Morning");
  await expect(weightInput).toHaveValue("82.5");
  await expect(bodyFatInput).toHaveValue("18.4");
  await expect(notesInput).toHaveValue("Morning");
  await entryForm.getByRole("button", { name: "Save entry" }).click();
  await expect(page.getByText(/Morning/)).toBeVisible();

  await page.getByRole("button", { name: /Edit entry from/ }).click();
  await expect(
    page.getByRole("heading", { name: "Edit Entry" }),
  ).toBeVisible();
  await weightInput.fill("81.9");
  await bodyFatInput.fill("18.1");
  await notesInput.fill("After workout");
  await expect(weightInput).toHaveValue("81.9");
  await expect(bodyFatInput).toHaveValue("18.1");
  await expect(notesInput).toHaveValue("After workout");
  await entryForm.getByRole("button", { name: "Update entry" }).click();

  await expect(page.getByText("81.9 kg").first()).toBeVisible();
  await expect(page.getByText("18.1% bf")).toBeVisible();
  await expect(page.getByText(/After workout/)).toBeVisible();
  await expect(page.getByText("82.5 kg")).toHaveCount(0);
});
