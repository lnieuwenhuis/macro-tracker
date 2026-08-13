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

/**
 * `reason` distinguishes a genuine catalogue miss from "we could not ask".
 * Without it a backend outage was presented to the user as "product not
 * found", which invites them to re-enter a product that already exists.
 */
export type BarcodeLookupFailureReason = "not_found" | "unavailable";

export type OpenFoodFactsResult =
  | { found: true; product: OpenFoodFactsProduct }
  | { found: false; barcode: string; reason: BarcodeLookupFailureReason };

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
      console.error(
        `Barcode lookup for ${barcode} failed with status ${response.status}`,
      );
      return { found: false, barcode, reason: "unavailable" };
    }

    const data = await response.json();

    if (!data.found || !data.product) {
      return { found: false, barcode, reason: "not_found" };
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
  } catch (error) {
    // A network error or an abort is not evidence that the product is missing.
    console.error(`Barcode lookup for ${barcode} could not complete`, error);
    return { found: false, barcode, reason: "unavailable" };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
