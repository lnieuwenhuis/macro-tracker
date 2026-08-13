import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appDir, "../..");

/**
 * NOTE: the fallback is `0`, which disables the in-memory data cache entirely —
 * every cacheable `fetch` misses. That is a deliberate memory ceiling for
 * constrained hosting, so set `NEXT_CACHE_MAX_MEMORY_MB` in any environment
 * where cached fetches are expected to hit.
 */
function getCacheMaxMemorySize() {
  const fallbackMb = 0;
  const value = Number(process.env.NEXT_CACHE_MAX_MEMORY_MB ?? fallbackMb);
  const memoryMb = Number.isFinite(value) && value >= 0 ? value : fallbackMb;

  return Math.floor(memoryMb * 1024 * 1024);
}

const isDev = process.env.NODE_ENV === "development";

export const DEFAULT_SHOO_BASE_URL = "https://shoo.dev";

/**
 * Origin the browser talks to directly during sign-in.
 *
 * `@shoojs/auth` runs the code-for-token exchange **in the browser**
 * (`fetch("<shooBaseUrl>/token")`) and re-checks the session against
 * `/session/check`, so the identity provider has to be in `connect-src`.
 *
 * NOTE: `headers()` is evaluated at build time and baked into the routes
 * manifest, so `SHOO_BASE_URL` must be present in the **build** environment,
 * not just at runtime. `buildContentSecurityPolicy` is exported and covered by
 * a unit test so this cannot silently regress again.
 */
export function getShooConnectOrigin(
  shooBaseUrl = process.env.SHOO_BASE_URL ?? DEFAULT_SHOO_BASE_URL,
) {
  try {
    return new URL(shooBaseUrl).origin;
  } catch {
    return new URL(DEFAULT_SHOO_BASE_URL).origin;
  }
}

/**
 * Defence-in-depth. There is no known XSS here (no `dangerouslySetInnerHTML`,
 * no `eval`, `httpOnly` + `SameSite=Lax` cookies), so this exists to bound the
 * damage of a future one.
 *
 * `script-src` keeps `'unsafe-inline'` because the theme and timezone
 * bootstraps run `beforeInteractive`, alongside Next's own inline RSC payload.
 * Tightening that to a nonce requires a per-request nonce in `proxy.ts` and
 * forces every route to render dynamically — worth doing, but it needs a
 * browser verification pass first.
 *
 * `img-src https:` covers supermarket product thumbnails; `blob:` covers the
 * camera preview and the AI photo preview.
 *
 * `form-action` is deliberately **absent**. Chromium enforces it across the
 * whole redirect chain, and this app's forms are all POST-then-redirect —
 * signing out (`/api/auth/logout` → `/login`) and every admin server action
 * that calls `redirect()`. With `form-action 'self'` those submissions are
 * blocked outright and the page silently stays put. The directive only guards
 * against form-jacking to an external origin, and no form here takes a
 * caller-supplied action, so the trade is not worth a broken sign-out.
 */
export function buildContentSecurityPolicy(
  shooOrigin = getShooConnectOrigin(),
  dev = isDev,
) {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${shooOrigin}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

const contentSecurityPolicy = buildContentSecurityPolicy();

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    // `camera=(self)` stays enabled: the barcode scanner needs it.
    value: "camera=(self), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  cacheMaxMemorySize: getCacheMaxMemorySize(),
  experimental: {
    preloadEntriesOnStart: false,
    webpackMemoryOptimizations: true,
  },
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@macro-tracker/db"],
  turbopack: {
    root: repoRoot,
  },
};

export default nextConfig;
