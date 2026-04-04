import { NextResponse } from "next/server";

import { lookupBarcodeChain } from "@/lib/barcode-providers";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ barcode: string }> },
) {
  const { barcode } = await params;

  if (!barcode || barcode.length < 4 || barcode.length > 20) {
    return NextResponse.json(
      { found: false, barcode, error: "Invalid barcode" },
      { status: 400 },
    );
  }

  const result = await lookupBarcodeChain(barcode);
  return NextResponse.json(result);
}
