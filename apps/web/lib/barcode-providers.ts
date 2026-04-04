/**
 * Server-side barcode lookup providers.
 *
 * Chain: OpenFoodFacts → Albert Heijn → Jumbo
 *
 * AH and Jumbo are unofficial mobile APIs — they can break at any time.
 * Each provider is wrapped in try/catch with a timeout so a single
 * failure never blocks the chain.
 */

export type BarcodeProduct = {
  name: string;
  brands: string;
  barcode: string;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
  servingSizeG: number | null;
  imageUrl: string | null;
  source: "openfoodfacts" | "albert_heijn" | "jumbo";
};

export type BarcodeResult =
  | { found: true; product: BarcodeProduct }
  | { found: false; barcode: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 5000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function safeNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 10) / 10;
  }
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return Math.round(parsed * 10) / 10;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 1. OpenFoodFacts (free, public, good EU coverage)
// ---------------------------------------------------------------------------

export async function lookupOpenFoodFacts(
  barcode: string,
): Promise<BarcodeResult> {
  try {
    const res = await fetchWithTimeout(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`,
    );
    if (!res.ok) return { found: false, barcode };

    const data = await res.json();
    if (data.status !== 1 || !data.product) return { found: false, barcode };

    const p = data.product;
    const n = p.nutriments ?? {};

    const name =
      p.product_name ||
      p.product_name_nl ||
      p.product_name_en ||
      "Unknown product";

    const brands = p.brands || "";
    const servingQuantity = p.serving_quantity;
    const servingSizeG =
      typeof servingQuantity === "number" && servingQuantity > 0
        ? servingQuantity
        : null;

    return {
      found: true,
      product: {
        name,
        brands,
        barcode,
        proteinG: safeNumber(n["proteins_100g"]),
        carbsG: safeNumber(n["carbohydrates_100g"]),
        fatG: safeNumber(n["fat_100g"]),
        caloriesKcal: Math.round(safeNumber(n["energy-kcal_100g"])),
        servingSizeG,
        imageUrl: p.image_front_small_url || p.image_url || null,
        source: "openfoodfacts",
      },
    };
  } catch {
    return { found: false, barcode };
  }
}

// ---------------------------------------------------------------------------
// 2. Albert Heijn (unofficial mobile API)
// ---------------------------------------------------------------------------

let ahTokenCache: { token: string; expiresAt: number } | null = null;

async function getAhToken(): Promise<string | null> {
  // Re-use cached token if still valid
  if (ahTokenCache && ahTokenCache.expiresAt > Date.now()) {
    return ahTokenCache.token;
  }

  try {
    const res = await fetchWithTimeout(
      "https://api.ah.nl/mobile-auth/v1/auth/token/anonymous",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Appie/8.8.2 Model/phone Android/7.0-API24",
          "x-application": "AHWEBSHOP",
        },
        body: JSON.stringify({ clientId: "appie" }),
      },
      4000,
    );

    if (!res.ok) return null;
    const data = await res.json();
    const token = data.access_token;
    if (typeof token !== "string" || !token) return null;

    // Cache for 25 min (tokens typically last 30 min)
    ahTokenCache = { token, expiresAt: Date.now() + 25 * 60 * 1000 };
    return token;
  } catch {
    return null;
  }
}

/**
 * Parse Dutch-style nutrition table returned by AH product detail.
 *
 * The table can come in various shapes — an array of nutrient objects or
 * a nested structure. We try to extract the four macros we care about.
 */
function parseAhNutrients(raw: unknown): {
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
} | null {
  const result = { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  let found = false;

  function walk(items: unknown[]) {
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;

      const name = String(obj.name ?? obj.title ?? obj.key ?? "").toLowerCase();
      const raw = obj.value ?? obj.valuePer100g ?? obj.per100g ?? 0;
      const value = typeof raw === "number" ? raw : parseFloat(String(raw)) || 0;

      if (name.includes("energie") || name.includes("energy")) {
        // Only pick kcal, not kJ
        const unit = String(obj.unit ?? "").toLowerCase();
        if (unit.includes("kcal") || name.includes("kcal")) {
          result.caloriesKcal = Math.round(value);
          found = true;
        }
      } else if (name.includes("eiwit") || name.includes("protein")) {
        result.proteinG = safeNumber(value);
        found = true;
      } else if (name.includes("koolhydra") || name.includes("carbohydra")) {
        // Total carbs, not sugars
        if (!name.includes("suiker") && !name.includes("sugar")) {
          result.carbsG = safeNumber(value);
          found = true;
        }
      } else if (name.includes("vet") || name.includes("fat")) {
        // Total fat, not saturated
        if (
          !name.includes("verzadigd") &&
          !name.includes("saturat") &&
          !name.includes("onverzadigd")
        ) {
          result.fatG = safeNumber(value);
          found = true;
        }
      }

      // Recurse into sub-nutrients
      const children = obj.nutrients ?? obj.children ?? obj.subNutrients;
      if (Array.isArray(children)) walk(children);
    }
  }

  if (Array.isArray(raw)) {
    walk(raw);
  } else if (raw && typeof raw === "object") {
    // Might be { nutrients: [...] }
    const obj = raw as Record<string, unknown>;
    const inner = obj.nutrients ?? obj.nutritionTable ?? obj.values;
    if (Array.isArray(inner)) walk(inner);
  }

  return found ? result : null;
}

export async function lookupAlbertHeijn(
  barcode: string,
): Promise<BarcodeResult> {
  try {
    const token = await getAhToken();
    if (!token) return { found: false, barcode };

    const headers: Record<string, string> = {
      "User-Agent": "Appie/8.8.2 Model/phone Android/7.0-API24",
      "x-application": "AHWEBSHOP",
      Authorization: `Bearer ${token}`,
    };

    // Step 1: Search by GTIN (barcode)
    const searchRes = await fetchWithTimeout(
      `https://api.ah.nl/mobile-services/product/search/v2?query=${encodeURIComponent(barcode)}&size=1`,
      { headers },
      5000,
    );

    if (!searchRes.ok) return { found: false, barcode };
    const searchData = await searchRes.json();

    // Response shapes vary — try common patterns
    const cards =
      searchData.cards ??
      searchData.products ??
      (Array.isArray(searchData) ? searchData : []);
    const firstCard = cards[0];
    const product = firstCard?.products?.[0] ?? firstCard;
    if (!product) return { found: false, barcode };

    const title: string =
      product.title ?? product.description ?? "Unknown product";
    const brand: string = product.brand ?? "Albert Heijn";
    const imageUrl: string | null =
      product.images?.[0]?.url ?? product.image ?? null;

    // Step 2: Try product detail for nutritional info
    const productId =
      product.webshopId ?? product.hqId ?? product.id ?? product.productId;

    let macros = { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };

    if (productId) {
      try {
        const detailRes = await fetchWithTimeout(
          `https://api.ah.nl/mobile-services/product/detail/v4/fir/${productId}`,
          { headers },
          5000,
        );

        if (detailRes.ok) {
          const detail = await detailRes.json();
          const nutritionRaw =
            detail.nutritionInfo ??
            detail.nutritionTable ??
            detail.nutrients ??
            detail.nix;
          const parsed = parseAhNutrients(nutritionRaw);
          if (parsed) macros = parsed;
        }
      } catch {
        // Detail fetch failed — we still have the product name
      }
    }

    return {
      found: true,
      product: {
        name: title,
        brands: brand,
        barcode,
        ...macros,
        servingSizeG: null,
        imageUrl,
        source: "albert_heijn",
      },
    };
  } catch {
    return { found: false, barcode };
  }
}

// ---------------------------------------------------------------------------
// 3. Jumbo (unofficial mobile API)
// ---------------------------------------------------------------------------

function parseJumboNutrients(raw: unknown): {
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
} | null {
  const result = { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  let found = false;

  if (!raw || typeof raw !== "object") return null;

  // Jumbo nutrients can be an object keyed by nutrient name, or an array
  const entries: Array<[string, unknown]> = Array.isArray(raw)
    ? raw.map((item: unknown, i: number) => {
        if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          return [String(o.name ?? o.key ?? i), o] as [string, unknown];
        }
        return [String(i), item] as [string, unknown];
      })
    : Object.entries(raw);

  for (const [key, val] of entries) {
    const k = key.toLowerCase();
    const numVal =
      typeof val === "number"
        ? val
        : typeof val === "object" && val !== null
          ? parseFloat(
              String(
                (val as Record<string, unknown>).value ??
                  (val as Record<string, unknown>).per100g ??
                  0,
              ),
            ) || 0
          : parseFloat(String(val)) || 0;

    if (k.includes("energie") || k.includes("energy") || k.includes("calor")) {
      if (k.includes("kcal")) {
        result.caloriesKcal = Math.round(numVal);
        found = true;
      }
    } else if (k.includes("eiwit") || k.includes("protein")) {
      result.proteinG = safeNumber(numVal);
      found = true;
    } else if (k.includes("koolhydra") || k.includes("carb")) {
      if (!k.includes("suiker") && !k.includes("sugar")) {
        result.carbsG = safeNumber(numVal);
        found = true;
      }
    } else if (k.includes("vet") || k.includes("fat")) {
      if (!k.includes("verzadigd") && !k.includes("saturat")) {
        result.fatG = safeNumber(numVal);
        found = true;
      }
    }
  }

  return found ? result : null;
}

export async function lookupJumbo(barcode: string): Promise<BarcodeResult> {
  try {
    // Step 1: Search by barcode string
    const searchRes = await fetchWithTimeout(
      `https://mobileapi.jumbo.com/v17/search?q=${encodeURIComponent(barcode)}&offset=0&limit=1`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36",
        },
      },
      5000,
    );

    if (!searchRes.ok) return { found: false, barcode };
    const searchData = await searchRes.json();

    const products = searchData.products?.data ?? [];
    if (products.length === 0) return { found: false, barcode };

    const product = products[0];
    const title: string = product.title ?? "Unknown product";
    const imageUrl: string | null =
      product.imageInfo?.primaryView?.[0]?.url ?? null;
    const productId: string | null = product.id ?? null;

    let macros = { caloriesKcal: 0, proteinG: 0, carbsG: 0, fatG: 0 };

    // Step 2: Try product detail for nutritional data
    if (productId) {
      try {
        const detailRes = await fetchWithTimeout(
          `https://mobileapi.jumbo.com/v17/products/${encodeURIComponent(productId)}`,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36",
            },
          },
          5000,
        );

        if (detailRes.ok) {
          const detail = await detailRes.json();
          const nutritionRaw =
            detail.product?.data?.nutritionInfo ??
            detail.product?.data?.nutrients ??
            detail.data?.nutritionInfo ??
            detail.data?.nutrients ??
            detail.nutritionInfo ??
            detail.nutrients;
          const parsed = parseJumboNutrients(nutritionRaw);
          if (parsed) macros = parsed;
        }
      } catch {
        // Detail fetch failed — continue with product name only
      }
    }

    return {
      found: true,
      product: {
        name: title,
        brands: "Jumbo",
        barcode,
        ...macros,
        servingSizeG: null,
        imageUrl,
        source: "jumbo",
      },
    };
  } catch {
    return { found: false, barcode };
  }
}

// ---------------------------------------------------------------------------
// Main chain: OFF → AH → Jumbo
// ---------------------------------------------------------------------------

export async function lookupBarcodeChain(
  barcode: string,
): Promise<BarcodeResult> {
  // 1. Try OpenFoodFacts first (best coverage, most reliable)
  const offResult = await lookupOpenFoodFacts(barcode);
  if (offResult.found) return offResult;

  // 2. Try Albert Heijn
  const ahResult = await lookupAlbertHeijn(barcode);
  if (ahResult.found) return ahResult;

  // 3. Try Jumbo
  const jumboResult = await lookupJumbo(barcode);
  if (jumboResult.found) return jumboResult;

  return { found: false, barcode };
}
