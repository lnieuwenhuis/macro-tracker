import { backendFetch } from "@macro-tracker/db";

import { createBackendProxyResponse } from "@/lib/backend-response";

export const maxDuration = 300;

export async function POST(request: Request) {
  const headers = new Headers(request.headers);
  headers.delete("host");

  const response = await backendFetch("/api/admin/ai-model-benchmark", {
    method: "POST",
    headers,
    body: request.body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  return createBackendProxyResponse(response);
}
