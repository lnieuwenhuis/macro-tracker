type ServerEnv = {
  appUrl: string;
  trustedOrigins: string[];
  sessionSecret: string;
  shooBaseUrl: string;
  enableTestRoutes: boolean;
  testRoutesSecret: string | undefined;
  adminOwnerEmails: string[];
};

let cachedEnv: ServerEnv | undefined;

function parseCsvList(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseOriginList(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => new URL(item).origin);
}

function readRequiredEnv(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback;

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

/**
 * Mirrors `validate_secret` in `apps/backend/src/config.rs`. The two services
 * share one HMAC key, so a secret the backend refuses to start on must not be
 * silently accepted here — `jose` enforces no minimum key length of its own,
 * which previously made `SESSION_SECRET=x` a working HS256 signing key.
 */
const MIN_SESSION_SECRET_LENGTH = 32;

/**
 * Values that are published in this repository or its documentation, so
 * "long enough" says nothing about whether they are secret.
 */
const KNOWN_INSECURE_SESSION_SECRETS = new Set([
  // README setup instructions — 35 characters, so a length check alone passes.
  "change-this-to-a-long-random-string",
  // `LOCAL_SESSION_SECRET` in the backend config, and `playwright.config.ts`.
  "macro-tracker-dev-session-secret",
  // The sibling internal-secret default in `playwright.config.ts`.
  "macro-tracker-local-backend-secret",
]);

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Mirrors `allows_insecure_internal_auth_for_app_url` in the backend config: a
 * loopback `APP_URL` cannot be serving real users, so the committed development
 * secrets stay usable there. Anything else is a deployment and must not run on
 * a value published in this repository.
 */
function isLoopbackAppUrl(appUrl: string) {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(appUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function readSessionSecret(appUrl: string) {
  const value = readRequiredEnv("SESSION_SECRET");
  // Measured on the trimmed value so 32 spaces cannot pass as a strong secret,
  // but the raw value is what gets returned: the backend signs with the
  // untrimmed bytes and the two must agree.
  const trimmed = value.trim();

  if (trimmed.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters.`,
    );
  }

  if (KNOWN_INSECURE_SESSION_SECRETS.has(trimmed) && !isLoopbackAppUrl(appUrl)) {
    throw new Error(
      "SESSION_SECRET must not be a known placeholder or development value. Generate one with `openssl rand -base64 48`.",
    );
  }

  return value;
}

export function getServerEnv(): ServerEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  const isProduction = process.env.NODE_ENV === "production";
  const appUrl = readRequiredEnv(
    "APP_URL",
    isProduction ? undefined : "http://localhost:3000",
  );
  const appOrigin = new URL(appUrl).origin;
  // Required unconditionally. It used to fall back to a repo-visible literal
  // outside production, which meant one mis-set NODE_ENV made every HS256
  // session forgeable.
  const sessionSecret = readSessionSecret(appUrl);

  cachedEnv = {
    appUrl,
    trustedOrigins: Array.from(
      new Set([appOrigin, ...parseOriginList(process.env.APP_TRUSTED_ORIGINS)]),
    ),
    sessionSecret,
    shooBaseUrl: process.env.SHOO_BASE_URL ?? "https://shoo.dev",
    // Explicit opt-in only. Deriving this from NODE_ENV coupled
    // arbitrary-session test routes to an environment variable that is easy to
    // set wrong.
    enableTestRoutes: process.env.ENABLE_TEST_ROUTES === "true",
    testRoutesSecret: process.env.TEST_ROUTES_SECRET,
    adminOwnerEmails: parseCsvList(process.env.ADMIN_OWNER_EMAILS),
  };

  return cachedEnv;
}

export function resetServerEnvForTests() {
  cachedEnv = undefined;
}
