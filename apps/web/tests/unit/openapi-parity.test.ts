import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { AdminAuditEvent, LeaderboardStats } from "@macro-tracker/db";

import { API_V1_ENDPOINTS, type ApiParameter } from "@/lib/api-v1-openapi";

type Operation = {
  parameters?: {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: { type?: string; format?: string };
  }[];
  responses: Record<string, { headers?: Record<string, unknown> }>;
  requestBody?: unknown;
  "x-required-scopes"?: string[];
  "x-conditional-required-scopes"?: { scopes: string[]; when: string }[];
};

type Schema = {
  required?: string[];
  properties?: Record<string, unknown>;
};

type GeneratedContract = {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

async function readGeneratedContract() {
  const artifact = await readFile(
    new URL("../../../backend/src/generated/api-v1-openapi.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(artifact) as GeneratedContract;
}

/** Project a generated parameter onto the docs-table shape so optional keys only exist when present. */
function documentedParameter(parameter: NonNullable<Operation["parameters"]>[number]): ApiParameter {
  return {
    name: parameter.name,
    in: parameter.in as ApiParameter["in"],
    required: Boolean(parameter.required),
    ...(parameter.schema?.format ? { format: parameter.schema.format as ApiParameter["format"] } : {}),
    ...(parameter.description ? { description: parameter.description } : {}),
  };
}

// Nothing forces API_V1_ENDPOINTS to agree with the generated backend contract; pin it here.
describe("generated API v1 contract", () => {
  it("covers exactly the endpoints and methods the docs table advertises", async () => {
    const { paths } = await readGeneratedContract();

    const documented = API_V1_ENDPOINTS.flatMap((endpoint) =>
      endpoint.methods.map(
        (method) => `${method.method.toUpperCase()} ${endpoint.path}`,
      ),
    ).sort();
    const generated = Object.entries(paths)
      .flatMap(([path, operations]) =>
        Object.keys(operations).map(
          (method) => `${method.toUpperCase()} ${path}`,
        ),
      )
      .sort();

    expect(generated).toEqual(documented);
  });

  it("agrees with the docs table on scopes, request bodies, parameters, and responses", async () => {
    const { paths } = await readGeneratedContract();

    for (const endpoint of API_V1_ENDPOINTS) {
      for (const method of endpoint.methods) {
        const operation = paths[endpoint.path]?.[method.method];
        expect(operation, `${method.method} ${endpoint.path}`).toBeDefined();

        expect(operation!["x-required-scopes"] ?? []).toEqual(method.scopes);
        expect(operation!["x-conditional-required-scopes"]).toEqual(
          method.conditionalRequiredScopes,
        );
        expect((operation!.parameters ?? []).map(documentedParameter)).toEqual(
          method.parameters ?? [],
        );
        expect(Object.keys(operation!.responses)).toContain(
          String(method.successStatus ?? 200),
        );
        expect(Object.keys(operation!.responses).includes("409")).toBe(
          Boolean(method.hasConflictResponse),
        );
        expect(Object.keys(operation!.responses).includes("404")).toBe(
          Boolean(method.hasNotFoundResponse),
        );
        expect(operation!.requestBody !== undefined).toBe(
          method.requestBody !== undefined,
        );
      }
    }
  });

  it("documents opt-in pagination and truncation headers for the capped collections", async () => {
    const { paths } = await readGeneratedContract();
    const headerNames = (path: string) =>
      Object.keys(
        (paths[path]?.get?.responses["200"] as { headers?: Record<string, unknown> } | undefined)?.headers ?? {},
      );

    for (const path of ["/templates", "/recipes", "/weight/entries"]) {
      const operation = paths[path]!.get!;
      expect(operation.parameters?.map((parameter) => parameter.name)).toEqual(
        expect.arrayContaining(["limit", "cursor"]),
      );
      expect(Object.keys(operation.responses)).toContain("400");
      expect(headerNames(path)).toEqual(
        expect.arrayContaining([
          "x-result-limit",
          "x-result-count",
          "x-result-truncated",
        ]),
      );
      // The readable docs table must carry the same contract notes.
      const documented = API_V1_ENDPOINTS.find(
        (endpoint) => endpoint.path === path,
      )!.methods.find((method) => method.method === "get")!;
      expect(documented.notes?.length ?? 0).toBeGreaterThan(0);
    }

    expect(headerNames("/stats")).toEqual(
      expect.arrayContaining([
        "x-daily-totals-limit",
        "x-daily-totals-count",
        "x-daily-totals-truncated",
        "x-smoothed-weight-trend-limit",
        "x-smoothed-weight-trend-count",
        "x-smoothed-weight-trend-truncated",
      ]),
    );
  });

  it("gives every date parameter an RFC 3339 date format and every id parameter a uuid format", async () => {
    const { paths } = await readGeneratedContract();

    for (const [path, operations] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        for (const parameter of operation.parameters ?? []) {
          const label = `${method.toUpperCase()} ${path} ${parameter.name}`;
          if (parameter.name === "date") {
            expect(parameter.schema?.format, label).toBe("date");
          }
          if (parameter.in === "path" && parameter.name === "id") {
            expect(parameter.schema?.format, label).toBe("uuid");
          }
        }
      }
    }
  });
});

describe("TypeScript API response shapes", () => {
  // `satisfies` fails the typecheck if the Rust payload ever drops or adds a required field.
  const leaderboardFixture = {
    currentStreak: 0,
    longestStreak: 0,
    totalDaysTracked: 0,
    bestCalorieDay: null,
    bestProteinDay: null,
    bestCarbsDay: null,
    mostActiveDay: null,
  } satisfies LeaderboardStats;

  const deletedActorAuditEvent = {
    id: "00000000-0000-0000-0000-000000000000",
    actorUserId: null,
    actorEmail: null,
    actorDisplayName: null,
    actorRole: "admin",
    action: "update",
    targetType: "user",
    targetId: "00000000-0000-0000-0000-000000000000",
    details: {},
    createdAt: "2026-09-17T00:00:00.000Z",
  } satisfies AdminAuditEvent;

  it("keeps the leaderboard type at parity with the OpenAPI required fields", async () => {
    const { components } = await readGeneratedContract();
    const schema = components.schemas.LeaderboardStats;

    expect(schema.required?.slice().sort()).toEqual(Object.keys(leaderboardFixture).sort());
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      Object.keys(leaderboardFixture).sort(),
    );
  });

  it("types an audit event whose actor was deleted as null", () => {
    expect(deletedActorAuditEvent.actorUserId).toBeNull();
  });
});
