import { NextResponse } from "next/server";

import { lookupCustomBarcodeProduct } from "@macro-tracker/db";

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

  // 0. Check our community catalogue first — fastest and most reliable.
  //    Wrapped in try/catch so a database error never blocks the external
  //    provider chain that follows.
  try {
    const customProduct = await lookupCustomBarcodeProduct(barcode);
    if (customProduct) {
      return NextResponse.json({
        found: true,
        product: {
          name: customProduct.name,
          brands: customProduct.brands,
          barcode: customProduct.barcode,
          proteinG: customProduct.proteinG,
          carbsG: customProduct.carbsG,
          fatG: customProduct.fatG,
          caloriesKcal: customProduct.caloriesKcal,
          servingSizeG: customProduct.servingSizeG,
          imageUrl: null,
          source: "custom",
        },
      });
    }
  } catch {
    // Database unavailable — fall through to external providers
  }

  // 1–3. Fall back to the external provider chain (OFF → AH → Jumbo)
  try {
    const result = await lookupBarcodeChain(barcode);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ found: false, barcode }, { status: 502 });
  }
}
