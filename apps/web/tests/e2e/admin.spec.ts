import { expect, test, type Page, type APIRequestContext, type TestInfo } from "@playwright/test";

import { createTestSession, testRouteHeaders, uniqueTestEmail } from "./test-users";

async function openAdminUserDetail(page: Page, email: string) {
  await page.goto(`/admin/users?q=${encodeURIComponent(email)}`);
  await Promise.all([
    page.waitForURL(/\/admin\/users\/[^/?]+(?:\?.*)?$/),
    page.getByRole("link", { name: email }).click(),
  ]);
}

async function ensureAdminUser(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
) {
  const adminEmail = uniqueTestEmail("admin", testInfo);
  const ownerEmail = uniqueTestEmail("owner", testInfo);
  const createUserResponse = await request.post("/api/test/session", {
    headers: testRouteHeaders(),
    data: { email: adminEmail },
  });
  expect(createUserResponse.status()).toBe(200);

  await createTestSession(page, ownerEmail);
  await openAdminUserDetail(page, adminEmail);

  const roleSelect = page.locator('select[name="role"]');
  if ((await roleSelect.inputValue()) !== "admin") {
    await roleSelect.selectOption("admin");
    // Role changes are irreversible, so the submit button only submits on the second click.
    await page.getByRole("button", { name: "Update role" }).click();
    await page.getByRole("button", { name: "Tap again to change role" }).click();
    await page.waitForURL(/saved=role/);
    await expect(page.getByText("Role updated.")).toBeVisible();
  }

  return adminEmail;
}

test("owner bootstrap account sees the admin entry and can open /admin", async ({
  page,
}, testInfo) => {
  await createTestSession(page, uniqueTestEmail("owner", testInfo));
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByRole("link", { name: "Admin Panel" })).toBeVisible();
  await page.getByRole("link", { name: "Admin Panel" }).click();

  await expect(page).toHaveURL(/\/admin$/);
  // Scoped to the heading; Next's route announcer mirrors it and trips strict mode on bare text.
  await expect(
    page.getByRole("heading", { name: "Operations Panel" }),
  ).toBeVisible();
});

test("non-admin users do not see the admin link and get a 404 at /admin", async ({
  page,
}, testInfo) => {
  await createTestSession(page, uniqueTestEmail("user", testInfo));
  await page.getByRole("button", { name: "Open settings" }).click();
  await expect(page.getByRole("link", { name: "Admin Panel" })).toHaveCount(0);

  await page.goto("/admin");
  await expect(page.getByText("This page could not be found.")).toBeVisible();
});

test("owner can promote an admin, audit the change, and the admin is blocked from owner controls", async ({
  page,
  request,
}, testInfo) => {
  const adminEmail = await ensureAdminUser(page, request, testInfo);

  await page.goto("/admin/audit");
  await expect(page.getByText("user.role_changed")).toBeVisible();

  await createTestSession(page, adminEmail);
  await openAdminUserDetail(page, adminEmail);
  await expect(page.getByRole("button", { name: "Update role" })).toHaveCount(0);

  await page.goto("/admin/audit");
  await expect(page.getByText("This page could not be found.")).toBeVisible();
});

test("admin can edit, soft-delete, and restore barcode products", async ({
  page,
  request,
}, testInfo) => {
  const adminEmail = await ensureAdminUser(page, request, testInfo);
  await createTestSession(page, adminEmail);
  await page.goto("/admin/barcodes");

  const barcode = `99${Date.now().toString().slice(-11)}`;
  const initialName = "Admin Protein Bar";
  const updatedName = "Admin Protein Bar Deluxe";

  await page.locator('input[name="barcode"]').fill(barcode);
  await page.locator('input[name="name"]').fill(initialName);
  await page.locator('input[name="brands"]').fill("Macro Lab");
  await page.locator('input[name="servingSizeG"]').fill("60");
  await page.locator('input[name="proteinG"]').fill("30");
  await page.locator('input[name="carbsG"]').fill("20");
  await page.locator('input[name="fatG"]').fill("8");
  await page.locator('input[name="caloriesKcal"]').fill("280");
  await page.getByRole("button", { name: "Create barcode" }).click();

  await expect(page.getByText("Barcode created.")).toBeVisible();

  await page.locator('input[name="name"]').fill(updatedName);
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Barcode updated.")).toBeVisible();

  const lookupAfterUpdate = await page.evaluate(async (lookupBarcode) => {
    const response = await fetch(`/api/barcode/${lookupBarcode}`);
    return {
      status: response.status,
      body: await response.json(),
    };
  }, barcode);

  expect(lookupAfterUpdate.body.found).toBe(true);
  expect(lookupAfterUpdate.body.product.name).toBe(updatedName);

  await page.getByRole("button", { name: "Soft delete barcode" }).click();
  await expect(page.getByText("Barcode soft deleted.")).toBeVisible();

  const lookupAfterDelete = await page.evaluate(async (lookupBarcode) => {
    const response = await fetch(`/api/barcode/${lookupBarcode}`);
    return {
      status: response.status,
      body: await response.json(),
    };
  }, barcode);

  expect(lookupAfterDelete.body.found).toBe(false);

  await page.getByRole("button", { name: "Restore barcode" }).click();
  await expect(page.getByText("Barcode restored.")).toBeVisible();

  const lookupAfterRestore = await page.evaluate(async (lookupBarcode) => {
    const response = await fetch(`/api/barcode/${lookupBarcode}`);
    return {
      status: response.status,
      body: await response.json(),
    };
  }, barcode);

  expect(lookupAfterRestore.body.found).toBe(true);
  expect(lookupAfterRestore.body.product.name).toBe(updatedName);
});
