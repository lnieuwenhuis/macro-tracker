import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { getApiV1OpenApi } from "@/lib/api-v1-openapi";

describe("generated API v1 contract", () => {
  it("matches the frontend OpenAPI contract", async () => {
    const artifact = await readFile(
      new URL("../../../backend/src/generated/api-v1-openapi.json", import.meta.url),
      "utf8",
    );

    expect(JSON.parse(artifact)).toEqual(getApiV1OpenApi());
  });
});
