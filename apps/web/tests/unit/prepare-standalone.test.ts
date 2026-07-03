import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type PrepareStandaloneModule = {
  prepareStandaloneApp: (appDir: string) => Promise<void>;
};

async function getPrepareStandaloneModule() {
  const moduleUrl = new URL(
    "../../scripts/prepare-standalone.mjs",
    import.meta.url,
  ).href;

  return (await import(moduleUrl)) as PrepareStandaloneModule;
}

describe("prepare standalone script", () => {
  it("fails clearly when no expected standalone server exists", async () => {
    const { prepareStandaloneApp } = await getPrepareStandaloneModule();
    const appDir = await mkdtemp(join(tmpdir(), "macro-prepare-standalone-"));

    try {
      await expect(prepareStandaloneApp(appDir)).rejects.toThrow(
        "Next standalone server not found",
      );
    } finally {
      await rm(appDir, { force: true, recursive: true });
    }
  });
});