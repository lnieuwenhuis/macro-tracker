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
  source?: "openfoodfacts" | "albert_heijn" | "jumbo" | "custom";
};

// Distinguishes a genuine catalogue miss ("not_found") from "we could not ask" ("unavailable").
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

function readString(value: unknown, fallback: string): string;
function readString(value: unknown, fallback: null): string | null;
function readString(value: unknown, fallback: string | null) {
  return typeof value === "string" && value ? value : fallback;
}

function readNullableString(value: unknown) {
  return readString(value, null);
}

// Rejects non-finite/negative/non-number upstream values instead of letting them reach the macro maths.
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

// Validates the untyped upstream payload so nothing past this point treats a barcode product as `any`.
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

// The API route chains OpenFoodFacts, Albert Heijn and Jumbo server-side, avoiding supermarket-API CORS and keeping tokens off the client.
export async function lookupBarcode(
  barcode: string,
  signal?: AbortSignal,
): Promise<OpenFoodFactsResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  // Detached in `finally`, otherwise a long-lived caller signal keeps every controller reachable.
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
      // An unusable body with `found: true` is an upstream problem, not a catalogue miss.
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
