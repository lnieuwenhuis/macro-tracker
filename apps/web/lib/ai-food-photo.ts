export type FoodPhotoEstimate = {
  label: string;
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  confidence: number;
  notes: string[];
};

export type FoodPhotoAnalysis =
  | {
      status: "ready";
      question: null;
      estimate: FoodPhotoEstimate;
    }
  | {
      status: "needs_clarification";
      question: string;
      estimate: null;
    };

export type AnalyzeFoodPhotoFailureKind =
  | "missing_api_key"
  | "invalid_image"
  | "provider_rate_limit"
  | "provider_quota"
  | "provider_image_access"
  | "provider_error"
  | "empty_response"
  | "invalid_json"
  | "unsupported_model"
  | "unknown";

export type AnalyzeFoodPhotoResult =
  | { ok: true; analysis: FoodPhotoAnalysis }
  | {
      ok: false;
      error: string;
      kind: AnalyzeFoodPhotoFailureKind;
      statusCode?: number;
      aiResponse?: string;
      retryable?: boolean;
    };

export const DEFAULT_FOOD_PHOTO_MODEL =
  "google/gemma-4-26b-a4b-it:free";
export const DEFAULT_FOOD_PHOTO_FALLBACK_MODELS = [
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-nano-12b-v2-vl:free",
  "openrouter/free",
] as const;

const DEPRECATED_FOOD_PHOTO_MODELS = new Set([
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
]);

function parseModelList(value: string | undefined) {
  return (
    value
      ?.split(/[\n,]/)
      .map((model) => model.trim())
      .filter(Boolean) ?? []
  );
}

export function isFreeOpenRouterModel(model: string) {
  const trimmedModel = model.trim();
  return trimmedModel === "openrouter/free" || trimmedModel.endsWith(":free");
}

function uniqueFreeFoodPhotoModels(models: string[]) {
  const seen = new Set<string>();
  return models.filter((model) => {
    const trimmedModel = model.trim();
    if (
      !trimmedModel ||
      !isFreeOpenRouterModel(trimmedModel) ||
      DEPRECATED_FOOD_PHOTO_MODELS.has(trimmedModel) ||
      seen.has(trimmedModel)
    ) {
      return false;
    }
    seen.add(trimmedModel);
    return true;
  });
}

export function getConfiguredFoodPhotoModels() {
  const configuredPrimary = process.env.OPENROUTER_MODEL?.trim();
  const primary =
    configuredPrimary &&
    isFreeOpenRouterModel(configuredPrimary) &&
    !DEPRECATED_FOOD_PHOTO_MODELS.has(configuredPrimary)
      ? configuredPrimary
      : DEFAULT_FOOD_PHOTO_MODEL;
  const configuredFallbacks = parseModelList(
    process.env.OPENROUTER_FALLBACK_MODELS,
  );
  const fallbacks =
    configuredFallbacks.length > 0
      ? configuredFallbacks
      : [...DEFAULT_FOOD_PHOTO_FALLBACK_MODELS];
  const models = uniqueFreeFoodPhotoModels([primary, ...fallbacks]);

  return models.length > 0 ? models : [DEFAULT_FOOD_PHOTO_MODEL];
}

export function getConfiguredFoodPhotoModel() {
  return getConfiguredFoodPhotoModels()[0] ?? DEFAULT_FOOD_PHOTO_MODEL;
}
