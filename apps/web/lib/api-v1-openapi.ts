import type { ApiScope } from "@macro-tracker/db";

type ApiRequestBodyKey =
  | "date"
  | "foodMutation"
  | "foodPatch"
  | "goalPatch"
  | "healthkitSyncAck"
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

type ApiParameterLocation = "path" | "query";

/** Semantic formats the runtime enforces but a bare JSON Schema string cannot express. */
type ApiParameterFormat = "date" | "uuid";

export type ApiParameter = {
  name: string;
  in: ApiParameterLocation;
  required: boolean;
  format?: ApiParameterFormat;
  description?: string;
};

type ApiEndpointMethod = {
  method: "get" | "post" | "patch" | "delete";
  summary: string;
  scopes: ApiScope[];
  conditionalRequiredScopes?: {
    scopes: ApiScope[];
    when: string;
  }[];
  parameters?: ApiParameter[];
  /** True when the operation, or a resource it references in its body, can answer the documented 404. */
  hasNotFoundResponse?: boolean;
  successStatus?: 200 | 201;
  requestBody?: ApiRequestBodyKey;
  hasConflictResponse?: boolean;
};

type ApiEndpoint = {
  path: string;
  methods: ApiEndpointMethod[];
};

const PRODUCT_ID_CONDITIONAL_SCOPES: NonNullable<ApiEndpointMethod["conditionalRequiredScopes"]> = [
  { scopes: ["read:foods"], when: "non-null productId is supplied" },
];

function datePathParameter(): ApiParameter {
  return { name: "date", in: "path", required: true, format: "date" };
}

function uuidPathParameter(name = "id"): ApiParameter {
  return { name, in: "path", required: true, format: "uuid" };
}

/** Every `date` query parameter defaults to the current UTC date; the server never infers a browser timezone. */
function utcReferenceDateParameter(): ApiParameter {
  return {
    name: "date",
    in: "query",
    required: false,
    format: "date",
    description:
      "Reference date in UTC. Defaults to the current UTC date when omitted; there is no browser-timezone inference.",
  };
}

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
    methods: [
      { method: "get", summary: "Read a daily log", scopes: ["read:daily"], parameters: [datePathParameter()] },
    ],
  },
  {
    path: "/days/{date}/entries",
    methods: [
      {
        method: "post",
        summary: "Create a meal entry on a date",
        scopes: ["write:daily"],
        conditionalRequiredScopes: PRODUCT_ID_CONDITIONAL_SCOPES,
        parameters: [datePathParameter()],
        hasNotFoundResponse: true,
        successStatus: 201,
        requestBody: "mealEntryCreate",
      },
    ],
  },
  {
    path: "/meal-entries/{id}",
    methods: [
      {
        method: "patch",
        summary: "Update a meal entry",
        scopes: ["write:daily", "read:daily"],
        conditionalRequiredScopes: PRODUCT_ID_CONDITIONAL_SCOPES,
        parameters: [uuidPathParameter()],
        hasNotFoundResponse: true,
        requestBody: "mealEntryPatch",
        hasConflictResponse: true,
      },
      { method: "delete", summary: "Delete a meal entry", scopes: ["write:daily"], parameters: [uuidPathParameter()], hasNotFoundResponse: true },
    ],
  },
  {
    path: "/meal-entries/{id}/status",
    methods: [{ method: "patch", summary: "Update a meal entry status", scopes: ["write:daily", "read:daily"], parameters: [uuidPathParameter()], hasNotFoundResponse: true, requestBody: "mealEntryStatus" }],
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
      { method: "patch", summary: "Update a meal group", scopes: ["write:daily"], parameters: [uuidPathParameter()], hasNotFoundResponse: true, requestBody: "mealGroup" },
      { method: "delete", summary: "Delete a meal group", scopes: ["write:daily"], parameters: [uuidPathParameter()], hasNotFoundResponse: true },
    ],
  },
  {
    path: "/meal-groups/reorder",
    methods: [{ method: "post", summary: "Reorder meal groups", scopes: ["write:daily"], requestBody: "reorderMealGroups" }],
  },
  {
    path: "/foods/search",
    methods: [{ method: "get", summary: "Search food products", scopes: ["read:foods"], parameters: [{ name: "q", in: "query", required: false }] }],
  },
  {
    path: "/foods",
    methods: [{ method: "post", summary: "Create a personal food product", scopes: ["write:foods"], successStatus: 201, requestBody: "foodMutation" }],
  },
  {
    path: "/foods/{id}",
    methods: [{ method: "patch", summary: "Update a personal food product", scopes: ["write:foods", "read:foods"], parameters: [uuidPathParameter()], hasNotFoundResponse: true, requestBody: "foodPatch" }],
  },
  {
    path: "/barcodes/{barcode}",
    methods: [{ method: "get", summary: "Lookup a barcode food product", scopes: ["read:foods"], parameters: [{ name: "barcode", in: "path", required: true }] }],
  },
  {
    path: "/templates",
    methods: [
      { method: "get", summary: "List meal templates", scopes: ["read:templates"] },
      { method: "post", summary: "Create a meal template", scopes: ["write:templates"], hasNotFoundResponse: true, successStatus: 201, requestBody: "templateMutation" },
    ],
  },
  {
    path: "/templates/{id}",
    methods: [
      { method: "get", summary: "Read a meal template", scopes: ["read:templates"], parameters: [uuidPathParameter()], hasNotFoundResponse: true },
      { method: "patch", summary: "Update a meal template", scopes: ["write:templates"], parameters: [uuidPathParameter()], hasNotFoundResponse: true, requestBody: "templateMutation" },
      { method: "delete", summary: "Delete a meal template", scopes: ["write:templates"], parameters: [uuidPathParameter()], hasNotFoundResponse: true },
    ],
  },
  {
    path: "/templates/{id}/apply",
    methods: [{ method: "post", summary: "Apply a template to a date", scopes: ["read:templates", "write:daily"], parameters: [uuidPathParameter()], hasNotFoundResponse: true, successStatus: 201, requestBody: "date", hasConflictResponse: true }],
  },
  {
    path: "/templates/from-day",
    methods: [{ method: "post", summary: "Create a template from a day", scopes: ["read:daily", "write:templates"], successStatus: 201, requestBody: "templateFromDay" }],
  },
  {
    path: "/recipes",
    methods: [
      { method: "get", summary: "List recipes", scopes: ["read:recipes"] },
      { method: "post", summary: "Create a recipe", scopes: ["write:recipes"], hasNotFoundResponse: true, successStatus: 201, requestBody: "recipeMutation" },
    ],
  },
  {
    path: "/recipes/{id}",
    methods: [
      { method: "get", summary: "Read a recipe", scopes: ["read:recipes"], parameters: [uuidPathParameter()], hasNotFoundResponse: true },
      { method: "patch", summary: "Update a recipe", scopes: ["write:recipes"], parameters: [uuidPathParameter()], hasNotFoundResponse: true, requestBody: "recipeMutation" },
      { method: "delete", summary: "Delete a recipe", scopes: ["write:recipes"], parameters: [uuidPathParameter()], hasNotFoundResponse: true },
    ],
  },
  {
    path: "/recipes/{id}/log",
    methods: [{ method: "post", summary: "Log a recipe portion", scopes: ["read:recipes", "write:daily"], parameters: [uuidPathParameter()], hasNotFoundResponse: true, successStatus: 201, requestBody: "recipeLog" }],
  },
  {
    path: "/weight",
    methods: [{ method: "get", summary: "Read weight entries and progress", scopes: ["read:weight"], parameters: [utcReferenceDateParameter()] }],
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
      { method: "patch", summary: "Update a weight entry", scopes: ["write:weight", "read:weight"], parameters: [uuidPathParameter()], hasNotFoundResponse: true, requestBody: "weightEntryPatch", hasConflictResponse: true },
      { method: "delete", summary: "Delete a weight entry", scopes: ["write:weight"], parameters: [uuidPathParameter()], hasNotFoundResponse: true },
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
    methods: [{ method: "get", summary: "Read stats", scopes: ["read:stats", "read:weight", "read:goals"], parameters: [utcReferenceDateParameter()] }],
  },
  {
    path: "/summary",
    methods: [
      {
        method: "get",
        summary: "Read dashboard summary data",
        scopes: ["read:stats", "read:daily", "read:goals", "read:weight"],
        parameters: [utcReferenceDateParameter()],
      },
    ],
  },
  {
    path: "/leaderboard",
    methods: [{ method: "get", summary: "Read personal leaderboard stats", scopes: ["read:stats"], parameters: [utcReferenceDateParameter()] }],
  },
  {
    path: "/sync/healthkit",
    methods: [
      {
        method: "get",
        summary: "List eaten meal entries not yet synced to Apple Health",
        scopes: ["read:daily"],
        parameters: [
          { name: "days", in: "query", required: false, description: "How many days back to look." },
          { name: "limit", in: "query", required: false, description: "Maximum entries returned in one page." },
        ],
      },
    ],
  },
  {
    path: "/sync/healthkit/ack",
    methods: [
      {
        method: "post",
        summary: "Mark meal entries as synced to Apple Health",
        scopes: ["write:daily"],
        requestBody: "healthkitSyncAck",
      },
    ],
  },
  {
    path: "/openapi.json",
    methods: [{ method: "get", summary: "Read the OpenAPI document", scopes: [] }],
  },
];

export function formatApiV1ScopeSummary(method: ApiEndpointMethod) {
  const baseScopes = method.scopes.length ? method.scopes.join(", ") : "Public";
  const conditionalScopes = method.conditionalRequiredScopes?.map(
    (requirement) =>
      `Additionally requires ${requirement.scopes.join(", ")} when ${requirement.when}.`,
  );
  return [baseScopes, ...(conditionalScopes ?? [])].join(" ");
}
