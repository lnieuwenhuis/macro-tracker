import { expect, test, type Page, type APIRequestContext } from "@playwright/test";

async function openAdminUserDetail(page: Page, email: string) {
  await page.goto(`/admin/users?q=${encodeURIComponent(email)}`);
  await Promise.all([
    page.waitForURL(/\/admin\/users\/[^/?]+(?:\?.*)?$/),
    page.getByRole("link", { name: email }).click(),
  ]);
}

async function ensureAdminUser(page: Page, request: APIRequestContext) {
  const createUserResponse = await request.post("/api/test/session", {
    data: { email: "admin@example.com" },
  });
  expect(createUserResponse.status()).toBe(200);

  await page.goto("/api/test/session?email=owner@example.com");
  await openAdminUserDetail(page, "admin@example.com");

  const roleSelect = page.locator('select[name="role"]');
  if ((await roleSelect.inputValue()) !== "admin") {
    await roleSelect.selectOption("admin");
    await page.getByRole("button", { name: "Update role" }).click();
    await page.waitForURL(/saved=role/);
    await expect(page.getByText("Role updated.")).toBeVisible();
  }
}

test("owner bootstrap account sees the admin entry and can open /admin", async ({
  page,
}) => {
  await page.goto("/api/test/session?email=owner@example.com");
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("link", { name: "Admin" })).toBeVisible();
  await page.getByRole("link", { name: "Admin" }).click();

  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByText("Operations Panel")).toBeVisible();
});

test("non-admin users do not see the admin link and get a 404 at /admin", async ({
  page,
}) => {
  await page.goto("/api/test/session?email=user@example.com");
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("link", { name: "Admin" })).toHaveCount(0);

  await page.goto("/admin");
  await expect(page.getByText("This page could not be found.")).toBeVisible();
});

test("owner can promote an admin, audit the change, and the admin is blocked from owner controls", async ({
  page,
  request,
}) => {
  await ensureAdminUser(page, request);

  await page.goto("/admin/audit");
  await expect(page.getByText("user.role_changed")).toBeVisible();

  await page.goto("/api/test/session?email=admin@example.com");
  await openAdminUserDetail(page, "admin@example.com");
  await expect(page.getByRole("button", { name: "Update role" })).toHaveCount(0);

  await page.goto("/admin/audit");
  await expect(page.getByText("This page could not be found.")).toBeVisible();
});

test("admin can edit, soft-delete, and restore barcode products", async ({
  page,
  request,
}) => {
  await ensureAdminUser(page, request);
  await page.goto("/api/test/session?email=admin@example.com");
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
