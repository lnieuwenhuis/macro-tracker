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
  const sessionSecret = readRequiredEnv("SESSION_SECRET");

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
