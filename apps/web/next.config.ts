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

/**
 * `Content-Security-Policy` is deliberately **not** in this list.
 *
 * The policy carries a per-request `script-src` nonce, and `headers()` is
 * evaluated once at build time and baked into the routes manifest — it cannot
 * carry a per-request value. The whole policy therefore lives in `proxy.ts`,
 * which is also the only place that can put it on the *request* headers, where
 * Next reads the nonce back out during server rendering. Do not add a static
 * CSP here: a second policy would be enforced alongside the nonce policy and
 * would silently become the weakest link the moment the two drift apart.
 *
 * `buildContentSecurityPolicy` is exported from `proxy.ts` and unit tested in
 * `tests/unit/security-headers.test.ts`.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    // `camera=(self)` stays enabled: the barcode scanner needs it.
    // `interest-cohort=()` is gone — FLoC was withdrawn and no browser parses
    // it, so it only risked invalidating the whole header on a strict parser.
    value: "camera=(self), microphone=(), geolocation=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Safe here because `@shoojs/auth` signs in with a full-page
  // `window.location.assign` redirect rather than a popup, so nothing in this
  // app depends on a cross-origin `window.opener` relationship.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
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
