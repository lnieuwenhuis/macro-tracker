import { expect, test, type Browser, type Page } from "@playwright/test";

import { createTestSession, uniqueTestEmail, waitForAppReady } from "./test-users";

async function newSessionPage(browser: Browser, email: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await createTestSession(page, email);
  return { context, page };
}

async function createOneOffSlot(
  page: Page,
  input: { date: string; from: string; until: string; title?: string },
) {
  await page.getByRole("button", { name: "Add slot" }).click();
  const modal = page.getByRole("dialog", { name: "Add gym slot" });
  await expect(modal).toBeVisible();
  if (input.title) {
    await modal.getByLabel(/Title/).fill(input.title);
  }
  await modal.getByRole("button", { name: "One day" }).click();
  await modal.getByLabel("Date").fill(input.date);
  await modal.getByLabel("From").fill(input.from);
  await modal.getByLabel("Until").fill(input.until);
  await modal.getByRole("button", { name: "Add slot" }).click();
  await expect(modal).toBeHidden();
}

test("the top-left gym button opens the schedule and slots can be managed", async ({
  page,
}, testInfo) => {
  // A date safely in the future: the tense-aware skip label below must read
  // "Skipping" (the slot's time has not passed yet), and the status-date
  // window rejects dates more than ~400 days out.
  await createTestSession(page, uniqueTestEmail("user", testInfo));
  await page.goto("/?date=2026-12-17");
  await waitForAppReady(page);

  // The date label is shortened so the pill fits between TWO round buttons.
  await expect(page.getByText("Thu, 17 Dec")).toBeVisible();

  const gymLink = page.getByRole("link", { name: "Open gym schedule" });
  await expect(gymLink).toBeVisible();
  await gymLink.click();
  await expect(page).toHaveURL(/\/gym\?date=2026-12-17$/);

  // The dumbbell must NOT disappear inside the gym section: it stays in the
  // header in its active state and toggles back to the food log.
  const backLink = page.getByRole("link", { name: "Back to food log" });
  await expect(backLink).toBeVisible();

  await expect(page.getByRole("tab", { name: "Schedule" })).toBeVisible();
  await expect(page.getByText("Your slots")).toBeVisible();

  await createOneOffSlot(page, {
    date: "2026-12-17",
    from: "17:00",
    until: "18:30",
    title: "Leg day",
  });

  // The slot shows up in the day view with the default status.
  await expect(page.getByRole("button", { name: "Change status for Leg day" })).toBeVisible();
  await expect(page.getByText("17:00–18:30").first()).toBeVisible();

  // Change the day's status to skipped via the chooser; the tense-aware label
  // reads "Skipping" while the slot's end time is still ahead on that date.
  await page.getByRole("button", { name: "Change status for Leg day" }).click();
  const chooser = page.getByRole("dialog", { name: "Change slot status" });
  await expect(chooser).toBeVisible();
  await chooser.getByRole("button", { name: /Skip this day/ }).click();
  await expect(chooser).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Change status for Leg day" }),
  ).toHaveText("Skipping");
  // The slot is still there — skipping never deletes it.
  await expect(page.getByText("Leg day").first()).toBeVisible();

  // The active dumbbell returns to the food log for the same date.
  await backLink.click();
  await expect(page).toHaveURL(/\/\?date=2026-12-17$/);
  await expect(
    page.getByRole("link", { name: "Open gym schedule" }),
  ).toBeVisible();
});

test("buddies share schedules and overlapping slots surface on the home page", async ({
  browser,
}, testInfo) => {
  const aliceEmail = uniqueTestEmail("coach", testInfo);
  const bobEmail = uniqueTestEmail("user", testInfo);
  const date = "2026-10-05";

  // Bob's account must exist before Alice can invite it.
  const bob = await newSessionPage(browser, bobEmail);
  const alice = await newSessionPage(browser, aliceEmail);

  try {
    // Bob reads his static friend code from the Buddies tab.
    await bob.page.goto(`/gym?date=${date}`);
    await waitForAppReady(bob.page);
    await bob.page.getByRole("tab", { name: "Buddies" }).click();
    const bobCode = (
      await bob.page.getByTestId("gym-friend-code").innerText()
    ).trim();
    expect(bobCode).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);

    // Alice invites Bob by that code (typed sloppily — lowercase), never
    // needing his email.
    await alice.page.goto(`/gym?date=${date}`);
    await waitForAppReady(alice.page);
    await alice.page.getByRole("tab", { name: "Buddies" }).click();
    await alice.page
      .getByLabel("Buddy email address or friend code")
      .fill(bobCode.toLowerCase());
    await alice.page.getByRole("button", { name: "Invite" }).click();
    await expect(alice.page.getByText("Invite sent.")).toBeVisible();
    // The sent-invites list shows the code, not Bob's email.
    await expect(alice.page.getByText(bobCode)).toBeVisible();
    await expect(alice.page.getByText(bobEmail, { exact: true })).toHaveCount(0);

    // Bob sees the pending invite (dot on the Buddies tab) and accepts.
    await bob.page.reload();
    await bob.page.getByRole("tab", { name: "Buddies" }).click();
    await bob.page.getByRole("button", { name: "Accept" }).click();
    await expect(bob.page.getByText("No gym buddies yet")).toHaveCount(0);
    await expect(bob.page.getByRole("button", { name: "Accept" })).toHaveCount(0);

    // Both plan overlapping one-off slots (30 shared minutes: 18:00-18:30).
    await alice.page.getByRole("tab", { name: "Schedule" }).click();
    await createOneOffSlot(alice.page, {
      date,
      from: "17:00",
      until: "18:30",
    });
    await bob.page.getByRole("tab", { name: "Schedule" }).click();
    await createOneOffSlot(bob.page, { date, from: "18:00", until: "19:00" });

    // The overlap is highlighted on Alice's home page for that day.
    await alice.page.goto(`/?date=${date}`);
    await waitForAppReady(alice.page);
    await expect(alice.page.getByText("Gym Buddies")).toBeVisible();
    await expect(alice.page.getByText(/You and /)).toBeVisible();
    await expect(alice.page.getByText(/18:00–18:30/)).toBeVisible();

    // And on Bob's gym screen Alice's slot is visible without her description.
    await bob.page.goto(`/gym?date=${date}`);
    await waitForAppReady(bob.page);
    await expect(bob.page.getByText(/You and /)).toBeVisible();
  } finally {
    await alice.context.close();
    await bob.context.close();
  }
});
