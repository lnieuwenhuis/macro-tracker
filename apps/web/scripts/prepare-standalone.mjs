import { cp, mkdir, readdir, realpath, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function getAppDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function getStandaloneAppDir(appDir = getAppDir()) {
  const candidates = [
    resolve(appDir, ".next/standalone/apps/web"),
    resolve(appDir, ".next/standalone"),
  ];

  return candidates.find((candidate) =>
    existsSync(resolve(candidate, "server.js")),
  );
}

function isInside(parentDir, candidate) {
  const rel = relative(parentDir, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function findEscapingLinks(rootDir, outputRealPath) {
  const escaping = [];

  async function walk(dir, depth) {
    if (depth > 12) {
      return;
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = resolve(dir, entry.name);

      if (entry.isSymbolicLink()) {
        let target;
        try {
          target = await realpath(entryPath);
        } catch {
          // A broken output link cannot be rebased safely; leave it for the caller.
          continue;
        }

        if (!isInside(outputRealPath, target)) {
          escaping.push({ path: entryPath, target });
        }
        continue;
      }

      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
      }
    }
  }

  await walk(rootDir, 0);
  return escaping;
}

async function createOutputLink(target, linkPath) {
  await mkdir(dirname(linkPath), { recursive: true });

  if (process.platform === "win32") {
    await symlink(target, linkPath, "junction");
    return;
  }

  // Relative links keep the artifact relocatable on platforms that support them.
  await symlink(relative(dirname(linkPath), target), linkPath, "dir");
}

// Windows pnpm trees contain absolute junctions back into the original store, and
// Next recreates them verbatim in standalone output. Left alone, the artifact keeps
// depending on the source node_modules, and any packaging step that resolves through
// one of these links can rewrite the source tree. Rebase every escaping output link
// onto its in-artifact counterpart.
async function rebaseEscapingLinks(appDir, standaloneRootDir, outputRealPath) {
  const escaping = await findEscapingLinks(standaloneRootDir, outputRealPath);

  if (escaping.length === 0) {
    return;
  }

  const sourceNodeModules = await realpath(
    resolve(appDir, "../..", "node_modules"),
  );
  const standaloneNodeModules = resolve(standaloneRootDir, "node_modules");

  const plans = escaping.map((link) => ({
    ...link,
    mapped: isInside(sourceNodeModules, link.target)
      ? resolve(standaloneNodeModules, relative(sourceNodeModules, link.target))
      : undefined,
  }));

  // Remove every output link first so replacements cannot resolve through a link
  // that is itself being rewritten. fs.rm removes the link entry, never its target.
  for (const plan of plans) {
    await rm(plan.path, { recursive: true, force: true });
  }

  for (const plan of plans) {
    if (plan.mapped && existsSync(plan.mapped)) {
      await createOutputLink(plan.mapped, plan.path);
      continue;
    }

    await cp(plan.target, plan.path, { recursive: true, dereference: true });
  }

  const remaining = await findEscapingLinks(standaloneRootDir, outputRealPath);

  if (remaining.length > 0) {
    throw new Error(
      `Standalone output still links outside itself: ${remaining
        .map((link) => `${relative(standaloneRootDir, link.path)} -> ${link.target}`)
        .join(", ")}`,
    );
  }
}

async function copyDirectoryIfExists(source, destination, outputRealPath) {
  if (!existsSync(source)) {
    return;
  }

  if (!isInside(outputRealPath, destination)) {
    throw new Error(
      `Refusing to write outside the standalone output: ${destination}`,
    );
  }

  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

async function copyCompleteSwcHelpers(appDir, standaloneAppDir, outputRealPath) {
  const sourceNextPackage = createRequire(
    resolve(appDir, "package.json"),
  ).resolve("next/package.json");
  const standaloneNextPackage = await realpath(
    resolve(standaloneAppDir, "node_modules/next/package.json"),
  );
  const sourceHelpers = dirname(
    createRequire(sourceNextPackage).resolve("@swc/helpers/package.json"),
  );
  const standaloneHelpers = dirname(
    createRequire(standaloneNextPackage).resolve("@swc/helpers/package.json"),
  );
  const sourceHelpersReal = await realpath(sourceHelpers);
  const standaloneHelpersReal = await realpath(standaloneHelpers);

  // The resolved destination must be an output location. Previously realpath followed
  // Windows junctions into the source store, so this removal deleted the original
  // package instead of replacing a copy inside the standalone output.
  if (!isInside(outputRealPath, standaloneHelpersReal)) {
    throw new Error(
      `Refusing to replace @swc/helpers outside the standalone output: ${standaloneHelpersReal}`,
    );
  }

  await rm(standaloneHelpersReal, { recursive: true, force: true });
  await mkdir(dirname(standaloneHelpersReal), { recursive: true });
  await cp(sourceHelpersReal, standaloneHelpersReal, {
    recursive: true,
    dereference: true,
  });
}

export async function prepareStandaloneApp(appDir = getAppDir()) {
  const standaloneAppDir = getStandaloneAppDir(appDir);

  if (!standaloneAppDir) {
    throw new Error(
      "Next standalone server not found. Expected .next/standalone/apps/web/server.js or .next/standalone/server.js after next build.",
    );
  }

  const standaloneRootDir = resolve(appDir, ".next/standalone");
  const outputRealPath = await realpath(standaloneRootDir);

  await copyDirectoryIfExists(
    resolve(appDir, "public"),
    resolve(standaloneAppDir, "public"),
    outputRealPath,
  );
  await copyDirectoryIfExists(
    resolve(appDir, ".next/static"),
    resolve(standaloneAppDir, ".next/static"),
    outputRealPath,
  );
  await rebaseEscapingLinks(appDir, standaloneRootDir, outputRealPath);
  // Next 16.3's standalone trace can omit the ESM half of @swc/helpers even though the server imports it.
  await copyCompleteSwcHelpers(appDir, standaloneAppDir, outputRealPath);
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
      import.meta.url === pathToFileURL(resolve(process.argv[1])).href,
  );
}

if (isMainModule()) {
  prepareStandaloneApp().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
