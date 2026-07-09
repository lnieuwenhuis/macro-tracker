import { backendFetch } from "@macro-tracker/db";
import { NextResponse } from "next/server";

import { createBackendProxyResponse } from "@/lib/backend-response";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ barcode: string }> },
) {
  const { barcode } = await params;
  const headers = new Headers(request.headers);
  headers.delete("host");

  let response: Response;
  try {
    response = await backendFetch(`/api/barcode/${encodeURIComponent(barcode)}`, {
      headers,
    });
  } catch {
    return NextResponse.json(
      { found: false, error: "Barcode lookup service is unavailable." },
      { status: 502 },
    );
  }

  return createBackendProxyResponse(response);
}
