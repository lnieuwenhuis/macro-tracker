import { API_SCOPE_VALUES, type ApiScope } from "@macro-tracker/db";

type ApiRequestBodyKey =
  | "date"
  | "foodMutation"
  | "foodPatch"
  | "goalPatch"
  | "mealEntryCreate"
  | "mealEntryPatch"
  | "mealEntryStatus"
  | "mealGroup"
  | "recipeLog"
  | "recipeMutation"
  | "reorderMealGroups"
  | "templateFromDay"
  | "templateMutation"
  | "weightEntry"
  | "weightEntryPatch"
  | "weightGoal";

type ApiEndpointMethod = {
  method: "get" | "post" | "patch" | "delete";
  summary: string;
  scopes: ApiScope[];
  successStatus?: 200 | 201;
  requestBody?: ApiRequestBodyKey;
  hasConflictResponse?: boolean;
};

type ApiEndpoint = {
  path: string;
  methods: ApiEndpointMethod[];
};

export const API_V1_ENDPOINTS: ApiEndpoint[] = [
  {
    path: "/me",
    methods: [{ method: "get", summary: "Read the authenticated account and goals", scopes: ["read:account", "read:goals"] }],
  },
  {
    path: "/goals",
    methods: [
      { method: "get", summary: "Read macro goals", scopes: ["read:goals"] },
      { method: "patch", summary: "Update macro goals", scopes: ["write:goals", "read:goals"], requestBody: "goalPatch" },
    ],
  },
  {
    path: "/days/{date}",
    methods: [{ method: "get", summary: "Read a daily log", scopes: ["read:daily"] }],
  },
  {
    path: "/days/{date}/entries",
    methods: [{ method: "post", summary: "Create a meal entry on a date", scopes: ["write:daily"], successStatus: 201, requestBody: "mealEntryCreate" }],
  },
  {
    path: "/meal-entries/{id}",
    methods: [
      { method: "patch", summary: "Update a meal entry", scopes: ["write:daily", "read:daily"], requestBody: "mealEntryPatch" },
      { method: "delete", summary: "Delete a meal entry", scopes: ["write:daily"] },
    ],
  },
  {
    path: "/meal-entries/{id}/status",
    methods: [{ method: "patch", summary: "Update a meal entry status", scopes: ["write:daily", "read:daily"], requestBody: "mealEntryStatus" }],
  },
  {
    path: "/meal-groups",
    methods: [
      { method: "get", summary: "List meal groups", scopes: ["read:daily"] },
      { method: "post", summary: "Create a meal group", scopes: ["write:daily"], successStatus: 201, requestBody: "mealGroup" },
    ],
  },
  {
    path: "/meal-groups/{id}",
    methods: [
      { method: "patch", summary: "Update a meal group", scopes: ["write:daily"], requestBody: "mealGroup" },
      { method: "delete", summary: "Delete a meal group", scopes: ["write:daily"] },
    ],
  },
  {
    path: "/meal-groups/reorder",
    methods: [{ method: "post", summary: "Reorder meal groups", scopes: ["write:daily"], requestBody: "reorderMealGroups" }],
  },
  {
    path: "/foods/search",
    methods: [{ method: "get", summary: "Search food products", scopes: ["read:foods"] }],
  },
  {
    path: "/foods",
    methods: [{ method: "post", summary: "Create a personal food product", scopes: ["write:foods"], successStatus: 201, requestBody: "foodMutation" }],
  },
  {
    path: "/foods/{id}",
    methods: [{ method: "patch", summary: "Update a personal food product", scopes: ["write:foods", "read:foods"], requestBody: "foodPatch" }],
  },
  {
    path: "/barcodes/{barcode}",
    methods: [{ method: "get", summary: "Lookup a barcode food product", scopes: ["read:foods"] }],
  },
  {
    path: "/templates",
    methods: [
      { method: "get", summary: "List meal templates", scopes: ["read:templates"] },
      { method: "post", summary: "Create a meal template", scopes: ["write:templates"], successStatus: 201, requestBody: "templateMutation" },
    ],
  },
  {
    path: "/templates/{id}",
    methods: [
      { method: "get", summary: "Read a meal template", scopes: ["read:templates"] },
      { method: "patch", summary: "Update a meal template", scopes: ["write:templates"], requestBody: "templateMutation" },
      { method: "delete", summary: "Delete a meal template", scopes: ["write:templates"] },
    ],
  },
  {
    path: "/templates/{id}/apply",
    methods: [{ method: "post", summary: "Apply a template to a date", scopes: ["read:templates", "write:daily"], successStatus: 201, requestBody: "date" }],
  },
  {
    path: "/templates/from-day",
    methods: [{ method: "post", summary: "Create a template from a day", scopes: ["read:daily", "write:templates"], successStatus: 201, requestBody: "templateFromDay" }],
  },
  {
    path: "/recipes",
    methods: [
      { method: "get", summary: "List recipes", scopes: ["read:recipes"] },
      { method: "post", summary: "Create a recipe", scopes: ["write:recipes"], successStatus: 201, requestBody: "recipeMutation" },
    ],
  },
  {
    path: "/recipes/{id}",
    methods: [
      { method: "get", summary: "Read a recipe", scopes: ["read:recipes"] },
      { method: "patch", summary: "Update a recipe", scopes: ["write:recipes"], requestBody: "recipeMutation" },
      { method: "delete", summary: "Delete a recipe", scopes: ["write:recipes"] },
    ],
  },
  {
    path: "/recipes/{id}/log",
    methods: [{ method: "post", summary: "Log a recipe portion", scopes: ["read:recipes", "write:daily"], successStatus: 201, requestBody: "recipeLog" }],
  },
  {
    path: "/weight",
    methods: [{ method: "get", summary: "Read weight entries and progress", scopes: ["read:weight"] }],
  },
  {
    path: "/weight/entries",
    methods: [
      { method: "get", summary: "List weight entries", scopes: ["read:weight"] },
      { method: "post", summary: "Create a weight entry", scopes: ["write:weight"], successStatus: 201, requestBody: "weightEntry", hasConflictResponse: true },
    ],
  },
  {
    path: "/weight/entries/{id}",
    methods: [
      { method: "patch", summary: "Update a weight entry", scopes: ["write:weight", "read:weight"], requestBody: "weightEntryPatch", hasConflictResponse: true },
      { method: "delete", summary: "Delete a weight entry", scopes: ["write:weight"] },
    ],
  },
  {
    path: "/weight/goal",
    methods: [
      { method: "get", summary: "Read the weight goal", scopes: ["read:weight"] },
      { method: "patch", summary: "Update the weight goal", scopes: ["write:weight"], requestBody: "weightGoal" },
    ],
  },
  {
    path: "/stats",
    methods: [{ method: "get", summary: "Read stats", scopes: ["read:stats", "read:weight", "read:goals"] }],
  },
  {
    path: "/summary",
    methods: [
      {
        method: "get",
        summary: "Read dashboard summary data",
        scopes: ["read:stats", "read:daily", "read:goals", "read:weight"],
      },
    ],
  },
  {
    path: "/leaderboard",
    methods: [{ method: "get", summary: "Read personal leaderboard stats", scopes: ["read:stats"] }],
  },
  {
    path: "/openapi.json",
    methods: [{ method: "get", summary: "Read the OpenAPI document", scopes: [] }],
  },
];

export type ApiV1RouterMethod = Uppercase<ApiEndpointMethod["method"]>;

export type ApiV1EndpointMatch = {
  endpoint: ApiEndpoint;
  method: ApiEndpointMethod;
};

function apiMethodToRouterMethod(method: ApiEndpointMethod["method"]): ApiV1RouterMethod {
  return method.toUpperCase() as ApiV1RouterMethod;
}

function splitEndpointPath(path: string) {
  return path.replace(/^\//, "").split("/").filter(Boolean);
}

function endpointPathMatches(endpointPath: string, path: string[]) {
  const endpointSegments = splitEndpointPath(endpointPath);
  if (endpointSegments.length !== path.length) {
    return false;
  }

  return endpointSegments.every((segment, index) => {
    return segment.startsWith("{") && segment.endsWith("}")
      ? Boolean(path[index])
      : segment === path[index];
  });
}

function endpointPathSpecificity(endpointPath: string) {
  return splitEndpointPath(endpointPath).filter(
    (segment) => !(segment.startsWith("{") && segment.endsWith("}")),
  ).length;
}

function getMatchingEndpoint(path: string[]) {
  return API_V1_ENDPOINTS
    .filter((candidate) => endpointPathMatches(candidate.path, path))
    .sort(
      (a, b) =>
        endpointPathSpecificity(b.path) - endpointPathSpecificity(a.path),
    )[0] ?? null;
}

export function getApiV1EndpointMatch(
  method: ApiV1RouterMethod,
  path: string[],
): ApiV1EndpointMatch | null {
  const endpoint = getMatchingEndpoint(path);
  if (!endpoint) {
    return null;
  }

  const endpointMethod = endpoint.methods.find(
    (candidate) => apiMethodToRouterMethod(candidate.method) === method,
  );
  return endpointMethod ? { endpoint, method: endpointMethod } : null;
}

export function getApiV1AllowedMethods(path: string[]): ApiV1RouterMethod[] {
  const endpoint = getMatchingEndpoint(path);
  if (!endpoint) {
    return [];
  }

  return endpoint.methods.map((method) => apiMethodToRouterMethod(method.method));
}

export function isKnownApiV1Path(path: string[]) {
  return API_V1_ENDPOINTS.some((endpoint) => endpointPathMatches(endpoint.path, path));
}

function responseSchema() {
  return {
    "application/json": {
      schema: {
        oneOf: [
          {
            type: "object",
            required: ["ok", "data"],
            properties: {
              ok: { const: true },
              data: {},
            },
          },
          {
            type: "object",
            required: ["ok", "error"],
            properties: {
              ok: { const: false },
              error: {
                type: "object",
                required: ["code", "message"],
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        ],
      },
    },
  };
}

function jsonRequestBody(schema: Record<string, unknown>) {
  return {
    required: true,
    content: {
      "application/json": {
        schema,
      },
    },
  };
}

function pathParameter(name: string) {
  return {
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  };
}

function queryParameter(name: string) {
  return {
    name,
    in: "query",
    required: false,
    schema: { type: "string" },
  };
}

const foodMutationSchema = {
  type: "object",
  required: ["name", "proteinPer100", "carbsPer100", "fatPer100", "caloriesPer100"],
  properties: {
    name: { type: "string" },
    brand: { type: ["string", "null"] },
    barcode: { type: ["string", "null"] },
    defaultServingQuantity: { type: "number", exclusiveMinimum: 0 },
    defaultServingUnit: { type: "string" },
    proteinPer100: { type: "number", minimum: 0 },
    carbsPer100: { type: "number", minimum: 0 },
    fatPer100: { type: "number", minimum: 0 },
    caloriesPer100: { type: "integer", minimum: 0 },
    servingWeightG: { type: ["number", "null"], exclusiveMinimum: 0 },
    servingVolumeMl: { type: ["number", "null"], exclusiveMinimum: 0 },
  },
  additionalProperties: true,
};

const foodPatchSchema = {
  type: "object",
  properties: foodMutationSchema.properties,
  additionalProperties: true,
};

const macroFields = {
  proteinG: { type: "number", minimum: 0 },
  carbsG: { type: "number", minimum: 0 },
  fatG: { type: "number", minimum: 0 },
  caloriesKcal: { type: "integer", minimum: 0 },
};

const quantityFields = {
  quantity: { type: "number", exclusiveMinimum: 0 },
  unit: { type: "string" },
  servingMultiplier: { type: "number", exclusiveMinimum: 0 },
};

const goalPatchSchema = {
  type: "object",
  properties: {
    caloriesKcal: { type: ["integer", "null"], minimum: 0 },
    proteinG: { type: ["number", "null"], minimum: 0 },
    carbsG: { type: ["number", "null"], minimum: 0 },
    fatG: { type: ["number", "null"], minimum: 0 },
  },
  additionalProperties: true,
};

const mealEntrySchema = {
  type: "object",
  required: ["label", "proteinG", "carbsG", "fatG", "caloriesKcal"],
  properties: {
    date: { type: "string", format: "date" },
    mealGroupId: { type: ["string", "null"] },
    status: { type: "string", enum: ["planned", "eaten", "skipped"] },
    productId: { type: ["string", "null"] },
    label: { type: "string" },
    sortOrder: { type: "integer", minimum: 0 },
    ...quantityFields,
    ...macroFields,
    clientMutationId: { type: ["string", "null"] },
  },
  additionalProperties: true,
};

const mealEntryCreateSchema = {
  type: "object",
  anyOf: [
    { required: mealEntrySchema.required },
    { required: ["productId"], properties: { productId: { type: "string" } } },
  ],
  properties: mealEntrySchema.properties,
  additionalProperties: true,
};

const mealEntryPatchSchema = {
  type: "object",
  properties: mealEntrySchema.properties,
  additionalProperties: true,
};

const mealGroupSchema = {
  type: "object",
  required: ["label"],
  properties: { label: { type: "string" } },
  additionalProperties: true,
};

const mealEntryStatusSchema = {
  type: "object",
  required: ["status"],
  properties: { status: { type: "string", enum: ["planned", "eaten", "skipped"] } },
  additionalProperties: true,
};

const reorderMealGroupsSchema = {
  type: "object",
  anyOf: [{ required: ["orderedIds"] }, { required: ["groupIds"] }],
  properties: {
    orderedIds: { type: "array", items: { type: "string" } },
    groupIds: { type: "array", items: { type: "string" } },
  },
  additionalProperties: true,
};

const templateItemSchema = {
  type: "object",
  required: ["label", "proteinG", "carbsG", "fatG", "caloriesKcal"],
  properties: {
    productId: { type: ["string", "null"] },
    mealGroupLabel: { type: ["string", "null"] },
    label: { type: "string" },
    ...quantityFields,
    ...macroFields,
  },
  additionalProperties: true,
};

const templateMutationSchema = {
  type: "object",
  required: ["type", "label", "items"],
  properties: {
    type: { type: "string", enum: ["meal", "day"] },
    label: { type: "string" },
    notes: { type: ["string", "null"] },
    items: { type: "array", items: templateItemSchema, minItems: 1 },
  },
  additionalProperties: true,
};

const dateSchema = {
  type: "object",
  required: ["date"],
  properties: { date: { type: "string", format: "date" } },
  additionalProperties: true,
};

const templateFromDaySchema = {
  type: "object",
  required: ["date", "type", "label"],
  properties: {
    date: { type: "string", format: "date" },
    type: { type: "string", enum: ["meal", "day"] },
    label: { type: "string" },
  },
  additionalProperties: true,
};

const recipeIngredientSchema = {
  type: "object",
  required: ["label", "proteinG", "carbsG", "fatG", "caloriesKcal"],
  properties: {
    productId: { type: ["string", "null"] },
    label: { type: "string" },
    ...quantityFields,
    ...macroFields,
  },
  additionalProperties: true,
};

const recipeMutationSchema = {
  type: "object",
  required: ["label", "portions", "ingredients"],
  properties: {
    label: { type: "string" },
    portions: { type: "integer", minimum: 1, maximum: 999 },
    totalCookedWeightG: { type: ["number", "null"], exclusiveMinimum: 0 },
    ingredients: { type: "array", items: recipeIngredientSchema, minItems: 1 },
  },
  additionalProperties: true,
};

const recipeLogSchema = {
  type: "object",
  required: ["date"],
  properties: {
    date: { type: "string", format: "date" },
    portionCount: { type: "number", exclusiveMinimum: 0 },
    gramsConsumed: { type: "number", exclusiveMinimum: 0 },
    status: { type: "string", enum: ["planned", "eaten", "skipped"] },
  },
  additionalProperties: true,
};

const weightEntrySchema = {
  type: "object",
  required: ["date", "weightKg"],
  properties: {
    date: { type: "string", format: "date" },
    weightKg: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1000 },
    bodyFatPct: { type: ["number", "null"], minimum: 0, maximum: 100 },
    notes: { type: ["string", "null"] },
  },
  additionalProperties: true,
};

const weightEntryPatchSchema = {
  type: "object",
  properties: weightEntrySchema.properties,
  additionalProperties: true,
};

const weightGoalSchema = {
  type: "object",
  required: ["goalWeightKg"],
  properties: { goalWeightKg: { type: ["number", "null"], exclusiveMinimum: 0, exclusiveMaximum: 1000 } },
  additionalProperties: true,
};

const REQUEST_BODY_SCHEMAS = {
  date: dateSchema,
  foodMutation: foodMutationSchema,
  foodPatch: foodPatchSchema,
  goalPatch: goalPatchSchema,
  mealEntryCreate: mealEntryCreateSchema,
  mealEntryPatch: mealEntryPatchSchema,
  mealEntryStatus: mealEntryStatusSchema,
  mealGroup: mealGroupSchema,
  recipeLog: recipeLogSchema,
  recipeMutation: recipeMutationSchema,
  reorderMealGroups: reorderMealGroupsSchema,
  templateFromDay: templateFromDaySchema,
  templateMutation: templateMutationSchema,
  weightEntry: weightEntrySchema,
  weightEntryPatch: weightEntryPatchSchema,
  weightGoal: weightGoalSchema,
} satisfies Record<ApiRequestBodyKey, Record<string, unknown>>;

function requestBodyFor(requestBody: ApiRequestBodyKey | undefined) {
  return requestBody ? jsonRequestBody(REQUEST_BODY_SCHEMAS[requestBody]) : undefined;
}

function parametersFor(path: string) {
  const parameters = Array.from(path.matchAll(/\{([^}]+)\}/g), (match) =>
    pathParameter(match[1]!),
  );
  if (path === "/foods/search") {
    parameters.push(queryParameter("q"));
  }
  if (["/weight", "/stats", "/summary", "/leaderboard"].includes(path)) {
    parameters.push(queryParameter("date"));
  }
  return parameters.length ? parameters : undefined;
}

export function getApiV1OpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of API_V1_ENDPOINTS) {
    paths[endpoint.path] = Object.fromEntries(
      endpoint.methods.map((method) => {
        const operation: Record<string, unknown> = {
          summary: method.summary,
          security: method.scopes.length
            ? [{ bearerAuth: [] }]
            : [],
          "x-required-scopes": method.scopes.length ? method.scopes : undefined,
          parameters: parametersFor(endpoint.path),
          requestBody: requestBodyFor(method.requestBody),
          responses: {
            [String(method.successStatus ?? 200)]: {
              description: "Successful response",
              content: responseSchema(),
            },
            "400": {
              description: "Invalid request",
              content: responseSchema(),
            },
            "401": {
              description: "Authentication failed",
              content: responseSchema(),
            },
            "403": {
              description: "Insufficient token scope",
              content: responseSchema(),
            },
            "404": {
              description: "Resource not found",
              content: responseSchema(),
            },
            "405": {
              description: "Method not allowed",
              content: responseSchema(),
            },
            ...(method.hasConflictResponse
              ? {
                  "409": {
                    description: "Resource conflict",
                    content: responseSchema(),
                  },
                }
              : {}),
            "500": {
              description: "Internal server error",
              content: responseSchema(),
            },
          },
        };

        if (!operation.parameters) delete operation.parameters;
        if (!operation.requestBody) delete operation.requestBody;
        if (!operation["x-required-scopes"]) delete operation["x-required-scopes"];

        return [method.method, operation];
      }),
    );
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Macro Tracker API",
      version: "1.0.0",
      description: "User-scoped API for normal Macro Tracker objects.",
    },
    servers: [{ url: "/api/v1" }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "mtk_v1 token",
          description: `Personal access token. Available scopes: ${API_SCOPE_VALUES.join(", ")}`,
        },
      },
    },
  };
}
