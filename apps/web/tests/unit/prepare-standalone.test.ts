import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("copies the complete SWC helpers package into the standalone runtime", async () => {
    const { prepareStandaloneApp } = await getPrepareStandaloneModule();
    const appDir = await mkdtemp(join(tmpdir(), "macro-prepare-standalone-"));
    const standaloneAppDir = join(appDir, ".next", "standalone", "apps", "web");
    const sourceNextDir = join(appDir, "node_modules", "next");
    const sourceHelpersDir = join(
      sourceNextDir,
      "node_modules",
      "@swc",
      "helpers",
    );
    const standaloneNextDir = join(standaloneAppDir, "node_modules", "next");
    const standaloneHelpersDir = join(
      standaloneNextDir,
      "node_modules",
      "@swc",
      "helpers",
    );

    try {
      await Promise.all([
        mkdir(join(sourceHelpersDir, "esm"), { recursive: true }),
        mkdir(standaloneHelpersDir, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(sourceNextDir, "package.json"), '{"name":"next"}'),
        writeFile(
          join(sourceHelpersDir, "package.json"),
          '{"name":"@swc/helpers"}',
        ),
        writeFile(
          join(sourceHelpersDir, "esm", "_interop_require_default.js"),
          "export default function interopRequireDefault() {}",
        ),
        writeFile(join(standaloneAppDir, "server.js"), ""),
        writeFile(join(standaloneNextDir, "package.json"), '{"name":"next"}'),
        writeFile(
          join(standaloneHelpersDir, "package.json"),
          '{"name":"@swc/helpers"}',
        ),
      ]);

      await prepareStandaloneApp(appDir);

      await expect(
        readFile(
          join(standaloneHelpersDir, "esm", "_interop_require_default.js"),
          "utf8",
        ),
      ).resolves.toContain("interopRequireDefault");
    } finally {
      await rm(appDir, { force: true, recursive: true });
    }
  });
});
