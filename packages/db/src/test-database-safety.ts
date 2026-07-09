import { isPgliteConnectionString } from "./postgres-config.js";

type TestDatabaseEnv = Record<string, string | undefined>;

type ResolveDestructiveTestDatabaseUrlOptions = {
  explicitEnvNames: string[];
  fallbackEnvName?: string;
  purpose: string;
};

const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const TEST_DATABASE_MARKER_PATTERN = /(^|[-_])(test|tests|e2e|ci)([-_]|$)/;

function readEnvValue(env: TestDatabaseEnv, name: string) {
  const value = env[name]?.trim();
  return value ? value : null;
}

function getDatabaseName(url: URL) {
  return decodeURIComponent(url.pathname.replace(/^\/+/, "")).toLowerCase();
}

function isLocalDatabaseHost(hostname: string) {
  return LOCAL_DATABASE_HOSTS.has(hostname.toLowerCase());
}

function isClearlyTestDatabaseName(name: string) {
  return TEST_DATABASE_MARKER_PATTERN.test(name);
}

function parsePostgresUrl(connectionString: string, source: string) {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${source} must be a valid PostgreSQL URL before tests can truncate it.`);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${source} must use a PostgreSQL URL before tests can truncate it.`);
  }

  return url;
}

export function assertSafeDestructiveTestDatabaseUrl(
  connectionString: string,
  source: string,
) {
  if (isPgliteConnectionString(connectionString)) {
    return connectionString;
  }

  const url = parsePostgresUrl(connectionString, source);
  const databaseName = getDatabaseName(url);
  if (isLocalDatabaseHost(url.hostname) || isClearlyTestDatabaseName(databaseName)) {
    return connectionString;
  }

  throw new Error(
    `Refusing to truncate ${source} because it does not look like a local or test database. ` +
      "Set TEST_DATABASE_URL or E2E_DATABASE_URL to an explicit local/test database URL.",
  );
}

export function resolveDestructiveTestDatabaseUrl(
  env: TestDatabaseEnv,
  options: ResolveDestructiveTestDatabaseUrlOptions,
) {
  for (const name of options.explicitEnvNames) {
    const value = readEnvValue(env, name);
    if (value) {
      return assertSafeDestructiveTestDatabaseUrl(value, name);
    }
  }

  const fallbackEnvName = options.fallbackEnvName ?? "DATABASE_URL";
  const fallback = readEnvValue(env, fallbackEnvName);
  if (!fallback) {
    return null;
  }

  if (isPgliteConnectionString(fallback)) {
    return fallback;
  }

  throw new Error(
    `Refusing to truncate plain ${fallbackEnvName} for ${options.purpose}. ` +
      `Set ${options.explicitEnvNames.join(" or ")} to an explicit local/test database URL.`,
  );
}
