import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appDir, "../..");

// Fallback 0 disables the in-memory data cache (memory ceiling for constrained hosting); set NEXT_CACHE_MAX_MEMORY_MB to enable it.
function getCacheMaxMemorySize() {
  const fallbackMb = 0;
  const value = Number(process.env.NEXT_CACHE_MAX_MEMORY_MB ?? fallbackMb);
  const memoryMb = Number.isFinite(value) && value >= 0 ? value : fallbackMb;

  return Math.floor(memoryMb * 1024 * 1024);
}

// Content-Security-Policy is not here: it needs a per-request nonce, but headers() is baked into the routes manifest at build time; it lives in proxy.ts instead.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    // camera=(self): the barcode scanner needs it. interest-cohort=() dropped: FLoC is withdrawn.
    value: "camera=(self), microphone=(), geolocation=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Safe because @shoojs/auth signs in via a full-page redirect, not a popup with a window.opener.
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
