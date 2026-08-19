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

const PRODUCT_SOURCES = new Set<OpenFoodFactsProduct["source"]>([
  "openfoodfacts",
  "albert_heijn",
  "jumbo",
  "custom",
]);

function readString(value: unknown, fallback: string) {
  return typeof value === "string" && value ? value : fallback;
}

function readNullableString(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

/**
 * Coerces to a finite, non-negative number. `??` alone let a string, `null`
 * inside an object, or `NaN` from the upstream shape through untouched, so a
 * malformed provider response reached React state (and the macro maths) as
 * whatever it happened to be.
 */
function readNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function readNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function readSource(value: unknown): OpenFoodFactsProduct["source"] {
  return typeof value === "string" &&
    PRODUCT_SOURCES.has(value as OpenFoodFactsProduct["source"])
    ? (value as OpenFoodFactsProduct["source"])
    : "openfoodfacts";
}

/**
 * Validates the untyped upstream payload at the trust boundary so nothing past
 * this point has to treat a barcode product as `any`.
 */
function toProduct(raw: unknown, barcode: string): OpenFoodFactsProduct | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }

  const product = raw as Record<string, unknown>;

  return {
    productId: readNullableString(product.productId),
    name: readString(product.name, "Unknown product"),
    brands: readString(product.brands, ""),
    barcode: readString(product.barcode, barcode),
    proteinG: readNumber(product.proteinG, 0),
    carbsG: readNumber(product.carbsG, 0),
    fatG: readNumber(product.fatG, 0),
    caloriesKcal: readNumber(product.caloriesKcal, 0),
    servingSizeG: readNullableNumber(product.servingSizeG),
    imageUrl: readNullableString(product.imageUrl),
    source: readSource(product.source),
  };
}

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

    const data = (await response.json()) as unknown;
    const envelope =
      typeof data === "object" && data !== null
        ? (data as { found?: unknown; product?: unknown })
        : null;

    if (envelope?.found !== true) {
      return { found: false, barcode, reason: "not_found" };
    }

    const product = toProduct(envelope.product, barcode);

    if (!product) {
      // A `found: true` with an unusable body is an upstream problem, not a
      // catalogue miss — telling the user "not found" would invite them to
      // re-enter a product that already exists.
      console.error(`Barcode lookup for ${barcode} returned an unusable product`);
      return { found: false, barcode, reason: "unavailable" };
    }

    return { found: true, product };
  } catch (error) {
    // A network error or an abort is not evidence that the product is missing.
    console.error(`Barcode lookup for ${barcode} could not complete`, error);
    return { found: false, barcode, reason: "unavailable" };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
