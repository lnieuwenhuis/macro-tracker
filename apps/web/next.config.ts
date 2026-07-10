import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appDir, "../..");

function getCacheMaxMemorySize() {
  const fallbackMb = 8;
  const value = Number(process.env.NEXT_CACHE_MAX_MEMORY_MB ?? fallbackMb);
  const memoryMb = Number.isFinite(value) && value >= 0 ? value : fallbackMb;

  return Math.floor(memoryMb * 1024 * 1024);
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
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
