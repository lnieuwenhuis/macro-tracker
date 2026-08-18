import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

const TEST_ROUTE_SECRET_HEADER = "x-test-route-secret";

type TestRouteEnv = {
  enableTestRoutes: boolean;
  testRoutesSecret: string | undefined;
};

/**
 * `timingSafeEqual` requires equal-length buffers and throws otherwise, which
 * would leak the secret's length. Hashing first gives both operands a fixed
 * 32-byte length, so only the digests are compared.
 */
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

/**
 * Both failure modes answer `404`. Returning `403` for a wrong secret and `404`
 * when the routes are disabled told a prober that `ENABLE_TEST_ROUTES=true` on
 * this deployment, which is the one bit worth hiding here.
 */
export function ensureTestRouteRequest(request: Request, env: TestRouteEnv) {
  if (!env.enableTestRoutes || !hasValidTestRouteSecret(request, env)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  return null;
}
