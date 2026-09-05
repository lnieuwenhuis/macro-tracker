import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      // The fixture uses a process group so the old launcher also cleans up on failure.
      process.kill(-child.pid!, "SIGTERM");
      await exited;
    }
  }
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture({
  standalone = true,
  migrationExit = 0,
  runMigrations = "true",
  databaseUrl = "postgres://localhost/test",
  serverThrows = false,
} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "macro-startup-")));
  directories.push(root);
  const app = join(root, "apps/web");
  const launcher = join(app, "scripts/start-with-migrations.mjs");
  await mkdir(dirname(launcher), { recursive: true });
  await cp(resolve("scripts/start-with-migrations.mjs"), launcher);
  const config = join(root, "packages/db/src/postgres-config.js");
  await mkdir(dirname(config), { recursive: true });
  await cp(resolve("../../packages/db/src/postgres-config.js"), config);
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "pnpm"), `#!/bin/sh\necho "$*" > "${root}/migration"\nexit ${migrationExit}\n`, { mode: 0o755 });
  const server = standalone
    ? join(app, ".next/standalone/apps/web/server.js")
    : join(app, "node_modules/next/dist/bin/next");
  await mkdir(dirname(server), { recursive: true });
  await writeFile(server, `
    ${serverThrows ? "throw new Error('fixture startup failed');" : ""}
    console.log('FIXTURE:' + JSON.stringify({pid: process.pid, hostname: process.env.HOSTNAME, argv: process.argv}));
    process.on('SIGTERM', () => process.exit(0));
    process.on('SIGINT', () => process.exit(0));
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [launcher], {
    cwd: root, detached: true,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LEGACY_FRONTEND_RUN_MIGRATIONS: runMigrations, DATABASE_URL: databaseUrl, NEXT_SERVER_HOSTNAME: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  let errors = "";
  child.stderr!.on("data", (data) => { errors += data; });
  const ready = new Promise<{ pid: number; hostname: string; argv: string[] }>((resolveReady, reject) => {
    child.stdout!.on("data", (data) => {
      output += data;
      const match = output.match(/FIXTURE:(.*)\n/);
      if (match) resolveReady(JSON.parse(match[1]));
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`exit ${code}: ${output} ${errors}`)));
  });
  return { root, child, ready };
}

it.each(["SIGTERM", "SIGINT"] as const)("runs migrations then serves in the launcher PID and handles %s", async (signal) => {
  const { root, child, ready } = await fixture();
  const server = await ready;
  expect(await readFile(join(root, "migration"), "utf8")).toBe("--filter @macro-tracker/db db:migrate\n");
  expect(server.pid).toBe(child.pid);
  expect(server.hostname).toBe("127.0.0.1");
  const exited = once(child, "exit");
  child.kill(signal);
  expect(await exited).toEqual([0, null]);
});

it("loads the Next CLI in-process when standalone output is absent", async () => {
  const { child, ready } = await fixture({ standalone: false });
  const server = await ready;
  expect(server.pid).toBe(child.pid);
  expect(server.argv).toContain("start");
});

it("fails startup without serving when migrations fail", async () => {
  const { ready } = await fixture({ migrationExit: 7 });
  await expect(ready).rejects.toThrow("exited with code 7");
});

it.each([
  { runMigrations: "false" },
  { databaseUrl: "" },
  { databaseUrl: "memory:" },
  { databaseUrl: "file:startup-test" },
])("starts without invoking migrations when disabled or inapplicable: %o", async (options) => {
  const { root, ready } = await fixture(options);
  await ready;
  await expect(readFile(join(root, "migration"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("reports standalone entrypoint failures as a failed startup", async () => {
  const { ready } = await fixture({ serverThrows: true });
  await expect(ready).rejects.toThrow("fixture startup failed");
});
