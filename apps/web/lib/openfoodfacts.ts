export type OpenFoodFactsProduct = {
  name: string;
  brands: string;
  barcode: string;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
  servingSizeG: number | null;
  imageUrl: string | null;
  /** Which data source provided this result */
  source?: "openfoodfacts" | "albert_heijn" | "jumbo";
};

export type OpenFoodFactsResult =
  | { found: true; product: OpenFoodFactsProduct }
  | { found: false; barcode: string };

/**
 * Look up a barcode via our server-side API route.
 *
 * The route chains three providers:
 *   1. OpenFoodFacts (free, public)
 *   2. Albert Heijn (unofficial mobile API)
 *   3. Jumbo (unofficial mobile API)
 *
 * This avoids CORS issues with the supermarket APIs and keeps
 * token management server-side.
 */
export async function lookupBarcode(
  barcode: string,
  signal?: AbortSignal,
): Promise<OpenFoodFactsResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  // Respect an externally provided signal as well
  signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const response = await fetch(`/api/barcode/${encodeURIComponent(barcode)}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return { found: false, barcode };
    }

    const data = await response.json();

    if (!data.found || !data.product) {
      return { found: false, barcode };
    }

    return {
      found: true,
      product: {
        name: data.product.name ?? "Unknown product",
        brands: data.product.brands ?? "",
        barcode: data.product.barcode ?? barcode,
        proteinG: data.product.proteinG ?? 0,
        carbsG: data.product.carbsG ?? 0,
        fatG: data.product.fatG ?? 0,
        caloriesKcal: data.product.caloriesKcal ?? 0,
        servingSizeG: data.product.servingSizeG ?? null,
        imageUrl: data.product.imageUrl ?? null,
        source: data.product.source ?? "openfoodfacts",
      },
    };
  } catch {
    clearTimeout(timeoutId);
    return { found: false, barcode };
  }
}
