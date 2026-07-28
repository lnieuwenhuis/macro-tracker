import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { API_V1_ENDPOINTS } from "@/lib/api-v1-openapi";

type Operation = {
  responses: Record<string, unknown>;
  requestBody?: unknown;
  "x-required-scopes"?: string[];
  "x-conditional-required-scopes"?: { scopes: string[]; when: string }[];
};

async function readGeneratedContract() {
  const artifact = await readFile(
    new URL("../../../backend/src/generated/api-v1-openapi.json", import.meta.url),
    "utf8",
  );
  return JSON.parse(artifact) as {
    paths: Record<string, Record<string, Operation>>;
  };
}

/**
 * The backend serves the generated artifact while the docs page renders from
 * `API_V1_ENDPOINTS`. Nothing forces the two to agree, so pin the properties
 * the docs actually claim about each endpoint.
 */
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

  it("agrees with the docs table on scopes, request bodies, and responses", async () => {
    const { paths } = await readGeneratedContract();

    for (const endpoint of API_V1_ENDPOINTS) {
      for (const method of endpoint.methods) {
        const operation = paths[endpoint.path]?.[method.method];
        expect(operation, `${method.method} ${endpoint.path}`).toBeDefined();

        expect(operation!["x-required-scopes"] ?? []).toEqual(method.scopes);
        expect(operation!["x-conditional-required-scopes"]).toEqual(
          method.conditionalRequiredScopes,
        );
        expect(Object.keys(operation!.responses)).toContain(
          String(method.successStatus ?? 200),
        );
        expect(Object.keys(operation!.responses).includes("409")).toBe(
          Boolean(method.hasConflictResponse),
        );
        expect(operation!.requestBody !== undefined).toBe(
          method.requestBody !== undefined,
        );
      }
    }
  });
});
