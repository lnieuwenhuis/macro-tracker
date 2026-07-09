import { backendFetch } from "@macro-tracker/db";

import { createBackendProxyResponse } from "@/lib/backend-response";

export async function POST(request: Request) {
  const headers = new Headers(request.headers);
  headers.delete("host");

  const response = await backendFetch("/api/ai/food-photo", {
    method: "POST",
    headers,
    body: request.body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  return createBackendProxyResponse(response);
}
