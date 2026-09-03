import { isLocalDatabaseHost, isPgliteConnectionString } from "./postgres-config.js";

type TestDatabaseEnv = Record<string, string | undefined>;

type ResolveDestructiveTestDatabaseUrlOptions = {
  explicitEnvNames: string[];
  fallbackEnvName?: string;
  purpose: string;
};

const TEST_DATABASE_MARKER_PATTERN = /(^|[-_])(test|tests|e2e|ci)([-_]|$)/;
const ALLOW_DESTRUCTIVE_LOCAL_DB_ENV = "ALLOW_DESTRUCTIVE_LOCAL_DB";
const ALLOW_DESTRUCTIVE_REMOTE_DB_ENV = "ALLOW_DESTRUCTIVE_REMOTE_DB";

function readEnvValue(env: TestDatabaseEnv, name: string) {
  const value = env[name]?.trim();
  return value ? value : null;
}

function getDatabaseName(url: URL) {
  return decodeURIComponent(url.pathname.replace(/^\/+/, "")).toLowerCase();
}

function isClearlyTestDatabaseName(name: string) {
  return TEST_DATABASE_MARKER_PATTERN.test(name);
}

function isTruthyEnvToggle(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function allowsDestructiveLocalDatabase(env: TestDatabaseEnv) {
  return isTruthyEnvToggle(env[ALLOW_DESTRUCTIVE_LOCAL_DB_ENV]);
}

function allowsDestructiveRemoteDatabase(env: TestDatabaseEnv) {
  return isTruthyEnvToggle(env[ALLOW_DESTRUCTIVE_REMOTE_DB_ENV]);
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
  env: TestDatabaseEnv = process.env,
) {
  if (isPgliteConnectionString(connectionString)) {
    return connectionString;
  }

  const url = parsePostgresUrl(connectionString, source);
  const databaseName = getDatabaseName(url);
  const isTestName = isClearlyTestDatabaseName(databaseName);
  const isLocal = isLocalDatabaseHost(url.hostname);

  // DB-08: a remote host always needs an explicit opt-in on top of (not instead of) the test-name check.
  if (!isLocal) {
    if (isTestName && allowsDestructiveRemoteDatabase(env)) {
      return connectionString;
    }

    throw new Error(
      `Refusing to truncate ${source} because its host is not local. ` +
        "A database name containing test, tests, e2e, or ci is not enough on its own for " +
        `a remote host -- set ${ALLOW_DESTRUCTIVE_REMOTE_DB_ENV}=true to deliberately allow ` +
        "truncating a remote database.",
    );
  }

  if (isTestName) {
    return connectionString;
  }

  if (allowsDestructiveLocalDatabase(env)) {
    return connectionString;
  }

  throw new Error(
    `Refusing to truncate ${source} because it does not look like a test database. ` +
      "Use a database name containing test, tests, e2e, or ci, " +
      `or set ${ALLOW_DESTRUCTIVE_LOCAL_DB_ENV}=true to deliberately allow a local non-test database.`,
  );
}

export function resolveDestructiveTestDatabaseUrl(
  env: TestDatabaseEnv,
  options: ResolveDestructiveTestDatabaseUrlOptions,
) {
  for (const name of options.explicitEnvNames) {
    const value = readEnvValue(env, name);
    if (value) {
      return assertSafeDestructiveTestDatabaseUrl(value, name, env);
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
