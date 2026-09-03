export type FoodPhotoEstimate = {
  label: string;
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  confidence: number;
  notes: string[];
};

type FoodPhotoAnalysis =
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

// Mirrors the backend's defaults for the AI gateway; the effort suffix is translated into the reasoning parameter.
export const DEFAULT_FOOD_PHOTO_MODELS = [
  "gpt-5.6-luna(low)",
  "gpt-5.6-luna(medium)",
] as const;

function parseModelList(value: string | undefined) {
  return (
    value
      ?.split(/[\n,]/)
      .map((model) => model.trim())
      .filter(Boolean) ?? []
  );
}

export function getConfiguredFoodPhotoModels() {
  const models = [...new Set(parseModelList(process.env.AI_GATEWAY_MODELS))];
  return models.length > 0 ? models : [...DEFAULT_FOOD_PHOTO_MODELS];
}

export function getConfiguredFoodPhotoModel() {
  return getConfiguredFoodPhotoModels()[0] ?? DEFAULT_FOOD_PHOTO_MODELS[0];
}
