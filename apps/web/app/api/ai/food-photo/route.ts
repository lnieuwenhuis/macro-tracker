import { proxyBackendRoute } from "@/lib/backend-response";

// The backend bounds this path at 25s per model attempt inside a 15s upload
// deadline; give the proxy headroom above that rather than the RPC default.
const FOOD_PHOTO_TIMEOUT_MS = 60_000;

export async function POST(request: Request) {
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
