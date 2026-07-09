import { backendFetch } from "@macro-tracker/db";

import { createBackendProxyResponse } from "@/lib/backend-response";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ barcode: string }> },
) {
  const { barcode } = await params;
  const headers = new Headers(request.headers);
  headers.delete("host");

  const response = await backendFetch(`/api/barcode/${encodeURIComponent(barcode)}`, {
    headers,
  });

  return createBackendProxyResponse(response);
}
