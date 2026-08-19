import type { ApiScope } from "@macro-tracker/db";

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
  conditionalRequiredScopes?: {
    scopes: ApiScope[];
    when: string;
  }[];
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
    methods: [
      {
        method: "post",
        summary: "Create a meal entry on a date",
        scopes: ["write:daily"],
        conditionalRequiredScopes: [{ scopes: ["read:foods"], when: "non-null productId is supplied" }],
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
        conditionalRequiredScopes: [{ scopes: ["read:foods"], when: "non-null productId is supplied" }],
        requestBody: "mealEntryPatch",
        hasConflictResponse: true,
      },
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
    methods: [{ method: "post", summary: "Apply a template to a date", scopes: ["read:templates", "write:daily"], successStatus: 201, requestBody: "date", hasConflictResponse: true }],
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

export function formatApiV1ScopeSummary(method: ApiEndpointMethod) {
  const baseScopes = method.scopes.length ? method.scopes.join(", ") : "Public";
  const conditionalScopes = method.conditionalRequiredScopes?.map(
    (requirement) =>
      `Additionally requires ${requirement.scopes.join(", ")} when ${requirement.when}.`,
  );
  return [baseScopes, ...(conditionalScopes ?? [])].join(" ");
}
