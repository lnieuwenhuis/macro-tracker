import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const directories: string[] = [];
const children: ChildProcess[] = [];

async function waitForExit(child: ChildProcess, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = once(child, "exit");

  if (process.platform === "win32") {
    // Windows has no POSIX process-group signaling, so terminate the owned child directly.
    child.kill();
  } else {
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }

  await Promise.race([
    exited,
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
  ]);
}

async function removeWithRetry(directory: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch {
      // Windows can hold the directory briefly after a killed child releases it.
      await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 250));
    }
  }
}

async function readMigrationLog(root: string) {
  // cmd.exe appends CRLF when the fixture shim writes its arguments.
  return (await readFile(join(root, "migration"), "utf8")).replace(/\r\n/g, "\n");
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    await waitForExit(child);
    if (child.exitCode === null && child.signalCode === null) {
      throw new Error(`fixture child ${child.pid} survived termination`);
    }
  }

  await Promise.all(
    directories.splice(0).map((directory) => removeWithRetry(directory)),
  );
}, 30_000);

type FixtureOptions = {
  standalone?: boolean;
  migrationExit?: number;
  runMigrations?: string;
  databaseUrl?: string;
  serverThrows?: boolean;
  migrationRunner?: "path-shim" | "node-entry";
};

async function fixture({
  standalone = true,
  migrationExit = 0,
  runMigrations = "true",
  databaseUrl = "postgres://localhost/test",
  serverThrows = false,
  migrationRunner = "path-shim",
}: FixtureOptions = {}) {
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

  const migrationFile = join(root, "migration");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LEGACY_FRONTEND_RUN_MIGRATIONS: runMigrations,
    DATABASE_URL: databaseUrl,
    NEXT_SERVER_HOSTNAME: "127.0.0.1",
  };

  if (migrationRunner === "node-entry") {
    const entry = join(root, "fake-pnpm.mjs");
    await writeFile(
      entry,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(migrationFile)}, process.argv.slice(2).join(" ") + "\\n");`,
        `process.exit(${migrationExit});`,
        "",
      ].join("\n"),
    );
    env.npm_execpath = entry;
  } else {
    delete env.npm_execpath;
    const bin = join(root, "bin");
    await mkdir(bin);
    if (process.platform === "win32") {
      await writeFile(
        join(bin, "pnpm.cmd"),
        `@echo off\r\n>"${migrationFile}" echo %*\r\nexit /b ${migrationExit}\r\n`,
      );
    } else {
      await writeFile(
        join(bin, "pnpm"),
        `#!/bin/sh\necho "$*" > "${migrationFile}"\nexit ${migrationExit}\n`,
        { mode: 0o755 },
      );
    }
    env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  }

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
    cwd: root,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  let output = "";
  let errors = "";
  child.stderr!.on("data", (data) => {
    errors += data;
  });

  const ready = new Promise<{ pid: number; hostname: string; argv: string[] }>(
    (resolveReady, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`fixture did not become ready; output: ${output} errors: ${errors}`),
        );
      }, 20_000);

      child.stdout!.on("data", (data) => {
        output += data;
        const match = output.match(/FIXTURE:(.*)\n/);
        if (match) {
          clearTimeout(timer);
          resolveReady(JSON.parse(match[1]));
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`exit ${code}: ${output} ${errors}`));
      });
    },
  );

  return { root, child, ready };
}

it.skipIf(process.platform === "win32").each(["SIGTERM", "SIGINT"] as const)(
  "runs migrations then serves in the launcher PID and handles %s",
  async (signal) => {
    const { root, child, ready } = await fixture();
    const server = await ready;
    expect(await readMigrationLog(root)).toBe(
      "--filter @macro-tracker/db db:migrate\n",
    );
    expect(server.pid).toBe(child.pid);
    expect(server.hostname).toBe("127.0.0.1");
    const exited = once(child, "exit");
    child.kill(signal);
    expect(await exited).toEqual([0, null]);
  },
);

it.skipIf(process.platform !== "win32")(
  "runs migrations then serves and terminates on kill on Windows",
  async () => {
    const { root, child, ready } = await fixture();
    const server = await ready;
    expect(await readMigrationLog(root)).toBe(
      "--filter @macro-tracker/db db:migrate\n",
    );
    expect(server.pid).toBe(child.pid);
    expect(server.hostname).toBe("127.0.0.1");
    const exited = once(child, "exit");
    child.kill();
    await exited;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  },
);

it("runs the package manager entry provided through npm_execpath", async () => {
  const { root, ready } = await fixture({ migrationRunner: "node-entry" });
  await ready;
  expect(await readMigrationLog(root)).toBe(
    "--filter @macro-tracker/db db:migrate\n",
  );
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
