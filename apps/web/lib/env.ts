type ServerEnv = {
  appUrl: string;
  sessionSecret: string;
  shooBaseUrl: string;
  allowedEmails: string[];
  enableTestRoutes: boolean;
};

let cachedEnv: ServerEnv | undefined;

function readRequiredEnv(name: string, fallback?: string) {
  const value = process.env[name] ?? fallback;

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function parseAllowedEmails(value: string) {
  return value
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
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
    allowedEmails: parseAllowedEmails(process.env.ALLOWED_EMAILS ?? ""),
    enableTestRoutes:
      process.env.NODE_ENV === "test" ||
      process.env.ENABLE_TEST_ROUTES === "true",
  };

  return cachedEnv;
}

export function resetServerEnvForTests() {
  cachedEnv = undefined;
}
