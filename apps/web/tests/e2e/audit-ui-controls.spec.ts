import { expect, test, type Page } from "@playwright/test";

import { createTestSession, uniqueTestEmail, waitForAppReady } from "./test-users";

// Real-browser evidence for the accepted UI-control findings whose behavior is
// browser-native and cannot be proven by jsdom: Chromium reports a typed
// incomplete exponent (`1e`) as value "" with validity.badInput, native buttons
// own Space activation, and ARIA tabs must consume arrows before the global
// day-navigation handler sees them.
const DATE = "2026-05-20";

function field(page: Page, name: RegExp) {
  return page.getByRole("spinbutton", { name });
}

async function focusIsInsideDialog(page: Page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog != null && dialog.contains(document.activeElement);
  });
}

async function addCustomFood(page: Page, label: string) {
  const addCustom = page.getByRole("button", { name: "Add custom" });
  if (await addCustom.isVisible()) {
    await addCustom.click();
  } else {
    await page.getByRole("button", { name: "Add food" }).click();
    await page.getByRole("button", { name: /^Custom\b/ }).click();
  }

  const card = page
    .locator("article")
    .filter({ has: page.getByPlaceholder("Chicken breast, rice, banana...") })
    .last();
  await card.getByPlaceholder("Chicken breast, rice, banana...").fill(label);
  await card.getByLabel("Protein").fill("20");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: label })).toBeVisible();
}

test("UI-17/UI-28: onboarding keeps 72.55 kg across unit toggles and blocks fractional calories", async ({
  page,
}, testInfo) => {
  await createTestSession(page, uniqueTestEmail("setup", testInfo), {
    onboarded: false,
  });
  await page.goto("/onboarding");

  const current = field(page, /^Current/);
  await current.fill("72.55");
  await page.getByLabel("Unit").selectOption("lb");
  await expect(current).not.toHaveValue("72.55");
  await page.getByLabel("Unit").selectOption("kg");
  await expect(current).toHaveValue("72.55");

  const calories = field(page, /^Calories/).first();
  await calories.fill("200.5");
  await page.getByRole("button", { name: "Start tracking" }).click();
  await expect(page.getByText(/whole number/i)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/onboarding");

  await calories.fill("200");
  await page.getByRole("button", { name: "Start tracking" }).click();
  await page.waitForURL((url) => url.pathname === "/");

  // The canonical 72.55 kg (not the rounded 159.9 lb display) is what persisted.
  await page.goto("/progress?tab=weight");
  await waitForAppReady(page);
  await expect(page.getByText("72.55 kg").first()).toBeVisible();

  await page.goto("/progress?tab=goals");
  await waitForAppReady(page);
  await expect(field(page, /^Calories/)).toHaveValue("200");
});

test("UI-20: goals block -5 and a typed 1e, and an explicit clear saves null", async ({
  page,
}, testInfo) => {
  await createTestSession(page, uniqueTestEmail("user", testInfo));
  await page.goto(`/progress?date=${DATE}&tab=goals`);
  await waitForAppReady(page);

  const protein = field(page, /^Protein/);
  const save = page.getByRole("button", { name: "Save goals" });

  // Clear first: Chromium normalizes typed text after existing digits
  // ("1" + "1e") into the valid scientific value "1e1" instead of badInput.
  await protein.fill("");
  await protein.pressSequentially("1e");
  await save.click();
  await expect(page.getByText(/not a valid number yet/i)).toBeVisible();

  await protein.fill("-5");
  await save.click();
  await expect(page.getByText(/positive|greater than 0/i)).toBeVisible();

  await protein.fill("72.5");
  await field(page, /^Calories/).fill("");
  await save.click();
  await expect(page.getByRole("button", { name: "Saved!" })).toBeVisible();

  await page.reload();
  await waitForAppReady(page);
  await expect(field(page, /^Protein/)).toHaveValue("72.5");
  await expect(field(page, /^Calories/)).toHaveValue("");
});

test("UI-10: tabs consume arrow keys and never trigger day navigation", async ({
  page,
}, testInfo) => {
  await createTestSession(page, uniqueTestEmail("user", testInfo));

  await page.goto(`/gym?date=${DATE}`);
  await waitForAppReady(page);
  const scheduleTab = page.getByRole("tab", { name: /Schedule/ });
  await scheduleTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Buddies/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toBeVisible();
  expect(page.url()).toContain(`date=${DATE}`);

  await page.goto(`/planner?date=${DATE}`);
  await waitForAppReady(page);
  await page.getByRole("tab", { name: /Templates/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Shopping/ })).toHaveAttribute("aria-selected", "true");
  expect(page.url()).toContain(`date=${DATE}`);

  await page.goto(`/progress?date=${DATE}&tab=goals`);
  await waitForAppReady(page);
  await page.getByRole("tab", { name: /Goals/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Weight/ })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(new RegExp(`date=${DATE}&tab=weight`));

  // /stats redirects to /summary; the macro tabs only render once a day is logged.
  await page.goto(`/?date=${DATE}`);
  await waitForAppReady(page);
  await addCustomFood(page, "UI Controls Stats food");
  await page.goto(`/summary?date=${DATE}`);
  await waitForAppReady(page);
  await page.getByRole("tab", { name: /Calories/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Protein/ })).toHaveAttribute("aria-selected", "true");
  expect(page.url()).toContain(`date=${DATE}`);
});

test("UI-06/UI-21: preset dialog traps focus and blocks a typed 1e without losing valid saves", async ({
  page,
}, testInfo) => {
  await createTestSession(page, uniqueTestEmail("user", testInfo));
  await page.goto(`/?date=${DATE}`);
  await waitForAppReady(page);

  const trigger = page.getByRole("button", { name: "From template" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Meal Templates" });
  await expect(dialog).toBeVisible();
  expect(await focusIsInsideDialog(page)).toBe(true);

  for (let index = 0; index < 15; index += 1) {
    await page.keyboard.press("Tab");
    expect(await focusIsInsideDialog(page)).toBe(true);
  }

  const name = dialog.getByPlaceholder("Chicken breast...");
  await name.fill("Browser Template");
  const protein = dialog.getByRole("spinbutton", { name: /Protein/ });
  await protein.pressSequentially("1e");
  await dialog.getByRole("button", { name: "Save template" }).click();
  await expect(dialog.getByRole("alert")).toContainText(/not a valid number yet/i);

  await protein.fill("10");
  await dialog.getByRole("button", { name: "Save template" }).click();
  await expect(dialog.getByText("Browser Template")).toBeVisible();
  await expect(dialog.getByText("P 10g")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("UI-16/UI-29: recipe portions block invalid text and the header toggles once per key", async ({
  page,
}, testInfo) => {
  await createTestSession(page, uniqueTestEmail("user", testInfo));
  await page.goto(`/recipes/new?date=${DATE}`);
  await waitForAppReady(page);

  await page.getByLabel("Recipe Name").fill("Controls Browser Recipe");
  await page.getByRole("button", { name: "Add custom" }).click();
  const ingredient = page.locator("article").filter({
    has: page.getByPlaceholder("Chicken breast, rice..."),
  });
  await ingredient.getByPlaceholder("Chicken breast, rice...").fill("Browser ingredient");
  await ingredient.getByLabel("Protein").fill("20");
  await ingredient.getByLabel("Calories").fill("300");

  const portions = page.getByLabel("Portions");
  const save = page.getByRole("button", { name: "Save Recipe" });

  await portions.fill("");
  await portions.pressSequentially("1e");
  await save.click();
  await expect(page.getByText(/not a valid number yet/i)).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/recipes/new");

  await portions.fill("-1");
  await save.click();
  await expect(page.getByText(/at least 1/i)).toBeVisible();

  await portions.fill("1.5");
  await save.click();
  await expect(page.getByText(/whole number/i)).toBeVisible();

  await portions.fill("2");
  await save.click();
  await page.waitForURL(new RegExp(`/recipes\\?date=${DATE}`));

  const card = page.locator("article").filter({
    has: page.getByRole("heading", { name: "Controls Browser Recipe" }),
  });
  const header = card.locator("button[aria-expanded]");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  expect(await header.locator("button").count()).toBe(0);

  await header.focus();
  await page.keyboard.press("Enter");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(header).toBeFocused();

  await page.keyboard.press("Space");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(header).toBeFocused();
});
