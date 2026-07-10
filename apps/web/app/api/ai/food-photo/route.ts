import { backendFetch } from "@macro-tracker/db";
import { NextResponse } from "next/server";

import { createBackendProxyResponse } from "@/lib/backend-response";

export async function POST(request: Request) {
  const headers = new Headers(request.headers);
  headers.delete("host");

  let response: Response;
  try {
    response = await backendFetch("/api/ai/food-photo", {
      method: "POST",
      headers,
      body: request.body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch {
    return NextResponse.json(
      { kind: "backend_unavailable", error: "Food photo analysis service is unavailable." },
      { status: 502 },
    );
  }

  return createBackendProxyResponse(response);
}
