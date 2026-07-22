import { proxyBackendRoute } from "@/lib/backend-response";

export async function POST(request: Request) {
  return proxyBackendRoute(request, "/api/ai/food-photo", {
    kind: "backend_unavailable",
    error: "Food photo analysis service is unavailable.",
  });
}
