import { expect, test, type Page } from "@playwright/test";

import { createTestSession, uniqueTestEmail, waitForAppReady } from "./test-users";

/**
 * TEST-03: `app/recipes/new`, `app/recipes/[id]/edit` and
 * `recipe-builder-shell.tsx` used to be reachable only through an `href`
 * assertion and a source-text check -- nothing built a recipe, edited its
 * ingredients, or verified macro scaling through the UI. That coverage hole
 * is what let DATA-04 (a double-tap on "Log..." writing two identical meal
 * entries) ship.
 */

async function buildRecipe(
  page: Page,
  input: {
    date: string;
    label: string;
    portions: string;
    ingredientLabel: string;
    proteinG: string;
    carbsG: string;
    fatG: string;
    caloriesKcal: string;
  },
) {
  await page.goto(`/recipes/new?date=${input.date}`);
  await waitForAppReady(page);
  await expect(page.getByRole("heading", { name: "Ingredients" })).toBeVisible();

  await page.getByLabel("Recipe Name").fill(input.label);
  await page.getByLabel("Portions").fill(input.portions);

  await page.getByRole("button", { name: "Add custom" }).click();
  const ingredientCard = page.locator("article").filter({
    has: page.getByPlaceholder("Chicken breast, rice..."),
  });
  await expect(ingredientCard).toBeVisible();
  await ingredientCard.getByPlaceholder("Chicken breast, rice...").fill(input.ingredientLabel);
  await ingredientCard.getByLabel("Protein").fill(input.proteinG);
  await ingredientCard.getByLabel("Carbs").fill(input.carbsG);
  await ingredientCard.getByLabel("Fat").fill(input.fatG);
  await ingredientCard.getByLabel("Calories").fill(input.caloriesKcal);

  await page.getByRole("button", { name: "Save Recipe" }).click();
  await expect(page).toHaveURL(new RegExp(`/recipes\\?date=${input.date}`));
}

test("builds a recipe, logs a portion, and the logged entry reflects the scaled macros", async ({
  page,
}, testInfo) => {
  const suffix = Date.now();
  const recipeLabel = `E2E Recipe ${suffix}`;
  const date = "2026-05-11";

  await createTestSession(page, uniqueTestEmail("user", testInfo));

  // One ingredient, 2 portions: per-portion macros are exactly half the
  // ingredient's totals -- 20/40/10/300 -> 10/20/5/150 per portion.
  await buildRecipe(page, {
    date,
    label: recipeLabel,
    portions: "2",
    ingredientLabel: "Chicken and rice bowl",
    proteinG: "20",
    carbsG: "40",
    fatG: "10",
    caloriesKcal: "300",
  });

  const recipeCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: recipeLabel }),
  });
  await expect(recipeCard).toBeVisible();
  // Collapsed header already shows the per-portion macros.
  await expect(recipeCard).toContainText("P 10g");
  await expect(recipeCard).toContainText("C 20g");
  await expect(recipeCard).toContainText("F 5g");
  await expect(recipeCard).toContainText("150 kcal");

  await recipeCard.click();
  await expect(recipeCard.getByText("Total Recipe")).toBeVisible();
  // The unscaled recipe total is the raw ingredient values.
  const totalsSection = recipeCard.getByText("Total Recipe").locator("..");
  await expect(totalsSection).toContainText("P 20g");
  await expect(totalsSection).toContainText("C 40g");
  await expect(totalsSection).toContainText("F 10g");
  await expect(totalsSection).toContainText("300 kcal");

  // Log exactly 1 portion (the default) for today's log.
  await recipeCard.getByRole("button", { name: /^Log/ }).click();
  await expect(recipeCard.getByRole("button", { name: /^Log/ })).toBeVisible();

  await page.goto(`/?date=${date}`);
  await waitForAppReady(page);
  const loggedCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: `${recipeLabel} (1 portion)` }),
  });
  await expect(loggedCard).toBeVisible();
  await expect(loggedCard).toContainText("P 10g");
  await expect(loggedCard).toContainText("C 20g");
  await expect(loggedCard).toContainText("F 5g");
  await expect(loggedCard).toContainText("150 kcal");
});

test("DATA-04: logging a recipe portion twice in rapid succession only creates one entry", async ({
  page,
}, testInfo) => {
  const suffix = Date.now();
  const recipeLabel = `E2E Double Tap Recipe ${suffix}`;
  const date = "2026-05-12";

  await createTestSession(page, uniqueTestEmail("user", testInfo));

  await buildRecipe(page, {
    date,
    label: recipeLabel,
    portions: "1",
    ingredientLabel: "Overnight oats",
    proteinG: "15",
    carbsG: "45",
    fatG: "8",
    caloriesKcal: "320",
  });

  const recipeCard = page.locator("article").filter({
    has: page.getByRole("heading", { name: recipeLabel }),
  });
  await recipeCard.click();

  const logButton = recipeCard.getByRole("button", { name: /^Log/ });
  await expect(logButton).toBeVisible();

  // A real double-tap dispatches two click events before React's `isPending`
  // state has a chance to re-render the button as disabled. `fireEvent`-style
  // sequential `.click()` calls from within the page (rather than two
  // separately-awaited Playwright `.click()` calls) reproduce that race:
  // both are dispatched synchronously in the same task, before either
  // `handleLogPortion` call's state update commits.
  await logButton.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  // Let both in-flight requests settle before navigating away and counting.
  await page.waitForTimeout(1000);

  await page.goto(`/?date=${date}`);
  await waitForAppReady(page);
  const loggedCards = page.locator("article").filter({
    has: page.getByRole("heading", { name: `${recipeLabel} (1 portion)` }),
  });
  // The clientMutationId fix (DATA-04) collapses the duplicate at the
  // backend's unique index; a regression here writes two identical entries.
  await expect(loggedCards).toHaveCount(1);
  await expect(loggedCards).toContainText("P 15g");
  await expect(loggedCards).toContainText("C 45g");
  await expect(loggedCards).toContainText("F 8g");
  await expect(loggedCards).toContainText("320 kcal");
});
