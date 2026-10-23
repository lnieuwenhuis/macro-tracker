import { proxyBackendRoute } from "@/lib/backend-response";
import { isSameOriginRequest } from "@/lib/request";

// Backend bounds this at 25s per model attempt inside a 15s upload deadline; give the proxy headroom above that.
const FOOD_PHOTO_TIMEOUT_MS = 60_000;

export async function POST(request: Request) {
  // SEC-03: SameSite=Lax still sends cookies on same-site requests, so a sibling origin could spend
  // the shared paid provider budget; only this app's own pages may reach the gateway.
  if (!isSameOriginRequest(request)) {
    return Response.json(
      { kind: "forbidden", error: "This request must come from the app itself." },
      { status: 403 },
    );
  }

  return proxyBackendRoute(
    request,
    "/api/ai/food-photo",
    {
      kind: "backend_unavailable",
      error: "Food photo analysis service is unavailable.",
    },
    { timeoutMs: FOOD_PHOTO_TIMEOUT_MS },
  );
}
