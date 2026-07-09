export function getBackendUrl() {
  return (process.env.BACKEND_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
}

export async function backendFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  if (process.env.BACKEND_INTERNAL_SECRET) {
    headers.set("x-backend-internal-secret", process.env.BACKEND_INTERNAL_SECRET);
  }

  return fetch(`${getBackendUrl()}${path}`, {
    ...init,
    headers,
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
    | { ok: false; error?: { message?: string } }
    | null;

  if (!response.ok || !payload?.ok) {
    throw new Error(
      payload && "error" in payload && payload.error?.message
        ? payload.error.message
        : `Backend operation ${op} failed with status ${response.status}.`,
    );
  }

  return payload.data;
}
