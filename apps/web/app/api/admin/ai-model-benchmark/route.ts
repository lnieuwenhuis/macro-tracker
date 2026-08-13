import { proxyBackendRoute } from "@/lib/backend-response";

export const maxDuration = 300;

// Matches `maxDuration`: the backend's own runtime budget is 270s, so the proxy
// must not give up before the route it is fronting does.
const BENCHMARK_TIMEOUT_MS = 300_000;

export async function POST(request: Request) {
  return proxyBackendRoute(
    request,
    "/api/admin/ai-model-benchmark",
    {
      ok: false,
      error: "Benchmark service is unavailable.",
    },
    { timeoutMs: BENCHMARK_TIMEOUT_MS },
  );
}
