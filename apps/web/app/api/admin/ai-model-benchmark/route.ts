import { proxyBackendRoute } from "@/lib/backend-response";

export const maxDuration = 300;

export async function POST(request: Request) {
  return proxyBackendRoute(request, "/api/admin/ai-model-benchmark", {
    ok: false,
    error: "Benchmark service is unavailable.",
  });
}
