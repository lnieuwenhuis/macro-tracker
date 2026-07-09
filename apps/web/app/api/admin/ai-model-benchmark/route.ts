import { backendFetch } from "@macro-tracker/db";
import { NextResponse } from "next/server";

import { createBackendProxyResponse } from "@/lib/backend-response";

export const maxDuration = 300;

export async function POST(request: Request) {
  const headers = new Headers(request.headers);
  headers.delete("host");

  let response: Response;
  try {
    response = await backendFetch("/api/admin/ai-model-benchmark", {
      method: "POST",
      headers,
      body: request.body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Benchmark service is unavailable." },
      { status: 502 },
    );
  }

  return createBackendProxyResponse(response);
}
