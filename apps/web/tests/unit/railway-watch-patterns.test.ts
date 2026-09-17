import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function parseWatchPatterns(toml: string) {
  const match = toml.match(/watchPatterns\s*=\s*\[([^\]]*)\]/);

  if (!match) {
    throw new Error("watchPatterns not found in railway config");
  }

  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter((entry) => entry.length > 0);
}

function matchesWatchPattern(pattern: string, changedPath: string) {
  const normalized = `/${changedPath.replace(/\\/g, "/").replace(/^\/+/, "")}`;

  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  }

  return normalized === pattern;
}

async function getConfigs() {
  const [root, scoped] = await Promise.all([
    readFile(resolve("../../railway.toml"), "utf8"),
    readFile(resolve("railway.toml"), "utf8"),
  ]);

  return {
    root: parseWatchPatterns(root),
    scoped: parseWatchPatterns(scoped),
  };
}

describe("railway frontend watch patterns", () => {
  it("keeps the scoped frontend config watching every shared build input", async () => {
    const { root, scoped } = await getConfigs();

    for (const pattern of root) {
      expect(scoped).toContain(pattern);
    }
  });

  it("watches railpack.json so a railpack-only change triggers the frontend build", async () => {
    const { root, scoped } = await getConfigs();

    expect(root).toContain("/railpack.json");
    expect(scoped).toContain("/railpack.json");
    expect(
      scoped.some((pattern) => matchesWatchPattern(pattern, "railpack.json")),
    ).toBe(true);
  });

  it("matches representative changed paths and ignores unrelated services", async () => {
    const { scoped } = await getConfigs();
    const matches = (changedPath: string) =>
      scoped.some((pattern) => matchesWatchPattern(pattern, changedPath));

    for (const changedPath of [
      "apps/web/app/page.tsx",
      "packages/db/src/schema.ts",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "railpack.json",
    ]) {
      expect(matches(changedPath)).toBe(true);
    }

    for (const changedPath of [
      "apps/backend/src/main.rs",
      "infra/cliproxyapi/entrypoint.sh",
    ]) {
      expect(matches(changedPath)).toBe(false);
    }
  });
});
