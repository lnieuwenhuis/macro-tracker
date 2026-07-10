import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FOOD_PHOTO_FALLBACK_MODELS,
  DEFAULT_FOOD_PHOTO_MODEL,
  getConfiguredFoodPhotoModel,
  getConfiguredFoodPhotoModels,
  isFreeOpenRouterModel,
} from "@/lib/ai-food-photo";

const originalModel = process.env.OPENROUTER_MODEL;
const originalFallbackModels = process.env.OPENROUTER_FALLBACK_MODELS;

afterEach(() => {
  if (originalModel === undefined) {
    delete process.env.OPENROUTER_MODEL;
  } else {
    process.env.OPENROUTER_MODEL = originalModel;
  }

  if (originalFallbackModels === undefined) {
    delete process.env.OPENROUTER_FALLBACK_MODELS;
  } else {
    process.env.OPENROUTER_FALLBACK_MODELS = originalFallbackModels;
  }
});

describe("food photo OpenRouter model config", () => {
  it("uses the free defaults", () => {
    delete process.env.OPENROUTER_MODEL;
    delete process.env.OPENROUTER_FALLBACK_MODELS;

    expect(getConfiguredFoodPhotoModel()).toBe(DEFAULT_FOOD_PHOTO_MODEL);
    expect(getConfiguredFoodPhotoModels()).toEqual([
      DEFAULT_FOOD_PHOTO_MODEL,
      ...DEFAULT_FOOD_PHOTO_FALLBACK_MODELS,
    ]);
  });

  it("rejects paid, duplicate, and deprecated configured models", () => {
    process.env.OPENROUTER_MODEL =
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free";
    process.env.OPENROUTER_FALLBACK_MODELS = [
      "openai/gpt-4o-mini",
      "google/gemma-4-31b-it:free",
      "google/gemma-4-31b-it:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      "openrouter/free",
    ].join(",");

    expect(getConfiguredFoodPhotoModels()).toEqual([
      DEFAULT_FOOD_PHOTO_MODEL,
      "google/gemma-4-31b-it:free",
      "openrouter/free",
    ]);
  });

  it("allows only OpenRouter free model identifiers", () => {
    expect(isFreeOpenRouterModel("google/gemma-4-26b-a4b-it:free")).toBe(true);
    expect(isFreeOpenRouterModel("openrouter/free")).toBe(true);
    expect(isFreeOpenRouterModel("openai/gpt-4o-mini")).toBe(false);
    expect(isFreeOpenRouterModel("openai/gpt-oss-20b:free:online")).toBe(false);
  });
});
