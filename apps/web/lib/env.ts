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

function splitCsvValues(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCsvList(value: string | undefined) {
  return splitCsvValues(value).map((item) => item.toLowerCase());
}

function parseOriginList(value: string | undefined) {
  return splitCsvValues(value).map((item) => new URL(item).origin);
}

function readRequiredEnv(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback;

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

// Mirrors `validate_secret` in apps/backend/src/config.rs (shared HMAC key); jose enforces no minimum of its own.
const MIN_SESSION_SECRET_LENGTH = 32;

// Values published in this repository or its docs, so "long enough" says nothing about secrecy.
const KNOWN_INSECURE_SESSION_SECRETS = new Set([
  "change-this-to-a-long-random-string", // README setup instructions
  "macro-tracker-dev-session-secret", // LOCAL_SESSION_SECRET in the backend config, and playwright.config.ts
  "macro-tracker-local-backend-secret", // sibling internal-secret default in playwright.config.ts
]);

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Mirrors `allows_insecure_internal_auth_for_app_url` in the backend config: a loopback APP_URL cannot be serving real users.
function isLoopbackAppUrl(appUrl: string) {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(appUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function readSessionSecret(appUrl: string) {
  const value = readRequiredEnv("SESSION_SECRET");
  // Length is measured trimmed (so spaces can't pad it out), but the raw value is returned and signed with.
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
  const sessionSecret = readSessionSecret(appUrl);

  cachedEnv = {
    appUrl,
    trustedOrigins: Array.from(
      new Set([appOrigin, ...parseOriginList(process.env.APP_TRUSTED_ORIGINS)]),
    ),
    sessionSecret,
    shooBaseUrl: process.env.SHOO_BASE_URL ?? "https://shoo.dev",
    enableTestRoutes: process.env.ENABLE_TEST_ROUTES === "true",
    testRoutesSecret: process.env.TEST_ROUTES_SECRET,
    adminOwnerEmails: parseCsvList(process.env.ADMIN_OWNER_EMAILS),
  };

  return cachedEnv;
}

export function resetServerEnvForTests() {
  cachedEnv = undefined;
}
