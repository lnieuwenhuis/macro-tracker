export type OpenFoodFactsProduct = {
  productId?: string | null;
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
  source?: "openfoodfacts" | "albert_heijn" | "jumbo" | "custom";
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

  // Respect an externally provided signal as well. Detached in `finally`,
  // otherwise a long-lived caller signal keeps every controller reachable.
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const response = await fetch(`/api/barcode/${encodeURIComponent(barcode)}`, {
      signal: controller.signal,
    });

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
        productId: data.product.productId ?? null,
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
    return { found: false, barcode };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
