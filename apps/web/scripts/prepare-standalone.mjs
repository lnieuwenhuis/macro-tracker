import { cp, mkdir, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

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

async function copyDirectoryIfExists(source, destination) {
  if (!existsSync(source)) {
    return;
  }

  await rm(destination, { recursive: true, force: true });
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true });
}

async function copyCompleteSwcHelpers(appDir, standaloneAppDir) {
  const sourceNextPackage = createRequire(resolve(appDir, "package.json")).resolve(
    "next/package.json",
  );
  const standaloneNextPackage = await realpath(
    resolve(standaloneAppDir, "node_modules/next/package.json"),
  );
  const sourceHelpers = dirname(
    createRequire(sourceNextPackage).resolve("@swc/helpers/package.json"),
  );
  const standaloneHelpers = dirname(
    createRequire(standaloneNextPackage).resolve("@swc/helpers/package.json"),
  );

  await rm(standaloneHelpers, { recursive: true, force: true });
  await mkdir(dirname(standaloneHelpers), { recursive: true });
  await cp(sourceHelpers, standaloneHelpers, { recursive: true });
}

export async function prepareStandaloneApp(appDir = getAppDir()) {
  const standaloneAppDir = getStandaloneAppDir(appDir);

  if (!standaloneAppDir) {
    throw new Error(
      "Next standalone server not found. Expected .next/standalone/apps/web/server.js or .next/standalone/server.js after next build.",
    );
  }

  await copyDirectoryIfExists(
    resolve(appDir, "public"),
    resolve(standaloneAppDir, "public"),
  );
  await copyDirectoryIfExists(
    resolve(appDir, ".next/static"),
    resolve(standaloneAppDir, ".next/static"),
  );
  // Next 16.3's standalone trace can omit the ESM half of @swc/helpers even though the server imports it.
  await copyCompleteSwcHelpers(appDir, standaloneAppDir);
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
