import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

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

async function createDirLink(target: string, linkPath: string) {
  await mkdir(dirname(linkPath), { recursive: true });
  await symlink(
    target,
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function expectInsideStandalone(standaloneRoot: string, candidate: string) {
  const rel = relative(standaloneRoot, candidate);
  expect(rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)).toBe(true);
}

// Mirrors a pnpm workspace: the real packages live in node_modules/.pnpm and the
// public entries are links. Next recreates those links in standalone output, which
// on Windows are absolute junctions pointing back at the source store.
async function createJunctionFixture() {
  const root = await mkdtemp(join(tmpdir(), "macro-prepare-standalone-"));
  const appDir = join(root, "apps", "web");
  const sourceNext = join(
    root,
    "node_modules",
    ".pnpm",
    "next@16.3.1",
    "node_modules",
    "next",
  );
  const sourceHelpers = join(
    root,
    "node_modules",
    ".pnpm",
    "@swc+helpers@0.5.23",
    "node_modules",
    "@swc",
    "helpers",
  );
  const externalPackage = join(root, "external", "linked-package");
  const standaloneRoot = join(appDir, ".next", "standalone");
  const standaloneApp = join(standaloneRoot, "apps", "web");
  const standaloneNext = join(
    standaloneRoot,
    "node_modules",
    ".pnpm",
    "next@16.3.1",
    "node_modules",
    "next",
  );
  const standaloneHelpers = join(
    standaloneRoot,
    "node_modules",
    ".pnpm",
    "@swc+helpers@0.5.23",
    "node_modules",
    "@swc",
    "helpers",
  );

  await Promise.all([
    mkdir(appDir, { recursive: true }),
    mkdir(sourceNext, { recursive: true }),
    mkdir(sourceHelpers, { recursive: true }),
    mkdir(externalPackage, { recursive: true }),
    mkdir(standaloneNext, { recursive: true }),
    mkdir(standaloneHelpers, { recursive: true }),
    mkdir(join(standaloneApp, "node_modules"), { recursive: true }),
    mkdir(join(standaloneRoot, "node_modules", ".pnpm", "node_modules"), {
      recursive: true,
    }),
    mkdir(join(dirname(standaloneNext), "@swc"), { recursive: true }),
    mkdir(join(sourceHelpers, "esm"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(appDir, "package.json"), '{"name":"web"}'),
    writeFile(join(sourceNext, "package.json"), '{"name":"next"}'),
    writeFile(join(sourceHelpers, "package.json"), '{"name":"@swc/helpers"}'),
    writeFile(
      join(sourceHelpers, "esm", "_interop_require_default.js"),
      "export default function interopRequireDefault() {}",
    ),
    writeFile(join(externalPackage, "package.json"), '{"name":"linked-package"}'),
    writeFile(join(standaloneNext, "package.json"), '{"name":"next"}'),
    writeFile(join(standaloneHelpers, "package.json"), '{"name":"@swc/helpers"}'),
    writeFile(join(standaloneApp, "server.js"), ""),
  ]);

  await createDirLink(
    sourceHelpers,
    join(dirname(sourceNext), "@swc", "helpers"),
  );
  await createDirLink(sourceNext, join(root, "node_modules", "next"));
  await createDirLink(sourceNext, join(standaloneApp, "node_modules", "next"));
  await createDirLink(
    sourceNext,
    join(standaloneRoot, "node_modules", ".pnpm", "node_modules", "next"),
  );
  await createDirLink(
    sourceHelpers,
    join(standaloneRoot, "node_modules", ".pnpm", "node_modules", "@swc", "helpers"),
  );
  await createDirLink(sourceHelpers, join(dirname(standaloneNext), "@swc", "helpers"));
  await createDirLink(
    externalPackage,
    join(
      standaloneRoot,
      "node_modules",
      ".pnpm",
      "node_modules",
      "linked-package",
    ),
  );

  return {
    root,
    appDir,
    sourceNext,
    sourceHelpers,
    standaloneRoot,
    standaloneApp,
    standaloneNext,
    standaloneHelpers,
  };
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

  it("rebases escaping output links and leaves the source packages intact", async () => {
    const { prepareStandaloneApp } = await getPrepareStandaloneModule();
    const fixture = await createJunctionFixture();

    try {
      await prepareStandaloneApp(fixture.appDir);

      const sourceNextReal = await realpath(fixture.sourceNext);
      const sourceHelpersReal = await realpath(fixture.sourceHelpers);
      const standaloneReal = await realpath(fixture.standaloneRoot);

      await expect(
        readFile(join(sourceHelpersReal, "package.json"), "utf8"),
      ).resolves.toContain("@swc/helpers");
      await expect(
        readFile(
          join(sourceHelpersReal, "esm", "_interop_require_default.js"),
          "utf8",
        ),
      ).resolves.toContain("interopRequireDefault");
      await expect(
        readFile(join(sourceNextReal, "package.json"), "utf8"),
      ).resolves.toContain("next");

      for (const linkPath of [
        join(fixture.standaloneApp, "node_modules", "next"),
        join(fixture.standaloneRoot, "node_modules", ".pnpm", "node_modules", "next"),
        join(
          fixture.standaloneRoot,
          "node_modules",
          ".pnpm",
          "node_modules",
          "@swc",
          "helpers",
        ),
        join(dirname(fixture.standaloneNext), "@swc", "helpers"),
        join(
          fixture.standaloneRoot,
          "node_modules",
          ".pnpm",
          "node_modules",
          "linked-package",
        ),
      ]) {
        expectInsideStandalone(standaloneReal, await realpath(linkPath));
      }

      expect(await realpath(join(fixture.standaloneApp, "node_modules", "next"))).toBe(
        await realpath(fixture.standaloneNext),
      );
      await expect(
        readFile(
          join(fixture.standaloneHelpers, "esm", "_interop_require_default.js"),
          "utf8",
        ),
      ).resolves.toContain("interopRequireDefault");
      await expect(
        readFile(
          join(
            fixture.standaloneRoot,
            "node_modules",
            ".pnpm",
            "node_modules",
            "linked-package",
            "package.json",
          ),
          "utf8",
        ),
      ).resolves.toContain("linked-package");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});
