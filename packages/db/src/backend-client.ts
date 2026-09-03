const DEFAULT_BACKEND_TIMEOUT_MS = 10_000;

export type BackendFetchInit = RequestInit & {
  /** Overrides {@link DEFAULT_BACKEND_TIMEOUT_MS}; pass `0` to opt out. */
  timeoutMs?: number;
  /** Set `false` for routes the backend authenticates itself (Bearer tokens on `/api/v1/*`), so a proxy bug cannot become an internal-RPC call. */
  attachInternalSecret?: boolean;
};

export function getBackendUrl() {
  const backendUrl = process.env.BACKEND_URL;
  if (!backendUrl && process.env.NODE_ENV === "production") {
    throw new Error("BACKEND_URL is required to call the Rust backend in production.");
  }

  return (backendUrl ?? "http://127.0.0.1:4000").replace(/\/$/, "");
}

// Rejects traversal segments before WHATWG normalization can rewrite `/api/v1/../../internal/rpc` into `/internal/rpc` and leak the internal secret.
export function resolveBackendUrl(path: string) {
  if (!path.startsWith("/")) {
    throw new Error("Backend path must be absolute.");
  }

  const queryIndex = path.search(/[?#]/);
  const pathname = queryIndex === -1 ? path : path.slice(0, queryIndex);

  for (const segment of pathname.split("/")) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("Backend path contains an invalid escape sequence.");
    }

    if (
      segment === "." ||
      segment === ".." ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    ) {
      throw new Error("Backend path must not contain traversal segments.");
    }
  }

  const backendUrl = getBackendUrl();
  const resolved = new URL(`${backendUrl}${path}`);

  if (resolved.origin !== new URL(backendUrl).origin) {
    throw new Error("Backend path must stay on the backend origin.");
  }

  return resolved;
}

export async function backendFetch(path: string, init: BackendFetchInit = {}) {
  const {
    timeoutMs = DEFAULT_BACKEND_TIMEOUT_MS,
    attachInternalSecret = true,
    signal,
    ...rest
  } = init;
  const url = resolveBackendUrl(path);
  const headers = new Headers(rest.headers);
  if (!headers.has("Content-Type") && typeof rest.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  // A client-supplied secret header must never survive into the backend request.
  headers.delete("x-backend-internal-secret");
  if (attachInternalSecret) {
    const backendInternalSecret = process.env.BACKEND_INTERNAL_SECRET?.trim();
    if (backendInternalSecret) {
      headers.set("x-backend-internal-secret", backendInternalSecret);
    } else if (process.env.NODE_ENV === "production") {
      throw new Error("BACKEND_INTERNAL_SECRET is required to call the Rust backend.");
    }
  }

  // Without this the Next.js worker inherits undici's 300s default and hangs for as long as the backend does.
  const signals = [signal, timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null].filter(
    (value): value is AbortSignal => value != null,
  );

  return fetch(url, {
    ...rest,
    headers,
    ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
  });
}

export async function backendRpc<T>(
  op: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const response = await backendFetch("/internal/rpc", {
    method: "POST",
    body: JSON.stringify({ op, args }),
  });

  const payload = (await response.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error?: { code?: string; message?: string } }
    | null;

  if (!response.ok || !payload?.ok) {
    throw new BackendError(
      payload && "error" in payload && payload.error?.message
        ? payload.error.message
        : `Backend operation ${op} failed with status ${response.status}.`,
      payload && "error" in payload ? payload.error?.code : undefined,
      response.status,
    );
  }

  return payload.data;
}

/** Carries the backend's stable `error.code` so callers can map on it. */
export class BackendError extends Error {
  readonly code: string | undefined;
  readonly status: number;

  constructor(message: string, code: string | undefined, status: number) {
    super(message);
    this.name = "BackendError";
    this.code = code;
    this.status = status;
  }
}
