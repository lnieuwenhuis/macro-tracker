import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

const TEST_ROUTE_SECRET_HEADER = "x-test-route-secret";

type TestRouteEnv = {
  enableTestRoutes: boolean;
  testRoutesSecret: string | undefined;
};

// Hash first: timingSafeEqual requires equal-length buffers, and unhashed lengths would leak the secret's length.
function secretsMatch(candidate: string, expected: string) {
  return timingSafeEqual(
    createHash("sha256").update(candidate).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

function hasValidTestRouteSecret(request: Request, env: TestRouteEnv) {
  const provided = request.headers.get(TEST_ROUTE_SECRET_HEADER);

  if (!env.testRoutesSecret || provided === null) {
    return false;
  }

  return secretsMatch(provided, env.testRoutesSecret);
}

// Both failure modes answer 404; a distinct status for a wrong secret would tell a prober test routes are enabled here.
export function ensureTestRouteRequest(request: Request, env: TestRouteEnv) {
  if (!env.enableTestRoutes || !hasValidTestRouteSecret(request, env)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  return null;
}
