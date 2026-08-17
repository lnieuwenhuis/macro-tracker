// Also unified with the loopback list in test-database-safety.ts (see LOW-F2):
// `URL.hostname` always returns the bracketed form for IPv6, so the bare
// `::1` form is never actually produced by `new URL(...).hostname` and would
// be a dead entry here.
const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const INSECURE_REMOTE_SSL_MODES = new Set([
  "allow",
  "disable",
  "no-verify",
  "prefer",
]);
const REMOTE_SSL_MODES = new Set(["require", "verify-full"]);
// `require` used to mean "encrypt but don't verify the certificate" here,
// which is the exact insecure posture `no-verify` is rejected for a few
// lines above. Both now verify by default; use ALLOW_UNVERIFIED_DB_TLS to
// deliberately opt back out (see getSslConfig below).
const VERIFY_REMOTE_SSL_MODES = new Set(["require", "verify-full"]);
const ALLOW_UNVERIFIED_DB_TLS_ENV = "ALLOW_UNVERIFIED_DB_TLS";
const DEFAULT_POSTGRES_POOL_MAX = 3;
const DEFAULT_POSTGRES_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_POSTGRES_CONNECTION_TIMEOUT_MS = 5_000;

export function isPgliteConnectionString(connectionString) {
  return connectionString === "memory:" || connectionString.startsWith("file:");
}

// Exported so test-database-safety.ts can share this list instead of
// keeping its own (LOW-F2): that copy included a bare `::1` entry that
// `URL.hostname` never actually produces (it always returns the bracketed
// `[::1]` form), so it was silently dead there.
export function isLocalDatabaseHost(hostname) {
  return LOCAL_DATABASE_HOSTS.has(hostname.toLowerCase());
}

function validateRemoteSslMode(url) {
  const sslMode = url.searchParams.get("sslmode")?.toLowerCase();

  if (!sslMode || isLocalDatabaseHost(url.hostname.toLowerCase())) {
    return;
  }

  if (INSECURE_REMOTE_SSL_MODES.has(sslMode)) {
    throw new Error(
      `Remote PostgreSQL DATABASE_URL cannot use insecure sslmode=${sslMode}.`,
    );
  }

  if (!REMOTE_SSL_MODES.has(sslMode)) {
    throw new Error(
      `Remote PostgreSQL DATABASE_URL has unsupported sslmode=${sslMode}.`,
    );
  }
}

function readPositiveIntegerEnv(name, fallback) {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function allowsUnverifiedDbTls(env) {
  return env[ALLOW_UNVERIFIED_DB_TLS_ENV]?.trim().toLowerCase() === "true";
}

export function getSslConfig(connectionString, env = process.env) {
  const url = new URL(connectionString);

  if (isLocalDatabaseHost(url.hostname.toLowerCase())) {
    return false;
  }

  validateRemoteSslMode(url);

  const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
  const shouldVerifyRemoteCertificate =
    sslMode === undefined || VERIFY_REMOTE_SSL_MODES.has(sslMode);

  if (!shouldVerifyRemoteCertificate) {
    return { rejectUnauthorized: false };
  }

  if (allowsUnverifiedDbTls(env)) {
    // eslint-disable-next-line no-console -- deliberately loud: this disables
    // certificate verification on a remote database connection.
    console.error(
      "\n" +
        "!".repeat(72) +
        "\n" +
        `! ${ALLOW_UNVERIFIED_DB_TLS_ENV}=true is set: database TLS certificate\n` +
        "! verification is DISABLED for this remote connection. The server's\n" +
        "! identity is not being checked, so this connection is vulnerable to\n" +
        "! interception. Unset this variable unless you have deliberately\n" +
        "! chosen to accept that risk.\n" +
        "!".repeat(72) +
        "\n",
    );
    return { rejectUnauthorized: false };
  }

  return { rejectUnauthorized: true };
}

export function getPostgresConnectionConfig(connectionString, overrides = {}) {
  const url = new URL(connectionString);
  const ssl = getSslConfig(connectionString);

  url.searchParams.delete("sslmode");

  return {
    connectionString: url.toString(),
    ssl,
    max: readPositiveIntegerEnv("POSTGRES_POOL_MAX", DEFAULT_POSTGRES_POOL_MAX),
    idleTimeoutMillis: readPositiveIntegerEnv(
      "POSTGRES_POOL_IDLE_TIMEOUT_MS",
      DEFAULT_POSTGRES_IDLE_TIMEOUT_MS,
    ),
    connectionTimeoutMillis: readPositiveIntegerEnv(
      "POSTGRES_POOL_CONNECTION_TIMEOUT_MS",
      DEFAULT_POSTGRES_CONNECTION_TIMEOUT_MS,
    ),
    allowExitOnIdle: true,
    ...overrides,
  };
}
