type ServerEnv = {
  appUrl: string;
  sessionSecret: string;
  shooBaseUrl: string;
  enableTestRoutes: boolean;
  adminOwnerEmails: string[];
};

let cachedEnv: ServerEnv | undefined;

function parseCsvList(value: string | undefined) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
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
  const appUrl = readRequiredEnv("APP_URL", "http://localhost:3000");
  const sessionSecret = isProduction
    ? readRequiredEnv("SESSION_SECRET")
    : readRequiredEnv("SESSION_SECRET", "macro-tracker-dev-session-secret");

  cachedEnv = {
    appUrl,
    sessionSecret,
    shooBaseUrl: process.env.SHOO_BASE_URL ?? "https://shoo.dev",
    enableTestRoutes:
      process.env.NODE_ENV === "test" ||
      process.env.ENABLE_TEST_ROUTES === "true",
    adminOwnerEmails: parseCsvList(process.env.ADMIN_OWNER_EMAILS),
  };

  return cachedEnv;
}

export function resetServerEnvForTests() {
  cachedEnv = undefined;
}
