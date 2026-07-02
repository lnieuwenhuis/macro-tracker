import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function getStandaloneAppDir() {
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

const standaloneAppDir = getStandaloneAppDir();

if (standaloneAppDir) {
  await copyDirectoryIfExists(
    resolve(appDir, "public"),
    resolve(standaloneAppDir, "public"),
  );
  await copyDirectoryIfExists(
    resolve(appDir, ".next/static"),
    resolve(standaloneAppDir, ".next/static"),
  );
}
