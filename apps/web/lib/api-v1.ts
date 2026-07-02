import {
  authenticateApiToken,
  createMealEntry,
  createMealGroup,
  createPersonalFoodProduct,
  createRecipe,
  createTemplate,
  createTemplateFromDate,
  createWeightEntryNoOverwrite,
  deleteMealEntry,
  deleteMealGroup,
  deleteRecipe,
  deleteTemplate,
  deleteWeightEntry,
  getDailySummary,
  getFoodProductByIdForUser,
  getLeaderboardStats,
  getMealEntryById,
  getMealGroups,
  getPeriodAverages,
  getRecipeById,
  getRecipes,
  getStatsPageData,
  getTemplateById,
  getTemplates,
  getUserById,
  getUserGoals,
  getWeightEntries,
  getWeightGoal,
  getWeightPageData,
  isMealEntryStatus,
  isValidDateString,
  lookupBarcodeFoodProduct,
  MealEntryValidationError,
  markMealEntryStatus,
  applyTemplateToDate,
  RecipeValidationError,
  reorderMealGroups,
  saveUserGoals,
  saveWeightGoal,
  searchFoodProducts,
  todayDateString,
  updateMealEntry,
  updateMealGroup,
  updatePersonalFoodProduct,
  updateRecipe,
  updateTemplate,
  updateWeightEntry,
  type ApiScope,
  type FoodProduct,
  type FoodProductInput,
  type MacroGoals,
  WeightEntryValidationError,
} from "@macro-tracker/db";
import { NextResponse } from "next/server";

import {
  getApiV1AllowedMethods,
  getApiV1EndpointMatch,
  getApiV1OpenApi,
  isKnownApiV1Path,
} from "./api-v1-openapi";
import { buildRecipePortionMealEntryInput } from "./recipe-portion";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE" | "OPTIONS";

type ApiContext = {
  request: Request;
  method: ApiMethod;
  path: string[];
  url: URL;
  userId: string;
  scopes: readonly ApiScope[];
};

function jsonWithCors(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...CORS_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
}

function ok(data: unknown, status = 200) {
  return jsonWithCors({ ok: true, data }, { status });
}

function emptyOk(data: unknown = {}) {
  return ok(data);
}

function error(status: number, code: string, message: string, init?: ResponseInit) {
  return jsonWithCors({ ok: false, error: { code, message } }, { ...init, status });
}

function methodNotAllowed(path?: string[]) {
  const allowedMethods = path
    ? Array.from(new Set([...getApiV1AllowedMethods(path), "OPTIONS"]))
    : [];
  return error(405, "method_not_allowed", "Method is not allowed for this endpoint.", {
    headers: allowedMethods.length > 0 ? { Allow: allowedMethods.join(", ") } : undefined,
  });
}

function conflict(code: string, message: string) {
  return error(409, code, message);
}

function notFound(message = "API endpoint not found.") {
  return error(404, "not_found", message);
}

function badRequest(message: string) {
  return error(400, "bad_request", message);
}

function insufficientScope(scope: ApiScope) {
  return error(
    403,
    "insufficient_scope",
    `API token is missing required scope: ${scope}.`,
  );
}

const UUID_PATH_PARAM_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuidPathParam(value: string) {
  if (!UUID_PATH_PARAM_PATTERN.test(value)) {
    throw new Error("Path parameter must be a valid UUID.");
  }

  return value;
}

function getBearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    return { ok: false as const, reason: "missing" as const };
  }

  const parts = authorization.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer") {
    return { ok: false as const, reason: "malformed" as const };
  }

  return { ok: true as const, token: parts[1]! };
}

function authErrorMessage(reason: "missing" | "malformed" | "invalid" | "expired" | "revoked") {
  switch (reason) {
    case "missing":
      return ["missing_token", "Missing bearer token."] as const;
    case "malformed":
      return ["malformed_token", "Authorization must use Bearer <token>."] as const;
    case "expired":
      return ["expired_token", "API token has expired."] as const;
    case "revoked":
      return ["revoked_token", "API token has been revoked."] as const;
    case "invalid":
    default:
      return ["invalid_token", "API token is invalid."] as const;
  }
}

async function authenticateRequest(request: Request, scopes: ApiScope[]) {
  const bearer = getBearerToken(request);
  if (!bearer.ok) {
    const [code, message] = authErrorMessage(bearer.reason);
    return { ok: false as const, response: error(401, code, message) };
  }

  const auth = await authenticateApiToken(bearer.token);
  if (!auth.ok) {
    const [code, message] = authErrorMessage(auth.reason);
    return { ok: false as const, response: error(401, code, message) };
  }

  const owner = await getUserById(auth.token.userId);
  if (!owner) {
    return { ok: false as const, response: error(401, "invalid_token", "API token is invalid.") };
  }

  if (!owner.onboardingCompletedAt) {
    return {
      ok: false as const,
      response: error(403, "onboarding_required", "Complete onboarding before using API tokens."),
    };
  }

  const missingScope = scopes.find((scope) => !auth.token.scopes.includes(scope));
  if (missingScope) {
    return {
      ok: false as const,
      response: insufficientScope(missingScope),
    };
  }

  return { ok: true as const, userId: auth.token.userId, scopes: auth.token.scopes };
}

async function readJson(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function requireDate(value: string | undefined) {
  if (!value || !isValidDateString(value)) {
    throw new Error("Date must use YYYY-MM-DD.");
  }

  return value;
}

function requireRecord(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body is required.");
  }

  return body as Record<string, unknown>;
}

function requireStringField(record: Record<string, unknown>, key: string, message: string) {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(message);
  }
  return value;
}

function requireArrayField(record: Record<string, unknown>, key: string, message: string) {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new Error(message);
  }
  return value;
}

function requireMealGroupBody(body: unknown) {
  const record = requireRecord(body);
  requireStringField(record, "label", "Meal group name is required.");
  return record;
}

function requireMealEntryBody(body: unknown) {
  return requireRecord(body);
}

async function mergeMealEntryPatchBody(userId: string, entryId: string, body: unknown) {
  const patch = requireMealEntryBody(body);
  if ("date" in patch) {
    patch.date = requireDate(typeof patch.date === "string" ? patch.date : undefined);
  }
  const existing = await getMealEntryById(userId, entryId);
  if (!existing) {
    throw new Error("Meal entry not found.");
  }

  const recalculateProductMacros = [
    "productId",
    "quantity",
    "unit",
    "servingMultiplier",
    "proteinG",
    "carbsG",
    "fatG",
    "caloriesKcal",
  ].some((key) => key in patch);

  return {
    body: { ...existing, ...patch },
    recalculateProductMacros,
  };
}

function requireTemplateBody(body: unknown) {
  const record = requireRecord(body);
  requireStringField(record, "label", "Template name is required.");
  requireStringField(record, "type", "Template type is invalid.");
  const items = requireArrayField(record, "items", "A template must include at least one item.");
  for (const item of items) {
    const itemRecord = requireRecord(item);
    requireStringField(itemRecord, "label", "Meal name is required.");
  }
  return record;
}

function requireTemplateFromDayBody(body: unknown) {
  const record = requireBodyDate(body);
  requireStringField(record, "label", "Template name is required.");
  requireStringField(record, "type", "Template type is invalid.");
  return record;
}

function requireRecipeBody(body: unknown) {
  const record = requireRecord(body);
  requireStringField(record, "label", "Recipe name is required.");
  const ingredients = requireArrayField(record, "ingredients", "A recipe must have at least one ingredient.");
  for (const ingredient of ingredients) {
    const ingredientRecord = requireRecord(ingredient);
    requireStringField(ingredientRecord, "label", "Ingredient name is required.");
  }
  return record;
}

function requireBodyDate(body: unknown) {
  const record = requireRecord(body);
  return {
    ...record,
    date: requireDate(typeof record.date === "string" ? record.date : undefined),
  };
}

function mergeGoalField(
  record: Record<string, unknown>,
  key: keyof MacroGoals,
  currentValue: number | null,
) {
  if (!(key in record)) return currentValue;

  const value = record[key];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be null or a finite non-negative number.`);
  }
  if (key === "caloriesKcal" && !Number.isInteger(value)) {
    throw new Error("caloriesKcal must be an integer.");
  }

  return value;
}

function getGoalWeightKg(body: unknown) {
  const record = requireRecord(body);
  if (!("goalWeightKg" in record)) {
    throw new Error("goalWeightKg is required.");
  }

  const value = record.goalWeightKg;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("goalWeightKg must be null or a finite positive number.");
  }
  if (value >= 1000) {
    throw new Error("goalWeightKg must be less than 1000 kg.");
  }

  return Math.round(value * 100) / 100;
}

function getReferenceDate(url: URL) {
  const date = url.searchParams.get("date");
  if (date == null) {
    return todayDateString();
  }
  if (!isValidDateString(date)) {
    throw new Error("Date must use YYYY-MM-DD.");
  }

  return date;
}

function getOrderedGroupIds(body: unknown) {
  if (!body || typeof body !== "object") {
    throw new Error("Request body is required.");
  }

  const record = body as Record<string, unknown>;
  const ids = record.orderedIds ?? record.groupIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new Error("orderedIds must be an array of group IDs.");
  }

  return ids;
}

function sanitizeApiFoodInput(body: unknown): FoodProductInput {
  const record = requireRecord(body);
  requireStringField(record, "name", "Product name is required.");

  return {
    name: record.name as FoodProductInput["name"],
    brand: record.brand as FoodProductInput["brand"],
    barcode: record.barcode as FoodProductInput["barcode"],
    defaultServingQuantity: record.defaultServingQuantity as FoodProductInput["defaultServingQuantity"],
    defaultServingUnit: record.defaultServingUnit as FoodProductInput["defaultServingUnit"],
    proteinPer100: record.proteinPer100 as FoodProductInput["proteinPer100"],
    carbsPer100: record.carbsPer100 as FoodProductInput["carbsPer100"],
    fatPer100: record.fatPer100 as FoodProductInput["fatPer100"],
    caloriesPer100: record.caloriesPer100 as FoodProductInput["caloriesPer100"],
    servingWeightG: record.servingWeightG as FoodProductInput["servingWeightG"],
    servingVolumeMl: record.servingVolumeMl as FoodProductInput["servingVolumeMl"],
    scope: "personal",
    source: "manual",
  };
}

function mergeFoodPatchInput(existing: FoodProduct, body: unknown): FoodProductInput {
  const patch = requireRecord(body);
  return sanitizeApiFoodInput({
    name: "name" in patch ? patch.name : existing.name,
    brand: "brand" in patch ? patch.brand : existing.brand,
    barcode: "barcode" in patch ? patch.barcode : existing.barcode,
    defaultServingQuantity:
      "defaultServingQuantity" in patch
        ? patch.defaultServingQuantity
        : existing.defaultServingQuantity,
    defaultServingUnit:
      "defaultServingUnit" in patch ? patch.defaultServingUnit : existing.defaultServingUnit,
    proteinPer100: "proteinPer100" in patch ? patch.proteinPer100 : existing.proteinPer100,
    carbsPer100: "carbsPer100" in patch ? patch.carbsPer100 : existing.carbsPer100,
    fatPer100: "fatPer100" in patch ? patch.fatPer100 : existing.fatPer100,
    caloriesPer100:
      "caloriesPer100" in patch ? patch.caloriesPer100 : existing.caloriesPer100,
    servingWeightG: "servingWeightG" in patch ? patch.servingWeightG : existing.servingWeightG,
    servingVolumeMl:
      "servingVolumeMl" in patch ? patch.servingVolumeMl : existing.servingVolumeMl,
  });
}

async function mergeWeightEntryPatchBody(userId: string, entryId: string, body: unknown) {
  const patch = requireRecord(body);
  if ("date" in patch) {
    patch.date = requireDate(typeof patch.date === "string" ? patch.date : undefined);
  }
  const existing = (await getWeightEntries(userId)).find((entry) => entry.id === entryId);
  if (!existing) {
    throw new Error("Weight entry not found.");
  }

  return {
    date: "date" in patch ? patch.date : existing.date,
    weightKg: "weightKg" in patch ? patch.weightKg : existing.weightKg,
    bodyFatPct: "bodyFatPct" in patch ? patch.bodyFatPct : existing.bodyFatPct,
    notes: "notes" in patch ? patch.notes : existing.notes,
  };
}

function mergeGoals(current: MacroGoals, body: unknown): MacroGoals {
  const record = requireRecord(body);
  return {
    caloriesKcal: mergeGoalField(record, "caloriesKcal", current.caloriesKcal),
    proteinG: mergeGoalField(record, "proteinG", current.proteinG),
    carbsG: mergeGoalField(record, "carbsG", current.carbsG),
    fatG: mergeGoalField(record, "fatG", current.fatG),
  };
}

async function logRecipePortion(
  userId: string,
  recipeId: string,
  body: Record<string, unknown>,
) {
  const date = requireDate(typeof body.date === "string" ? body.date : undefined);
  const recipe = await getRecipeById(userId, recipeId);
  if (!recipe) {
    throw new Error("Recipe not found.");
  }

  const portionCount = "portionCount" in body ? body.portionCount : 1;
  if (typeof portionCount !== "number" || !Number.isFinite(portionCount) || portionCount <= 0) {
    throw new Error("portionCount must be a finite positive number.");
  }
  let gramsConsumed: number | null = null;
  if ("gramsConsumed" in body) {
    const value = body.gramsConsumed;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error("gramsConsumed must be a finite positive number.");
    }
    gramsConsumed = value;
  }
  const status = "status" in body ? body.status : date > todayDateString() ? "planned" : "eaten";
  if (typeof status !== "string" || !isMealEntryStatus(status)) {
    throw new Error("Meal status is invalid.");
  }

  return createMealEntry(
    userId,
    buildRecipePortionMealEntryInput({
      date,
      gramsConsumed,
      portionCount,
      recipe,
      status,
      today: todayDateString(),
    }),
  );
}

function mapAccount(user: Awaited<ReturnType<typeof getUserById>>) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    pictureUrl: user.pictureUrl,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    onboardingCompletedAt: user.onboardingCompletedAt,
    preferredWeightUnit: user.preferredWeightUnit,
  };
}

function mapFoodProductForApi(product: FoodProduct) {
  return {
    id: product.id,
    scope: product.scope,
    source: product.source,
    barcode: product.barcode,
    name: product.name,
    brand: product.brand,
    defaultServingQuantity: product.defaultServingQuantity,
    defaultServingUnit: product.defaultServingUnit,
    proteinPer100: product.proteinPer100,
    carbsPer100: product.carbsPer100,
    fatPer100: product.fatPer100,
    caloriesPer100: product.caloriesPer100,
    servingWeightG: product.servingWeightG,
    servingVolumeMl: product.servingVolumeMl,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
    deletedAt: product.deletedAt,
  };
}

async function dispatchApiRequest(ctx: ApiContext) {
  if (ctx.path.length > 3) return notFound();

  const [resource, id, action] = ctx.path;

  if (resource === "me" && !id) {
    if (ctx.method !== "GET") return methodNotAllowed(ctx.path);
    const [user, goals] = await Promise.all([
      getUserById(ctx.userId),
      getUserGoals(ctx.userId),
    ]);
    return ok({ user: mapAccount(user), goals });
  }

  if (resource === "goals" && !id) {
    if (ctx.method === "GET") {
      return ok(await getUserGoals(ctx.userId));
    }
    if (ctx.method === "PATCH") {
      const current = await getUserGoals(ctx.userId);
      const goals = mergeGoals(current, await readJson(ctx.request));
      await saveUserGoals(ctx.userId, goals);
      return ok(await getUserGoals(ctx.userId));
    }
    return methodNotAllowed(ctx.path);
  }

  if (resource === "days") {
    const date = requireDate(id);
    if (!action && ctx.method === "GET") {
      return ok(await getDailySummary(ctx.userId, date));
    }
    if (action === "entries" && ctx.method === "POST") {
      const body = requireMealEntryBody(await readJson(ctx.request));
      if ("productId" in body && body.productId && !ctx.scopes.includes("read:foods")) {
        return insufficientScope("read:foods");
      }
      return ok(await createMealEntry(ctx.userId, { ...(body as object), date } as never), 201);
    }
    return methodNotAllowed(ctx.path);
  }

  if (resource === "meal-entries" && id) {
    const entryId = requireUuidPathParam(id);
    if (!action && ctx.method === "PATCH") {
      const rawBody = await readJson(ctx.request);
      const patch = requireMealEntryBody(rawBody);
      if ("productId" in patch && patch.productId && !ctx.scopes.includes("read:foods")) {
        return insufficientScope("read:foods");
      }
      const { body, recalculateProductMacros } = await mergeMealEntryPatchBody(
        ctx.userId,
        entryId,
        patch,
      );
      return ok(
        await updateMealEntry(ctx.userId, entryId, body as never, undefined, {
          recalculateProductMacros,
        }),
      );
    }
    if (!action && ctx.method === "DELETE") {
      const deleted = await deleteMealEntry(ctx.userId, entryId);
      if (!deleted) return notFound("Meal entry not found.");
      return emptyOk({ deleted: true });
    }
    if (action === "status" && ctx.method === "PATCH") {
      const body = requireRecord(await readJson(ctx.request));
      if (typeof body.status !== "string" || !isMealEntryStatus(body.status)) {
        return badRequest("Meal status is invalid.");
      }
      return ok(await markMealEntryStatus(ctx.userId, entryId, body.status));
    }
    return methodNotAllowed(ctx.path);
  }

  if (resource === "meal-groups") {
    if (!id && ctx.method === "GET") {
      return ok(await getMealGroups(ctx.userId));
    }
    if (!id && ctx.method === "POST") {
      return ok(await createMealGroup(ctx.userId, requireMealGroupBody(await readJson(ctx.request)) as never), 201);
    }
    if (id === "reorder" && !action && ctx.method === "POST") {
      return ok(await reorderMealGroups(ctx.userId, getOrderedGroupIds(await readJson(ctx.request))));
    }
    if (id === "reorder" && !action) return methodNotAllowed(ctx.path);
    if (id && !action && ctx.method === "PATCH") {
      return ok(await updateMealGroup(ctx.userId, requireUuidPathParam(id), requireMealGroupBody(await readJson(ctx.request)) as never));
    }
    if (id && !action && ctx.method === "DELETE") {
      const deleted = await deleteMealGroup(ctx.userId, requireUuidPathParam(id));
      if (!deleted) return notFound("Meal group not found.");
      return emptyOk({ deleted: true });
    }
    return methodNotAllowed(ctx.path);
  }

  if (resource === "foods") {
    if (id === "search" && !action && ctx.method === "GET") {
      const products = await searchFoodProducts(ctx.userId, ctx.url.searchParams.get("q") ?? "");
      return ok(products.map(mapFoodProductForApi));
    }
    if (id === "search" && !action) return methodNotAllowed(ctx.path);
    if (!id && ctx.method === "POST") {
      const product = await createPersonalFoodProduct(
        ctx.userId,
        sanitizeApiFoodInput(await readJson(ctx.request)),
      );
      return ok(mapFoodProductForApi(product), 201);
    }
    if (id && !action && ctx.method === "PATCH") {
      const productId = requireUuidPathParam(id);
      const existing = await getFoodProductByIdForUser(ctx.userId, productId);
      if (!existing || existing.ownerUserId !== ctx.userId || existing.scope !== "personal") {
        return notFound("Food product not found.");
      }
      const product = await updatePersonalFoodProduct(
        ctx.userId,
        productId,
        mergeFoodPatchInput(existing, await readJson(ctx.request)),
      );
      return ok(mapFoodProductForApi(product));
    }
    return methodNotAllowed(ctx.path);
  }

  if (resource === "barcodes" && id && !action) {
    if (ctx.method !== "GET") return methodNotAllowed(ctx.path);
    const product = await lookupBarcodeFoodProduct(decodeURIComponent(id));
    return ok(product ? mapFoodProductForApi(product) : null);
  }

  if (resource === "templates") {
    if (id === "from-day" && !action && ctx.method === "POST") {
      return ok(await createTemplateFromDate(ctx.userId, requireTemplateFromDayBody(await readJson(ctx.request)) as never), 201);
    }
    if (id === "from-day" && !action) return methodNotAllowed(ctx.path);
    if (!id && ctx.method === "GET") {
      return ok(await getTemplates(ctx.userId));
    }
    if (!id && ctx.method === "POST") {
      return ok(await createTemplate(ctx.userId, requireTemplateBody(await readJson(ctx.request)) as never), 201);
    }
    if (id && action === "apply" && ctx.method === "POST") {
      return ok(await applyTemplateToDate(ctx.userId, { templateId: requireUuidPathParam(id), ...requireBodyDate(await readJson(ctx.request)) } as never), 201);
    }
    if (id && !action && ctx.method === "GET") {
      const template = await getTemplateById(ctx.userId, requireUuidPathParam(id));
      if (!template) return notFound("Template not found.");
      return ok(template);
    }
    if (id && !action && ctx.method === "PATCH") {
      return ok(await updateTemplate(ctx.userId, requireUuidPathParam(id), requireTemplateBody(await readJson(ctx.request)) as never));
    }
    if (id && !action && ctx.method === "DELETE") {
      const deleted = await deleteTemplate(ctx.userId, requireUuidPathParam(id));
      if (!deleted) return notFound("Template not found.");
      return emptyOk({ deleted: true });
    }
    return methodNotAllowed(ctx.path);
  }

  if (resource === "recipes") {
    if (!id && ctx.method === "GET") {
      return ok(await getRecipes(ctx.userId));
    }
    if (!id && ctx.method === "POST") {
      return ok(await createRecipe(ctx.userId, requireRecipeBody(await readJson(ctx.request)) as never), 201);
    }
    if (id && action === "log" && ctx.method === "POST") {
      return ok(await logRecipePortion(ctx.userId, requireUuidPathParam(id), requireRecord(await readJson(ctx.request))), 201);
    }
    if (id && !action && ctx.method === "GET") {
      const recipe = await getRecipeById(ctx.userId, requireUuidPathParam(id));
      if (!recipe) return notFound("Recipe not found.");
      return ok(recipe);
    }
    if (id && !action && ctx.method === "PATCH") {
      return ok(await updateRecipe(ctx.userId, requireUuidPathParam(id), requireRecipeBody(await readJson(ctx.request)) as never));
    }
    if (id && !action && ctx.method === "DELETE") {
      const deleted = await deleteRecipe(ctx.userId, requireUuidPathParam(id));
      if (!deleted) return notFound("Recipe not found.");
      return emptyOk({ deleted: true });
    }
    return methodNotAllowed(ctx.path);
  }

  if (resource === "weight") {
    if (!id && ctx.method === "GET") {
      return ok(await getWeightPageData(ctx.userId, getReferenceDate(ctx.url)));
    }
    if (id === "entries" && !action && ctx.method === "POST") {
      const body = requireBodyDate(await readJson(ctx.request));
      const created = await createWeightEntryNoOverwrite(ctx.userId, body as never);
      if (!created) {
        return conflict(
          "weight_entry_date_conflict",
          "A weight entry already exists for this date.",
        );
      }
      return ok(created, 201);
    }
    if (id === "entries" && action && ctx.method === "PATCH") {
      const entryId = requireUuidPathParam(action);
      const mergedBody = await mergeWeightEntryPatchBody(
        ctx.userId,
        entryId,
        await readJson(ctx.request),
      );
      const updated = await updateWeightEntry(ctx.userId, entryId, mergedBody as never);
      if (!updated) return notFound("Weight entry not found.");
      return ok(updated);
    }
    if (id === "entries" && action && ctx.method === "DELETE") {
      const deleted = await deleteWeightEntry(ctx.userId, requireUuidPathParam(action));
      if (!deleted) return notFound("Weight entry not found.");
      return emptyOk({ deleted: true });
    }
    if (id === "goal" && !action && ctx.method === "GET") {
      return ok({ goalWeightKg: await getWeightGoal(ctx.userId) });
    }
    if (id === "goal" && !action && ctx.method === "PATCH") {
      await saveWeightGoal(ctx.userId, getGoalWeightKg(await readJson(ctx.request)));
      return ok({ goalWeightKg: await getWeightGoal(ctx.userId) });
    }
    if (id === "entries" && !action && ctx.method === "GET") {
      return ok(await getWeightEntries(ctx.userId));
    }
    return methodNotAllowed(ctx.path);
  }

  if (resource === "stats" && !id) {
    if (ctx.method !== "GET") return methodNotAllowed(ctx.path);
    return ok(await getStatsPageData(ctx.userId, getReferenceDate(ctx.url)));
  }

  if (resource === "summary" && !id) {
    if (ctx.method !== "GET") return methodNotAllowed(ctx.path);
    const date = getReferenceDate(ctx.url);
    const [dailySummary, periodAverages, goals, stats] = await Promise.all([
      getDailySummary(ctx.userId, date),
      getPeriodAverages(ctx.userId, date),
      getUserGoals(ctx.userId),
      getStatsPageData(ctx.userId, date),
    ]);
    return ok({ date, dailySummary, periodAverages, goals, stats });
  }

  if (resource === "leaderboard" && !id) {
    if (ctx.method !== "GET") return methodNotAllowed(ctx.path);
    return ok(await getLeaderboardStats(ctx.userId, getReferenceDate(ctx.url)));
  }

  return notFound();
}

const SAFE_BAD_REQUEST_MESSAGES = new Set([
  "Request body must be valid JSON.",
  "Date must use YYYY-MM-DD.",
  "Request body is required.",
  "Meal group name is required.",
  "Template name is required.",
  "Template type is invalid.",
  "A template must include at least one item.",
  "Meal name is required.",
  "Product name is required.",
  "Recipe name is required.",
  "A recipe must have at least one ingredient.",
  "Ingredient name is required.",
  "caloriesKcal must be an integer.",
  "goalWeightKg is required.",
  "goalWeightKg must be null or a finite positive number.",
  "goalWeightKg must be less than 1000 kg.",
  "orderedIds must be an array of group IDs.",
  "orderedIds must include each active meal group exactly once.",
  "portionCount must be a finite positive number.",
  "Grams consumed must be greater than 0.",
  "gramsConsumed must be a finite positive number.",
  "Meal status is invalid.",
  "Recipe cooked weight is required to log grams.",
  "Path parameter must be a valid UUID.",
]);

function isPublicValidationError(caught: unknown, message: string) {
  if (
    caught instanceof MealEntryValidationError ||
    caught instanceof RecipeValidationError ||
    caught instanceof WeightEntryValidationError
  ) {
    return true;
  }

  return (
    SAFE_BAD_REQUEST_MESSAGES.has(message) ||
    /^(caloriesKcal|proteinG|carbsG|fatG) must be null or a finite non-negative number\.$/.test(message)
  );
}

function hasErrorProperty(caught: unknown, key: "code" | "constraint", value: string) {
  return Boolean(
    caught &&
      typeof caught === "object" &&
      key in caught &&
      (caught as Record<typeof key, unknown>)[key] === value,
  );
}

function getErrorCause(caught: unknown) {
  if (!caught || typeof caught !== "object" || !("cause" in caught)) return undefined;
  return (caught as { cause?: unknown }).cause;
}

function isWeightEntryDateConflict(caught: unknown): boolean {
  if (hasErrorProperty(caught, "constraint", "weight_entries_user_date_key")) return true;

  const message = caught instanceof Error ? caught.message : "";
  if (message.includes('unique constraint "weight_entries_user_date_key"')) return true;

  const cause = getErrorCause(caught);
  return cause ? isWeightEntryDateConflict(cause) : false;
}

function responseForUnknownError(caught: unknown) {
  const message = caught instanceof Error ? caught.message : "Something went wrong.";
  if (isWeightEntryDateConflict(caught)) {
    return conflict(
      "weight_entry_date_conflict",
      "A weight entry already exists for this date.",
    );
  }
  if (message.toLowerCase().includes("not found")) {
    return notFound(message);
  }
  if (isPublicValidationError(caught, message)) {
    return badRequest(message);
  }

  console.error("Unexpected API v1 error", caught);
  return error(500, "internal_error", "An internal server error occurred.");
}

export async function handleApiV1Request(
  request: Request,
  path: string[] | undefined,
  method = request.method,
) {
  const normalizedMethod = method.toUpperCase() as ApiMethod;
  const normalizedPath = path ?? [];

  if (normalizedMethod === "OPTIONS") {
    return new NextResponse(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  if (normalizedPath[0] === "openapi.json" && normalizedPath.length === 1) {
    if (normalizedMethod !== "GET") return methodNotAllowed(normalizedPath);
    return jsonWithCors(getApiV1OpenApi());
  }

  const endpointMatch = getApiV1EndpointMatch(normalizedMethod, normalizedPath);
  if (!endpointMatch) {
    return isKnownApiV1Path(normalizedPath) ? methodNotAllowed(normalizedPath) : notFound();
  }

  try {
    const auth = await authenticateRequest(request, endpointMatch.method.scopes);
    if (!auth.ok) {
      return auth.response;
    }

    return await dispatchApiRequest({
      request,
      method: normalizedMethod,
      path: normalizedPath,
      url: new URL(request.url),
      userId: auth.userId,
      scopes: auth.scopes,
    });
  } catch (caught) {
    return responseForUnknownError(caught);
  }
}
