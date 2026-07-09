import {
  completeUserOnboarding,
  createApiToken,
  createMealEntry,
  createPersonalFoodProduct,
  foodProducts,
  getApiScopes,
  lookupBarcodeFoodProduct,
  revokeApiToken,
  saveBarcodeFoodProduct,
  setDatabaseRuntimeForTesting,
  upsertUserFromShooProfile,
  type DatabaseRuntime,
} from "@macro-tracker/db";
import { createTestDatabase } from "@macro-tracker/db/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleApiV1Request } from "@/lib/api-v1";
import { API_V1_ENDPOINTS, formatApiV1ScopeSummary, getApiV1OpenApi } from "@/lib/api-v1-openapi";
import * as apiV1Route from "@/app/api/v1/[[...path]]/route";

describe("Macro Tracker API v1", () => {
  let runtime: DatabaseRuntime;
  let userId: string;
  let fullToken: string;

  beforeEach(async () => {
    runtime = await createTestDatabase();
    setDatabaseRuntimeForTesting(runtime);
    const user = await upsertUserFromShooProfile(
      {
        pairwiseSub: "api-user",
        email: "api@example.com",
        displayName: "API User",
      },
      runtime.db,
    );
    userId = user.id;
    await completeUserOnboarding(userId, { preferredWeightUnit: "kg" }, runtime.db);
    fullToken = (
      await createApiToken(
        userId,
        {
          name: "Full API",
          scopes: getApiScopes(),
        },
        runtime.db,
      )
    ).token;
  });

  afterEach(async () => {
    setDatabaseRuntimeForTesting();
    await runtime.close();
  });

  async function apiRequest(
    method: string,
    path: string,
    options: {
      token?: string;
      body?: unknown;
      rawBody?: string;
    } = {},
  ) {
    const headers: Record<string, string> = {};
    if (options.token) {
      headers.authorization = `Bearer ${options.token}`;
    }
    if (options.body !== undefined || options.rawBody !== undefined) {
      headers["content-type"] = "application/json";
    }

    const url = new URL(`http://localhost/api/v1${path}`);

    return handleApiV1Request(
      new Request(url, {
        method,
        headers,
        body: options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      }),
      url.pathname.replace("/api/v1", "").split("/").filter(Boolean),
      method,
    );
  }

  async function withBackendUrl<T>(url: string, operation: () => Promise<T>) {
    const previous = process.env.BACKEND_URL;
    process.env.BACKEND_URL = url;
    try {
      return await operation();
    } finally {
      if (previous === undefined) {
        delete process.env.BACKEND_URL;
      } else {
        process.env.BACKEND_URL = previous;
      }
    }
  }

  function expectNoInternalFoodFields(product: Record<string, unknown>) {
    expect(product).not.toHaveProperty("ownerUserId");
    expect(product).not.toHaveProperty("submittedByUserId");
    expect(product).not.toHaveProperty("deletedByUserId");
    expect(product).not.toHaveProperty("sourceProvider");
    expect(product).not.toHaveProperty("sourceConfidence");
    expect(product).not.toHaveProperty("sourceMetadata");
    expect(product).not.toHaveProperty("correctedFromProductId");
  }

  it("returns CORS preflight headers for API v1 paths", async () => {
    const response = await apiRequest("OPTIONS", "/days/2026-03-19");

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("returns consistent auth and scope errors", async () => {
    const missing = await apiRequest("GET", "/goals");
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "missing_token" },
    });

    const malformed = await handleApiV1Request(
      new Request("http://localhost/api/v1/goals", {
        headers: { authorization: "Token nope" },
      }),
      ["goals"],
      "GET",
    );
    expect(malformed.status).toBe(401);
    await expect(malformed.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "malformed_token" },
    });

    const expired = await createApiToken(
      userId,
      {
        name: "Expired",
        scopes: ["read:goals"],
        expiresAt: new Date(Date.now() - 60_000),
      },
      runtime.db,
    );
    const expiredResponse = await apiRequest("GET", "/goals", {
      token: expired.token,
    });
    expect(expiredResponse.status).toBe(401);
    await expect(expiredResponse.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "expired_token" },
    });

    const revoked = await createApiToken(
      userId,
      {
        name: "Revoked",
        scopes: ["read:goals"],
      },
      runtime.db,
    );
    await revokeApiToken(userId, revoked.record.id, runtime.db);
    const revokedResponse = await apiRequest("GET", "/goals", {
      token: revoked.token,
    });
    expect(revokedResponse.status).toBe(401);
    await expect(revokedResponse.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "revoked_token" },
    });

    const goalsOnly = await createApiToken(
      userId,
      {
        name: "Goals",
        scopes: ["read:goals"],
      },
      runtime.db,
    );
    const insufficient = await apiRequest("GET", "/days/2026-03-19", {
      token: goalsOnly.token,
    });
    expect(insufficient.status).toBe(403);
    await expect(insufficient.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "insufficient_scope" },
    });
  });

  it("rejects API tokens owned by users who have not completed onboarding", async () => {
    const user = await upsertUserFromShooProfile(
      {
        pairwiseSub: "api-not-onboarded-user",
        email: "api-not-onboarded@example.com",
      },
      runtime.db,
    );
    const token = await createApiToken(
      user.id,
      {
        name: "Not onboarded",
        scopes: getApiScopes(),
      },
      runtime.db,
    );

    const response = await apiRequest("GET", "/goals", { token: token.token });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "onboarding_required" },
    });
  });

  it("requires every scope represented by summary data", async () => {
    await apiRequest("PATCH", "/goals", {
      token: fullToken,
      body: { caloriesKcal: 2400, proteinG: 150 },
    });
    const groupResponse = await apiRequest("POST", "/meal-groups", {
      token: fullToken,
      body: { label: "Dinner" },
    });
    const group = (await groupResponse.json()).data;
    await apiRequest("POST", "/days/2026-03-19/entries", {
      token: fullToken,
      body: {
        mealGroupId: group.id,
        label: "Private dinner",
        quantity: 1,
        unit: "serving",
        proteinG: 20,
        carbsG: 30,
        fatG: 10,
        caloriesKcal: 300,
      },
    });

    const statsOnly = await createApiToken(
      userId,
      {
        name: "Stats only",
        scopes: ["read:stats"],
      },
      runtime.db,
    );
    const response = await apiRequest("GET", "/summary?date=2026-03-19", {
      token: statsOnly.token,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "insufficient_scope" },
    });
  });

  it("requires read:weight before stats endpoints can expose weight-derived data", async () => {
    await apiRequest("POST", "/weight/entries", {
      token: fullToken,
      body: { date: "2026-03-19", weightKg: 80 },
    });

    const statsOnly = await createApiToken(
      userId,
      {
        name: "Stats only",
        scopes: ["read:stats"],
      },
      runtime.db,
    );
    const summaryWithoutWeight = await createApiToken(
      userId,
      {
        name: "Summary without weight",
        scopes: ["read:stats", "read:daily", "read:goals"],
      },
      runtime.db,
    );

    for (const [path, token] of [
      ["/stats?date=2026-03-19", statsOnly.token],
      ["/summary?date=2026-03-19", summaryWithoutWeight.token],
    ] as const) {
      const response = await apiRequest("GET", path, { token });

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "insufficient_scope" },
      });
    }
  });

  it("requires read:goals before stats endpoints expose goal-derived stats", async () => {
    await apiRequest("PATCH", "/goals", {
      token: fullToken,
      body: { caloriesKcal: 2400, proteinG: 150, carbsG: 260, fatG: 80 },
    });
    await apiRequest("POST", "/days/2026-03-19/entries", {
      token: fullToken,
      body: {
        label: "Goal revealing dinner",
        quantity: 1,
        unit: "serving",
        proteinG: 150,
        carbsG: 260,
        fatG: 80,
        caloriesKcal: 2400,
      },
    });

    const statsAndWeightOnly = await createApiToken(
      userId,
      {
        name: "Stats and weight only",
        scopes: ["read:stats", "read:weight"],
      },
      runtime.db,
    );

    const response = await apiRequest("GET", "/stats?date=2026-03-19", {
      token: statsAndWeightOnly.token,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "insufficient_scope" },
    });
  });

  it("requires account and goals scopes before /me exposes account metadata and goals", async () => {
    const goalsOnly = await createApiToken(
      userId,
      {
        name: "Goals only",
        scopes: ["read:goals"],
      },
      runtime.db,
    );
    const accountOnly = await createApiToken(
      userId,
      {
        name: "Account only",
        scopes: ["read:account"],
      },
      runtime.db,
    );
    const accountAndGoals = await createApiToken(
      userId,
      {
        name: "Account and goals",
        scopes: ["read:account", "read:goals"],
      },
      runtime.db,
    );

    const rejected = await apiRequest("GET", "/me", { token: goalsOnly.token });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "insufficient_scope" },
    });

    const accountRejected = await apiRequest("GET", "/me", { token: accountOnly.token });
    expect(accountRejected.status).toBe(403);
    await expect(accountRejected.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "insufficient_scope" },
    });

    const accepted = await apiRequest("GET", "/me", { token: accountAndGoals.token });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      ok: true,
      data: {
        user: {
          id: userId,
          email: "api@example.com",
        },
        goals: {
          caloriesKcal: null,
          proteinG: null,
          carbsG: null,
          fatG: null,
        },
      },
    });
  });

  it("requires read:goals before PATCH /goals returns merged goal values", async () => {
    const readWriteGoals = await createApiToken(
      userId,
      {
        name: "Read/write goals",
        scopes: ["write:goals", "read:goals"],
      },
      runtime.db,
    );
    const writeOnlyGoals = await createApiToken(
      userId,
      {
        name: "Write-only goals",
        scopes: ["write:goals"],
      },
      runtime.db,
    );

    const seeded = await apiRequest("PATCH", "/goals", {
      token: readWriteGoals.token,
      body: { caloriesKcal: 2400, proteinG: 150, carbsG: 260, fatG: 80 },
    });
    expect(seeded.status).toBe(200);

    const rejected = await apiRequest("PATCH", "/goals", {
      token: writeOnlyGoals.token,
      body: {},
    });

    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "insufficient_scope" },
    });
  });

  it("requires read:daily before PATCH /meal-entries/{id} returns merged entry data", async () => {
    const writeOnlyDaily = await createApiToken(
      userId,
      {
        name: "Write-only daily",
        scopes: ["write:daily"],
      },
      runtime.db,
    );
    const created = await apiRequest("POST", "/days/2026-03-19/entries", {
      token: fullToken,
      body: {
        label: "Private snack",
        proteinG: 17,
        carbsG: 7,
        fatG: 0,
        caloriesKcal: 100,
      },
    });
    expect(created.status).toBe(201);
    const entry = (await created.json()).data;

    const rejected = await apiRequest("PATCH", `/meal-entries/${entry.id}`, {
      token: writeOnlyDaily.token,
      body: {},
    });

    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "insufficient_scope" },
    });
  });

  it("requires read:daily before PATCH /meal-entries/{id}/status returns entry data", async () => {
    const writeOnlyDaily = await createApiToken(
      userId,
      {
        name: "Write-only daily",
        scopes: ["write:daily"],
      },
      runtime.db,
    );
    const created = await apiRequest("POST", "/days/2026-03-19/entries", {
      token: fullToken,
      body: {
        label: "Private dinner",
        proteinG: 20,
        carbsG: 30,
        fatG: 10,
        caloriesKcal: 300,
      },
    });
    expect(created.status).toBe(201);
    const entry = (await created.json()).data;

    const rejected = await apiRequest("PATCH", `/meal-entries/${entry.id}/status`, {
      token: writeOnlyDaily.token,
      body: { status: "planned" },
    });

    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "insufficient_scope" },
    });
  });

  it("requires read:foods before PATCH /foods/{id} can return merged product data", async () => {
    const existing = await createPersonalFoodProduct(
      userId,
      {
        name: "Private oats",
        brand: "Macro Mill",
        source: "manual",
        barcode: "6234567890123",
        proteinPer100: 13,
        carbsPer100: 68,
        fatPer100: 7,
        caloriesPer100: 389,
      },
      runtime.db,
    );
    const writeOnlyFoods = await createApiToken(
      userId,
      {
        name: "Write-only foods",
        scopes: ["write:foods"],
      },
      runtime.db,
    );

    const rejected = await apiRequest("PATCH", `/foods/${existing.id}`, {
      token: writeOnlyFoods.token,
      body: { name: "Renamed oats" },
    });

    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "insufficient_scope" },
    });
  });

  it("requires read:weight before PATCH /weight/entries/{id} can return merged entry data", async () => {
    const writeOnlyWeight = await createApiToken(
      userId,
      {
        name: "Write-only weight",
        scopes: ["write:weight"],
      },
      runtime.db,
    );
    const created = await apiRequest("POST", "/weight/entries", {
      token: fullToken,
      body: {
        date: "2026-03-19",
        weightKg: 80,
        bodyFatPct: 18.5,
        notes: "Private notes",
      },
    });
    expect(created.status).toBe(201);
    const entry = (await created.json()).data;

    const rejected = await apiRequest("PATCH", `/weight/entries/${entry.id}`, {
      token: writeOnlyWeight.token,
      body: { weightKg: 79.8 },
    });

    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "insufficient_scope" },
    });
  });

  it("allows read/write daily tokens to update meal entries and status", async () => {
    const readWriteDaily = await createApiToken(
      userId,
      {
        name: "Read/write daily",
        scopes: ["write:daily", "read:daily"],
      },
      runtime.db,
    );
    const created = await apiRequest("POST", "/days/2026-03-19/entries", {
      token: fullToken,
      body: {
        label: "Private lunch",
        proteinG: 24,
        carbsG: 35,
        fatG: 12,
        caloriesKcal: 344,
      },
    });
    expect(created.status).toBe(201);
    const entry = (await created.json()).data;

    const updated = await apiRequest("PATCH", `/meal-entries/${entry.id}`, {
      token: readWriteDaily.token,
      body: { label: "Updated lunch" },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      ok: true,
      data: {
        id: entry.id,
        label: "Updated lunch",
        proteinG: 24,
        carbsG: 35,
        fatG: 12,
        caloriesKcal: 344,
      },
    });

    const status = await apiRequest("PATCH", `/meal-entries/${entry.id}/status`, {
      token: readWriteDaily.token,
      body: { status: "planned" },
    });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      ok: true,
      data: {
        id: entry.id,
        status: "planned",
        label: "Updated lunch",
      },
    });
  });

  it("requires read:foods to create product-backed meal entries", async () => {
    const food = await createPersonalFoodProduct(
      userId,
      {
        name: "Scoped cottage cheese",
        brand: "Macro Dairy",
        source: "manual",
        proteinPer100: 12,
        carbsPer100: 3,
        fatPer100: 4,
        caloriesPer100: 96,
      },
      runtime.db,
    );
    const writeDailyOnly = await createApiToken(
      userId,
      {
        name: "Write daily only",
        scopes: ["write:daily"],
      },
      runtime.db,
    );
    const writeDailyAndReadFoods = await createApiToken(
      userId,
      {
        name: "Write daily and read foods",
        scopes: ["write:daily", "read:foods"],
      },
      runtime.db,
    );

    const rejected = await apiRequest("POST", "/days/2026-03-19/entries", {
      token: writeDailyOnly.token,
      body: {
        productId: food.id,
        quantity: 100,
        unit: "g",
      },
    });

    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "insufficient_scope" },
    });

    const accepted = await apiRequest("POST", "/days/2026-03-19/entries", {
      token: writeDailyAndReadFoods.token,
      body: {
        productId: food.id,
        quantity: 100,
        unit: "g",
      },
    });

    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({
      ok: true,
      data: {
        productId: food.id,
        label: "Scoped cottage cheese (Macro Dairy)",
        proteinG: 12,
        carbsG: 3,
        fatG: 4,
        caloriesKcal: 96,
      },
    });
  });

  it("requires read:foods to patch meal entries onto products", async () => {
    const food = await createPersonalFoodProduct(
      userId,
      {
        name: "Scoped protein pudding",
        brand: "Macro Dairy",
        source: "manual",
        proteinPer100: 10,
        carbsPer100: 8,
        fatPer100: 2,
        caloriesPer100: 90,
      },
      runtime.db,
    );
    const entryResponse = await apiRequest("POST", "/days/2026-03-19/entries", {
      token: fullToken,
      body: {
        label: "Manual snack",
        proteinG: 1,
        carbsG: 2,
        fatG: 3,
        caloriesKcal: 40,
      },
    });
    expect(entryResponse.status).toBe(201);
    const entry = (await entryResponse.json()).data;
    const readWriteDaily = await createApiToken(
      userId,
      {
        name: "Read/write daily without foods",
        scopes: ["write:daily", "read:daily"],
      },
      runtime.db,
    );
    const readWriteDailyAndFoods = await createApiToken(
      userId,
      {
        name: "Read/write daily and foods",
        scopes: ["write:daily", "read:daily", "read:foods"],
      },
      runtime.db,
    );

    const rejected = await apiRequest("PATCH", `/meal-entries/${entry.id}`, {
      token: readWriteDaily.token,
      body: { productId: food.id, quantity: 100, unit: "g" },
    });

    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "insufficient_scope" },
    });

    const accepted = await apiRequest("PATCH", `/meal-entries/${entry.id}`, {
      token: readWriteDailyAndFoods.token,
      body: { productId: food.id, quantity: 100, unit: "g" },
    });

    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      ok: true,
      data: {
        id: entry.id,
        productId: food.id,
        label: "Manual snack",
        proteinG: 10,
        carbsG: 8,
        fatG: 2,
        caloriesKcal: 90,
      },
    });
  });

  it("preserves product-backed meal entry macros when patching only the label", async () => {
    const foodResponse = await apiRequest("POST", "/foods", {
      token: fullToken,
      body: {
        name: "Patchable skyr",
        brand: "Macro Dairy",
        defaultServingQuantity: 100,
        defaultServingUnit: "g",
        proteinPer100: 10,
        carbsPer100: 4,
        fatPer100: 1,
        caloriesPer100: 65,
        servingWeightG: 100,
      },
    });
    expect(foodResponse.status).toBe(201);
    const food = (await foodResponse.json()).data;

    const entryResponse = await apiRequest("POST", "/days/2026-03-19/entries", {
      token: fullToken,
      body: {
        productId: food.id,
        label: "",
        quantity: 200,
        unit: "g",
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
        caloriesKcal: 1,
      },
    });
    expect(entryResponse.status).toBe(201);
    const entry = (await entryResponse.json()).data;
    expect(entry).toMatchObject({
      proteinG: 20,
      carbsG: 8,
      fatG: 2,
      caloriesKcal: 130,
    });

    const foodUpdateResponse = await apiRequest("PATCH", `/foods/${food.id}`, {
      token: fullToken,
      body: {
        proteinPer100: 20,
        carbsPer100: 10,
        fatPer100: 3,
        caloriesPer100: 150,
      },
    });
    expect(foodUpdateResponse.status).toBe(200);

    const updatedEntryResponse = await apiRequest("PATCH", `/meal-entries/${entry.id}`, {
      token: fullToken,
      body: { label: "Renamed skyr" },
    });
    expect(updatedEntryResponse.status).toBe(200);
    await expect(updatedEntryResponse.json()).resolves.toMatchObject({
      ok: true,
      data: {
        id: entry.id,
        label: "Renamed skyr",
        proteinG: 20,
        carbsG: 8,
        fatG: 2,
        caloriesKcal: 130,
      },
    });
  });

  it("omits internal food fields from search responses", async () => {
    await saveBarcodeFoodProduct(
      userId,
      {
        barcode: "2234567890123",
        name: "Shared protein bar",
        brands: "Macro Mill",
        proteinG: 36,
        carbsG: 44,
        fatG: 9,
        caloriesKcal: 405,
        servingSizeG: 55,
      },
      runtime.db,
    );

    const response = await apiRequest("GET", "/foods/search?q=protein", { token: fullToken });
    expect(response.status).toBe(200);
    const payload = await response.json();
    const product = payload.data.find((item: { barcode: string | null }) => item.barcode === "2234567890123");

    expect(product).toMatchObject({
      barcode: "2234567890123",
      name: "Shared protein bar",
      brand: "Macro Mill",
    });
    expectNoInternalFoodFields(product);
  });

  it("omits internal food fields from barcode lookup responses", async () => {
    await saveBarcodeFoodProduct(
      userId,
      {
        barcode: "3234567890123",
        name: "Shared oats",
        brands: "Macro Mill",
        proteinG: 13,
        carbsG: 68,
        fatG: 7,
        caloriesKcal: 389,
        servingSizeG: 100,
      },
      runtime.db,
    );

    const response = await apiRequest("GET", "/barcodes/3234567890123", { token: fullToken });
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.data).toMatchObject({
      barcode: "3234567890123",
      name: "Shared oats",
      brand: "Macro Mill",
    });
    expectNoInternalFoodFields(payload.data);
  });

  it("sanitizes food create responses and ignores caller-controlled internal metadata", async () => {
    const foodsOnly = await createApiToken(
      userId,
      {
        name: "Foods only",
        scopes: ["write:foods"],
      },
      runtime.db,
    );

    const response = await apiRequest("POST", "/foods", {
      token: foodsOnly.token,
      body: {
        name: "Client yogurt",
        brand: "Client Dairy",
        barcode: "4234567890123",
        defaultServingQuantity: 170,
        defaultServingUnit: "g",
        proteinPer100: 10,
        carbsPer100: 4,
        fatPer100: 0,
        caloriesPer100: 59,
        servingWeightG: 170,
        scope: "global",
        source: "barcode",
        submittedByUserId: "forged-submitter",
        deletedByUserId: "forged-deleter",
        sourceProvider: "forged-provider",
        sourceConfidence: 0.99,
        sourceMetadata: { forged: true },
        correctedFromProductId: "forged-correction",
      },
    });

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.data).toMatchObject({
      name: "Client yogurt",
      scope: "personal",
      source: "manual",
      barcode: "4234567890123",
    });
    expectNoInternalFoodFields(payload.data);

    const [stored] = await runtime.db
      .select()
      .from(foodProducts)
      .where(eq(foodProducts.id, payload.data.id));
    expect(stored).toMatchObject({
      ownerUserId: userId,
      scope: "personal",
      source: "manual",
      submittedByUserId: userId,
      deletedByUserId: null,
      sourceProvider: null,
      sourceConfidence: null,
      sourceMetadata: {},
      correctedFromProductId: null,
    });
  });

  it("sanitizes food update responses and ignores caller-controlled internal metadata", async () => {
    const existing = await createPersonalFoodProduct(
      userId,
      {
        name: "Editable yogurt",
        source: "manual",
        proteinPer100: 9,
        carbsPer100: 5,
        fatPer100: 1,
        caloriesPer100: 65,
        sourceProvider: "server-import",
        sourceConfidence: 0.8,
        sourceMetadata: { imported: true },
      },
      runtime.db,
    );
    const foodsOnly = await createApiToken(
      userId,
      {
        name: "Foods only",
        scopes: ["write:foods", "read:foods"],
      },
      runtime.db,
    );

    const response = await apiRequest("PATCH", `/foods/${existing.id}`, {
      token: foodsOnly.token,
      body: {
        name: "Updated yogurt",
        brand: "Updated Dairy",
        defaultServingQuantity: 100,
        defaultServingUnit: "g",
        proteinPer100: 11,
        carbsPer100: 4,
        fatPer100: 0,
        caloriesPer100: 60,
        servingWeightG: 100,
        source: "barcode",
        sourceProvider: "forged-provider",
        sourceConfidence: 0.99,
        sourceMetadata: { forged: true },
        correctedFromProductId: "forged-correction",
      },
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data).toMatchObject({
      id: existing.id,
      name: "Updated yogurt",
      source: "manual",
    });
    expectNoInternalFoodFields(payload.data);

    const [stored] = await runtime.db
      .select()
      .from(foodProducts)
      .where(eq(foodProducts.id, existing.id));
    expect(stored).toMatchObject({
      source: "manual",
      sourceProvider: null,
      sourceConfidence: null,
      sourceMetadata: {},
      correctedFromProductId: null,
    });
  });

  it("preserves omitted optional food fields when patching a personal food", async () => {
    const created = await apiRequest("POST", "/foods", {
      token: fullToken,
      body: {
        name: "Patchable yogurt",
        brand: "Macro Dairy",
        barcode: "5234567890123",
        defaultServingQuantity: 170,
        defaultServingUnit: "g",
        proteinPer100: 10,
        carbsPer100: 4,
        fatPer100: 0,
        caloriesPer100: 59,
        servingWeightG: 170,
        servingVolumeMl: null,
      },
    });
    expect(created.status).toBe(201);
    const food = (await created.json()).data;

    const updated = await apiRequest("PATCH", `/foods/${food.id}`, {
      token: fullToken,
      body: {
        name: "Patchable yogurt 0%",
        proteinPer100: 11,
        carbsPer100: 3,
        fatPer100: 0,
        caloriesPer100: 56,
      },
    });

    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      ok: true,
      data: {
        id: food.id,
        name: "Patchable yogurt 0%",
        brand: "Macro Dairy",
        barcode: "5234567890123",
        defaultServingQuantity: 170,
        defaultServingUnit: "g",
        proteinPer100: 11,
        carbsPer100: 3,
        fatPer100: 0,
        caloriesPer100: 56,
        servingWeightG: 170,
        servingVolumeMl: null,
      },
    });
  });

  it("does not allow write:foods tokens to mutate shared barcode foods", async () => {
    const foodsOnly = await createApiToken(
      userId,
      {
        name: "Foods only",
        scopes: ["write:foods"],
      },
      runtime.db,
    );

    const response = await apiRequest("POST", "/barcode-foods", {
      token: foodsOnly.token,
      body: {
        barcode: "1234567890123",
        name: "Shared oats",
        brands: "Macro Mill",
        proteinG: 13,
        carbsG: 68,
        fatG: 7,
        caloriesKcal: 389,
        servingSizeG: 100,
      },
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    await expect(lookupBarcodeFoodProduct("1234567890123", runtime.db)).resolves.toBeNull();
  });

  it("rejects invalid date query params while defaulting omitted dates", async () => {
    for (const path of ["/weight", "/stats", "/summary", "/leaderboard"]) {
      const omitted = await apiRequest("GET", path, { token: fullToken });
      expect(omitted.status).toBe(200);
      await expect(omitted.json()).resolves.toMatchObject({ ok: true });

      for (const invalidDate of ["", "not-a-date", "2026-02-31", "20260319"]) {
        const response = await apiRequest("GET", `${path}?date=${invalidDate}`, {
          token: fullToken,
        });
        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
          ok: false,
          error: { code: "bad_request" },
        });
      }
    }
  });

  it("rejects invalid request body dates before calling data mutations", async () => {
    for (const request of [
      {
        method: "POST",
        path: "/weight/entries",
        body: { date: "2026-02-31", weightKg: 80 },
      },
      {
        method: "PATCH",
        path: "/weight/entries/00000000-0000-0000-0000-000000000000",
        body: { date: "20260319", weightKg: 80 },
      },
      {
        method: "POST",
        path: "/templates/from-day",
        body: { date: "not-a-date", type: "day", label: "Invalid day" },
      },
      {
        method: "POST",
        path: "/templates/00000000-0000-0000-0000-000000000000/apply",
        body: { date: "", status: "planned" },
      },
    ]) {
      const response = await apiRequest(request.method, request.path, {
        token: fullToken,
        body: request.body,
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: {
          code: "bad_request",
          message: "Date must use YYYY-MM-DD.",
        },
      });
    }
  });

  it("returns bad_request for malformed UUID path parameters", async () => {
    for (const request of [
      { method: "PATCH", path: "/meal-entries/not-a-uuid", body: { label: "Updated" } },
      { method: "DELETE", path: "/meal-entries/not-a-uuid" },
      { method: "PATCH", path: "/meal-entries/not-a-uuid/status", body: { status: "planned" } },
      { method: "PATCH", path: "/meal-groups/not-a-uuid", body: { label: "Dinner" } },
      { method: "DELETE", path: "/meal-groups/not-a-uuid" },
      {
        method: "PATCH",
        path: "/foods/not-a-uuid",
        body: { name: "Food", proteinPer100: 1, carbsPer100: 2, fatPer100: 3, caloriesPer100: 40 },
      },
      { method: "GET", path: "/templates/not-a-uuid" },
      { method: "PATCH", path: "/templates/not-a-uuid", body: { type: "day", label: "Day", items: [] } },
      { method: "DELETE", path: "/templates/not-a-uuid" },
      { method: "POST", path: "/templates/not-a-uuid/apply", body: { date: "2026-03-19" } },
      { method: "GET", path: "/recipes/not-a-uuid" },
      { method: "PATCH", path: "/recipes/not-a-uuid", body: { label: "Recipe", portions: 1, ingredients: [] } },
      { method: "DELETE", path: "/recipes/not-a-uuid" },
      { method: "POST", path: "/recipes/not-a-uuid/log", body: { date: "2026-03-19" } },
      { method: "PATCH", path: "/weight/entries/not-a-uuid", body: { date: "2026-03-19", weightKg: 80 } },
      { method: "DELETE", path: "/weight/entries/not-a-uuid" },
    ]) {
      const response = await apiRequest(request.method, request.path, {
        token: fullToken,
        body: "body" in request ? request.body : undefined,
      });

      expect(response.status, `${request.method} ${request.path}`).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "bad_request" },
      });
    }
  });

  it("returns bad_request for malformed JSON object mutation bodies", async () => {
    const writeRequests = [
      ["PATCH", "/goals", null],
      ["POST", "/days/2026-03-19/entries", {}],
      ["PATCH", "/meal-entries/entry-id/status", null],
      ["POST", "/meal-groups", {}],
      ["POST", "/foods", {}],
      ["POST", "/templates", {}],
      ["POST", "/templates/from-day", null],
      ["POST", "/recipes", {}],
      ["POST", "/recipes/recipe-id/log", null],
      ["POST", "/weight/entries", {}],
      ["PATCH", "/weight/goal", null],
    ] as const;

    for (const [method, path, body] of writeRequests) {
      const response = await apiRequest(method, path, { token: fullToken, body });

      expect(response.status, `${method} ${path}`).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "bad_request" },
      });
    }
  });

  it("preserves omitted notes and body fat when patching a weight entry", async () => {
    const created = await apiRequest("POST", "/weight/entries", {
      token: fullToken,
      body: {
        date: "2026-03-19",
        weightKg: 80,
        bodyFatPct: 18.5,
        notes: "Morning weigh-in",
      },
    });
    expect(created.status).toBe(201);
    const entry = (await created.json()).data;

    const updated = await apiRequest("PATCH", `/weight/entries/${entry.id}`, {
      token: fullToken,
      body: { date: "2026-03-19", weightKg: 79.8 },
    });

    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      ok: true,
      data: {
        id: entry.id,
        date: "2026-03-19",
        weightKg: 79.8,
        bodyFatPct: 18.5,
        notes: "Morning weigh-in",
      },
    });
  });

  it("returns conflict without overwriting when creating a duplicate-date weight entry", async () => {
    const first = await apiRequest("POST", "/weight/entries", {
      token: fullToken,
      body: {
        date: "2026-03-19",
        weightKg: 80,
        bodyFatPct: 18.5,
        notes: "Original entry",
      },
    });
    expect(first.status).toBe(201);

    const duplicate = await apiRequest("POST", "/weight/entries", {
      token: fullToken,
      body: {
        date: "2026-03-19",
        weightKg: 79,
        bodyFatPct: 17,
        notes: "Should not overwrite",
      },
    });

    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "weight_entry_date_conflict",
        message: "A weight entry already exists for this date.",
      },
    });

    const entries = await apiRequest("GET", "/weight/entries", { token: fullToken });
    await expect(entries.json()).resolves.toMatchObject({
      ok: true,
      data: [
        {
          date: "2026-03-19",
          weightKg: 80,
          bodyFatPct: 18.5,
          notes: "Original entry",
        },
      ],
    });
  });

  it("returns one conflict without overwriting during duplicate-date weight entry races", async () => {
    const [first, duplicate] = await Promise.all([
      apiRequest("POST", "/weight/entries", {
        token: fullToken,
        body: {
          date: "2026-03-19",
          weightKg: 80,
          bodyFatPct: 18.5,
          notes: "Original entry",
        },
      }),
      apiRequest("POST", "/weight/entries", {
        token: fullToken,
        body: {
          date: "2026-03-19",
          weightKg: 79,
          bodyFatPct: 17,
          notes: "Should not overwrite",
        },
      }),
    ]);

    expect([first.status, duplicate.status].sort()).toEqual([201, 409]);
    const created = first.status === 201 ? first : duplicate;
    const createdPayload = await created.json();

    const entries = await apiRequest("GET", "/weight/entries", { token: fullToken });
    const payload = await entries.json();
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]).toMatchObject({
      id: createdPayload.data.id,
      date: createdPayload.data.date,
      weightKg: createdPayload.data.weightKg,
      bodyFatPct: createdPayload.data.bodyFatPct,
      notes: createdPayload.data.notes,
    });
  });

  it("returns conflict when a weight entry update reuses an existing date", async () => {
    const first = await apiRequest("POST", "/weight/entries", {
      token: fullToken,
      body: { date: "2026-03-19", weightKg: 80 },
    });
    const second = await apiRequest("POST", "/weight/entries", {
      token: fullToken,
      body: { date: "2026-03-20", weightKg: 81 },
    });
    const firstEntry = (await first.json()).data;
    await second.json();

    const conflict = await apiRequest("PATCH", `/weight/entries/${firstEntry.id}`, {
      token: fullToken,
      body: { date: "2026-03-20", weightKg: 80.5 },
    });

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "weight_entry_date_conflict",
        message: "A weight entry already exists for this date.",
      },
    });
  });

  it("returns internal_error for backend proxy failures", async () => {
    const response = await withBackendUrl("http://127.0.0.1:9", () =>
      apiRequest("GET", "/me", { token: fullToken }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "internal_error",
        message: "An internal server error occurred.",
      },
    });
  });

  it("returns internal_error with CORS headers for backend proxy failures", async () => {
    const response = await withBackendUrl("http://127.0.0.1:9", () =>
      apiRequest("GET", "/me", { token: fullToken }),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "internal_error",
        message: "An internal server error occurred.",
      },
    });
  });

  it("returns method_not_allowed for known routes with unsupported methods", async () => {
    for (const request of [
      { method: "POST", path: "/goals" },
      { method: "POST", path: "/barcodes/1234567890123" },
      { method: "PATCH", path: "/foods/search" },
      { method: "PATCH", path: "/meal-groups/reorder" },
      { method: "GET", path: "/templates/from-day" },
      { method: "GET", path: "/templates/template-id/apply" },
      { method: "GET", path: "/recipes/recipe-id/log" },
    ]) {
      const response = await apiRequest(request.method, request.path);

      expect(response.status).toBe(405);
      if (request.path === "/goals") {
        expect(response.headers.get("allow")).toBe("GET, PATCH, OPTIONS");
      }
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "method_not_allowed" },
      });
    }

    const validMethod = await apiRequest("GET", "/goals");
    expect(validMethod.status).toBe(401);

    const unknownPath = await apiRequest("POST", "/not-a-route");
    expect(unknownPath.status).toBe(404);
  });

  it("routes unsupported Next HTTP methods through the API error envelope", async () => {
    for (const [method, handler] of [["PUT", apiV1Route.PUT]] as const) {
      const response = await handler(new Request("http://localhost/api/v1/goals", { method }), {
        params: Promise.resolve({ path: ["goals"] }),
      });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, PATCH, OPTIONS");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "method_not_allowed" },
      });
    }

    expect(apiV1Route).not.toHaveProperty("HEAD");
  });

  it("rejects invalid goal patches without persisting partial changes", async () => {
    const initial = {
      caloriesKcal: 2400,
      proteinG: 150,
      carbsG: 260,
      fatG: 80,
    };
    await apiRequest("PATCH", "/goals", { token: fullToken, body: initial });

    for (const body of [
      { proteinG: -50 },
      { caloriesKcal: -1 },
      { caloriesKcal: 2100.5 },
      { carbsG: "260" },
    ]) {
      const response = await apiRequest("PATCH", "/goals", { token: fullToken, body });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ ok: false });
    }

    const malformed = await apiRequest("PATCH", "/goals", {
      token: fullToken,
      rawBody: "{\"proteinG\":NaN}",
    });
    expect(malformed.status).toBe(400);

    const unchanged = await apiRequest("GET", "/goals", { token: fullToken });
    await expect(unchanged.json()).resolves.toMatchObject({
      ok: true,
      data: initial,
    });

    const omittedAndNull = await apiRequest("PATCH", "/goals", {
      token: fullToken,
      body: { proteinG: null },
    });
    await expect(omittedAndNull.json()).resolves.toMatchObject({
      ok: true,
      data: { ...initial, proteinG: null },
    });
  });

  it("rejects invalid weight goals and only clears explicit null", async () => {
    await apiRequest("PATCH", "/weight/goal", {
      token: fullToken,
      body: { goalWeightKg: 78 },
    });

    for (const body of [
      {},
      { goalWeightKg: "78" },
      { goalWeightKg: -1 },
      { goalWeightKg: 0 },
    ]) {
      const response = await apiRequest("PATCH", "/weight/goal", { token: fullToken, body });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ ok: false });
    }

    const malformed = await apiRequest("PATCH", "/weight/goal", {
      token: fullToken,
      rawBody: "{\"goalWeightKg\":NaN}",
    });
    expect(malformed.status).toBe(400);

    const stillSet = await apiRequest("GET", "/weight/goal", { token: fullToken });
    await expect(stillSet.json()).resolves.toMatchObject({
      ok: true,
      data: { goalWeightKg: 78 },
    });

    const cleared = await apiRequest("PATCH", "/weight/goal", {
      token: fullToken,
      body: { goalWeightKg: null },
    });
    await expect(cleared.json()).resolves.toMatchObject({
      ok: true,
      data: { goalWeightKg: null },
    });
  });

  it("rejects invalid recipe log status and portion counts", async () => {
    const foodResponse = await apiRequest("POST", "/foods", {
      token: fullToken,
      body: {
        name: "Recipe base",
        defaultServingQuantity: 100,
        defaultServingUnit: "g",
        proteinPer100: 10,
        carbsPer100: 20,
        fatPer100: 5,
        caloriesPer100: 165,
        servingWeightG: 100,
      },
    });
    const food = (await foodResponse.json()).data;
    const recipeResponse = await apiRequest("POST", "/recipes", {
      token: fullToken,
      body: {
        label: "Invalid log checks",
        portions: 2,
        totalCookedWeightG: 400,
        ingredients: [
          {
            productId: food.id,
            label: "Base",
            quantity: 100,
            unit: "g",
            proteinG: 10,
            carbsG: 20,
            fatG: 5,
            caloriesKcal: 165,
          },
        ],
      },
    });
    const recipe = (await recipeResponse.json()).data;

    for (const body of [
      { date: "2026-03-19", status: "done" },
      { date: "2026-03-19", portionCount: -1 },
      { date: "2026-03-19", portionCount: 0 },
      { date: "2026-03-19", portionCount: Number.NaN },
      { date: "2026-03-19", gramsConsumed: "100" },
      { date: "2026-03-19", gramsConsumed: null },
      { date: "2026-03-19", gramsConsumed: Number.NaN },
      { date: "2026-03-19", gramsConsumed: 0 },
      { date: "2026-03-19", gramsConsumed: -1 },
    ]) {
      const response = await apiRequest("POST", `/recipes/${recipe.id}/log`, {
        token: fullToken,
        body,
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "bad_request" },
      });
    }
  });

  it("rejects routes with unexpected trailing path segments", async () => {
    const response = await apiRequest("GET", "/foods/search/extra?q=yogurt", {
      token: fullToken,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("patches meal entries by merging omitted fields from the existing row", async () => {
    const created = await apiRequest("POST", "/days/2026-03-19/entries", {
      token: fullToken,
      body: {
        label: "Greek yogurt",
        proteinG: 17,
        carbsG: 7,
        fatG: 0,
        caloriesKcal: 100,
      },
    });
    expect(created.status).toBe(201);
    const entry = (await created.json()).data;

    const updated = await apiRequest("PATCH", `/meal-entries/${entry.id}`, {
      token: fullToken,
      body: { label: "Yogurt bowl" },
    });

    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      ok: true,
      data: {
        id: entry.id,
        date: "2026-03-19",
        label: "Yogurt bowl",
        sortOrder: entry.sortOrder,
        proteinG: 17,
        carbsG: 7,
        fatG: 0,
        caloriesKcal: 100,
      },
    });
  });

  it("rejects invalid meal entry patch dates without mutating the entry", async () => {
    const created = await apiRequest("POST", "/days/2026-03-19/entries", {
      token: fullToken,
      body: {
        label: "Greek yogurt",
        proteinG: 17,
        carbsG: 7,
        fatG: 0,
        caloriesKcal: 100,
      },
    });
    expect(created.status).toBe(201);
    const entry = (await created.json()).data;

    const rejected = await apiRequest("PATCH", `/meal-entries/${entry.id}`, {
      token: fullToken,
      body: { date: "2026-02-31", label: "Mutated yogurt" },
    });

    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "bad_request",
        message: "Date must use YYYY-MM-DD.",
      },
    });

    const day = await apiRequest("GET", "/days/2026-03-19", { token: fullToken });
    await expect(day.json()).resolves.toMatchObject({
      ok: true,
      data: {
        meals: [
          {
            id: entry.id,
            date: "2026-03-19",
            label: "Greek yogurt",
          },
        ],
      },
    });
  });

  it("rejects meal group reorders that are not an exact active group permutation", async () => {
    const initialGroupsResponse = await apiRequest("GET", "/meal-groups", { token: fullToken });
    const initialGroupIds = (await initialGroupsResponse.json()).data.map(
      (group: { id: string }) => group.id,
    );
    const otherUser = await upsertUserFromShooProfile(
      {
        pairwiseSub: "api-other-user",
        email: "api-other@example.com",
        displayName: "Other API User",
      },
      runtime.db,
    );
    await completeUserOnboarding(otherUser.id, { preferredWeightUnit: "kg" }, runtime.db);
    const otherToken = (
      await createApiToken(otherUser.id, { name: "Other", scopes: getApiScopes() }, runtime.db)
    ).token;
    const otherGroupsResponse = await apiRequest("GET", "/meal-groups", { token: otherToken });
    const otherGroupId = (await otherGroupsResponse.json()).data[0].id;
    const customGroupResponse = await apiRequest("POST", "/meal-groups", {
      token: fullToken,
      body: { label: "Pre-workout" },
    });
    expect(customGroupResponse.status).toBe(201);

    const invalidOrders = [
      [initialGroupIds[0], initialGroupIds[0], ...initialGroupIds.slice(2)],
      initialGroupIds.slice(0, -1),
      [...initialGroupIds.slice(1), "00000000-0000-0000-0000-000000000000"],
      [...initialGroupIds.slice(1), otherGroupId],
      initialGroupIds,
    ];

    for (const orderedIds of invalidOrders) {
      const response = await apiRequest("POST", "/meal-groups/reorder", {
        token: fullToken,
        body: { orderedIds },
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "bad_request" },
      });
    }
  });

  it("reads and writes representative user-owned objects", async () => {
    const goals = await apiRequest("PATCH", "/goals", {
      token: fullToken,
      body: {
        caloriesKcal: 2400,
        proteinG: 150,
        carbsG: 260,
        fatG: 80,
      },
    });
    expect(goals.status).toBe(200);
    await expect(goals.json()).resolves.toMatchObject({
      ok: true,
      data: { caloriesKcal: 2400, proteinG: 150 },
    });

    const me = await apiRequest("GET", "/me", { token: fullToken });
    await expect(me.json()).resolves.toMatchObject({
      ok: true,
      data: {
        user: {
          id: userId,
          email: "api@example.com",
        },
      },
    });

    const initialGroups = await apiRequest("GET", "/meal-groups", {
      token: fullToken,
    });
    const groupData = await initialGroups.json();
    expect(groupData.data).toHaveLength(4);

    const groupResponse = await apiRequest("POST", "/meal-groups", {
      token: fullToken,
      body: { label: "Pre-workout" },
    });
    const customGroup = (await groupResponse.json()).data;
    expect(customGroup.label).toBe("Pre-workout");

    const reordered = await apiRequest("POST", "/meal-groups/reorder", {
      token: fullToken,
      body: {
        orderedIds: [customGroup.id, ...groupData.data.map((group: { id: string }) => group.id)],
      },
    });
    expect(reordered.status).toBe(200);

    const foodResponse = await apiRequest("POST", "/foods", {
      token: fullToken,
      body: {
        name: "Greek yogurt",
        brand: "Macro Dairy",
        defaultServingQuantity: 170,
        defaultServingUnit: "g",
        proteinPer100: 10,
        carbsPer100: 4,
        fatPer100: 0,
        caloriesPer100: 59,
        servingWeightG: 170,
      },
    });
    const food = (await foodResponse.json()).data;
    expect(food.name).toBe("Greek yogurt");

    const updatedFood = await apiRequest("PATCH", `/foods/${food.id}`, {
      token: fullToken,
      body: {
        ...food,
        name: "Greek yogurt 0%",
      },
    });
    expect((await updatedFood.json()).data.name).toBe("Greek yogurt 0%");

    const search = await apiRequest("GET", "/foods/search?q=yogurt", {
      token: fullToken,
    });
    expect((await search.json()).data[0].id).toBe(food.id);

    const entryResponse = await apiRequest("POST", "/days/2026-03-19/entries", {
      token: fullToken,
      body: {
        mealGroupId: customGroup.id,
        productId: food.id,
        label: "",
        quantity: 170,
        unit: "g",
        proteinG: 0,
        carbsG: 0,
        fatG: 0,
        caloriesKcal: 1,
      },
    });
    const entry = (await entryResponse.json()).data;
    expect(entry.label).toContain("Greek yogurt");
    expect(entry.proteinG).toBe(17);

    const updatedEntry = await apiRequest("PATCH", `/meal-entries/${entry.id}`, {
      token: fullToken,
      body: {
        ...entry,
        label: "Yogurt bowl",
      },
    });
    expect((await updatedEntry.json()).data.label).toBe("Yogurt bowl");

    const statusResponse = await apiRequest("PATCH", `/meal-entries/${entry.id}/status`, {
      token: fullToken,
      body: { status: "planned" },
    });
    expect((await statusResponse.json()).data.status).toBe("planned");

    const day = await apiRequest("GET", "/days/2026-03-19", {
      token: fullToken,
    });
    expect((await day.json()).data.meals).toHaveLength(1);

    const templateFromDay = await apiRequest("POST", "/templates/from-day", {
      token: fullToken,
      body: {
        date: "2026-03-19",
        type: "day",
        label: "Training day",
      },
    });
    const template = (await templateFromDay.json()).data;
    expect(template.items).toHaveLength(1);

    const applied = await apiRequest("POST", `/templates/${template.id}/apply`, {
      token: fullToken,
      body: {
        date: "2026-03-20",
        status: "planned",
      },
    });
    expect((await applied.json()).data[0].date).toBe("2026-03-20");

    const recipeResponse = await apiRequest("POST", "/recipes", {
      token: fullToken,
      body: {
        label: "Yogurt oats",
        portions: 2,
        totalCookedWeightG: 500,
        ingredients: [
          {
            productId: food.id,
            label: "Yogurt",
            quantity: 200,
            unit: "g",
            proteinG: 20,
            carbsG: 8,
            fatG: 0,
            caloriesKcal: 118,
          },
        ],
      },
    });
    const recipe = (await recipeResponse.json()).data;
    expect(recipe.perPortionMacros.proteinG).toBe(10);

    const logRecipe = await apiRequest("POST", `/recipes/${recipe.id}/log`, {
      token: fullToken,
      body: {
        date: "2026-03-21",
        portionCount: 1.5,
      },
    });
    expect((await logRecipe.json()).data.label).toContain("Yogurt oats");

    const weight = await apiRequest("POST", "/weight/entries", {
      token: fullToken,
      body: {
        date: "2026-03-19",
        weightKg: 80.25,
        bodyFatPct: null,
        notes: "Morning",
      },
    });
    const weightEntry = (await weight.json()).data;
    expect(weightEntry.weightKg).toBe(80.25);

    const updatedWeight = await apiRequest("PATCH", `/weight/entries/${weightEntry.id}`, {
      token: fullToken,
      body: {
        date: "2026-03-19",
        weightKg: 80,
        bodyFatPct: null,
        notes: "Adjusted",
      },
    });
    expect((await updatedWeight.json()).data.weightKg).toBe(80);

    const weightGoal = await apiRequest("PATCH", "/weight/goal", {
      token: fullToken,
      body: { goalWeightKg: 78 },
    });
    expect((await weightGoal.json()).data.goalWeightKg).toBe(78);

    for (const path of [
      "/weight?date=2026-03-19",
      "/stats?date=2026-03-21",
      "/summary?date=2026-03-21",
      "/leaderboard?date=2026-03-21",
      "/templates",
      "/recipes",
    ]) {
      const response = await apiRequest("GET", path, { token: fullToken });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true });
    }
  });

  it("publishes OpenAPI for every shipped endpoint with scopes", async () => {
    const response = await apiRequest("GET", "/openapi.json");
    const payload = await response.json();
    const openApi = getApiV1OpenApi();

    expect(response.status).toBe(200);
    expect(payload.openapi).toBe("3.1.0");
    expect(payload.info).toEqual(openApi.info);
    expect(payload.paths).toEqual(openApi.paths);
    expect(payload.servers).toEqual([{ url: "/api/v1" }]);
    expect(Object.keys(payload.paths)).toContain("/goals");
    expect(payload.paths["/weight/entries"]?.get).toMatchObject({
      summary: "List weight entries",
      security: [{ bearerAuth: [] }],
      "x-required-scopes": ["read:weight"],
    });
    expect(payload.paths["/stats"]?.get).toMatchObject({
      summary: "Read stats",
      security: [{ bearerAuth: [] }],
      "x-required-scopes": ["read:stats", "read:weight", "read:goals"],
    });
    expect(payload.paths["/days/{date}/entries"]?.post).toMatchObject({
      "x-required-scopes": ["write:daily"],
      "x-conditional-required-scopes": [
        {
          scopes: ["read:foods"],
          when: "non-null productId is supplied",
        },
      ],
    });
    expect(payload.paths["/meal-entries/{id}"]?.patch).toMatchObject({
      "x-required-scopes": ["write:daily", "read:daily"],
      "x-conditional-required-scopes": [
        {
          scopes: ["read:foods"],
          when: "non-null productId is supplied",
        },
      ],
    });
    const mealEntryCreateEndpoint = API_V1_ENDPOINTS.find(
      (endpoint) => endpoint.path === "/days/{date}/entries",
    );
    const mealEntryPatchEndpoint = API_V1_ENDPOINTS.find(
      (endpoint) => endpoint.path === "/meal-entries/{id}",
    );
    expect(formatApiV1ScopeSummary(mealEntryCreateEndpoint!.methods[0]!)).toContain(
      "Additionally requires read:foods when non-null productId is supplied.",
    );
    expect(formatApiV1ScopeSummary(mealEntryPatchEndpoint!.methods[0]!)).toContain(
      "Additionally requires read:foods when non-null productId is supplied.",
    );
    expect(payload.paths["/foods"]?.post.responses).toHaveProperty("201");
    expect(payload.paths["/foods"]?.post.responses).toHaveProperty("405");
    expect(payload.paths["/weight/entries"]?.post.responses).toHaveProperty("409");
    expect(payload.paths["/weight/entries/{id}"]?.patch.responses).toHaveProperty("409");
    expect(payload.paths["/foods"]?.post.requestBody).toBeTruthy();
    expect(payload.paths["/foods/{id}"]?.patch.parameters).toEqual([
      expect.objectContaining({ name: "id", in: "path", required: true }),
    ]);
    expect(payload.paths["/recipes/{id}/log"]?.post.requestBody).toBeTruthy();

    const mealEntryCreateSchema =
      payload.paths["/days/{date}/entries"]?.post.requestBody.content["application/json"].schema;
    expect(mealEntryCreateSchema.anyOf).toContainEqual(
      expect.objectContaining({
        required: ["productId"],
        properties: expect.objectContaining({ productId: { type: "string" } }),
      }),
    );
    expect(mealEntryCreateSchema.anyOf).toContainEqual(
      expect.objectContaining({ required: ["label", "proteinG", "carbsG", "fatG", "caloriesKcal"] }),
    );

    expect(
      payload.paths["/meal-entries/{id}"]?.patch.requestBody.content["application/json"].schema,
    ).not.toHaveProperty("required");
    expect(
      payload.paths["/foods/{id}"]?.patch.requestBody.content["application/json"].schema,
    ).not.toHaveProperty("required");
    expect(
      payload.paths["/weight/entries/{id}"]?.patch.requestBody.content["application/json"].schema,
    ).not.toHaveProperty("required");
    expect(
      payload.paths["/foods"]?.post.requestBody.content["application/json"].schema.required,
    ).toEqual(["name", "proteinPer100", "carbsPer100", "fatPer100", "caloriesPer100"]);
    expect(
      payload.paths["/weight/entries"]?.post.requestBody.content["application/json"].schema.required,
    ).toEqual(["date", "weightKg"]);

    expect(
      payload.paths["/meal-groups/reorder"]?.post.requestBody.content["application/json"].schema.anyOf,
    ).toEqual(expect.arrayContaining([{ required: ["orderedIds"] }, { required: ["groupIds"] }]));

    expect(payload.paths["/foods/search"]?.get.parameters).toEqual([
      expect.objectContaining({ name: "q", in: "query" }),
    ]);
    expect(Object.keys(payload.paths)).not.toContain("/api/v1/goals");

    for (const endpoint of API_V1_ENDPOINTS) {
      for (const method of endpoint.methods) {
        if (method.method === "post" || method.method === "patch") {
          expect(
            payload.paths[endpoint.path][method.method].requestBody,
            `${method.method.toUpperCase()} ${endpoint.path}`,
          ).toBeTruthy();
        }
      }
    }

    for (const endpoint of API_V1_ENDPOINTS) {
      expect(payload.paths[endpoint.path]).toBeTruthy();
      for (const method of endpoint.methods) {
        expect(payload.paths[endpoint.path][method.method]).toMatchObject({
          summary: method.summary,
          security: method.scopes.length
            ? [{ bearerAuth: [] }]
            : [],
        });
        if (method.scopes.length) {
          expect(payload.paths[endpoint.path][method.method]["x-required-scopes"]).toEqual(
            method.scopes,
          );
        } else {
          expect(payload.paths[endpoint.path][method.method]["x-required-scopes"]).toBeUndefined();
        }
      }
    }
  });

  it("passes leaderboard reference dates through the API", async () => {
    for (const [date, label] of [
      ["2026-03-18", "Protein bowl"],
      ["2026-03-19", "Rice bowl"],
      ["2026-03-20", "Yogurt"],
    ] as const) {
      await createMealEntry(
        userId,
        {
          date,
          mealGroupId: null,
          status: "eaten",
          label,
          proteinG: 25,
          carbsG: 45,
          fatG: 10,
          caloriesKcal: 420,
        },
        runtime.db,
      );
    }

    const current = await apiRequest("GET", "/leaderboard?date=2026-03-20", { token: fullToken });
    await expect(current.json()).resolves.toMatchObject({
      ok: true,
      data: {
        currentStreak: 3,
        longestStreak: 3,
      },
    });

    const missed = await apiRequest("GET", "/leaderboard?date=2026-03-22", { token: fullToken });
    await expect(missed.json()).resolves.toMatchObject({
      ok: true,
      data: {
        currentStreak: 0,
        longestStreak: 3,
      },
    });
  });
});
