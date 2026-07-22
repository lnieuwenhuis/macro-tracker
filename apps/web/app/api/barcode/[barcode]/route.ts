import { proxyBackendRoute } from "@/lib/backend-response";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ barcode: string }> },
) {
  const { barcode } = await params;
  return proxyBackendRoute(request, `/api/barcode/${encodeURIComponent(barcode)}`, {
    found: false,
    error: "Barcode lookup service is unavailable.",
  });
}
