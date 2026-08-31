import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FOOD_PHOTO_MODELS,
  getConfiguredFoodPhotoModel,
  getConfiguredFoodPhotoModels,
} from "@/lib/ai-food-photo";

const originalModels = process.env.AI_GATEWAY_MODELS;

afterEach(() => {
  if (originalModels === undefined) {
    delete process.env.AI_GATEWAY_MODELS;
  } else {
    process.env.AI_GATEWAY_MODELS = originalModels;
  }
});

describe("food photo model config", () => {
  it("defaults to the Luna models", () => {
    delete process.env.AI_GATEWAY_MODELS;

    expect(getConfiguredFoodPhotoModels()).toEqual([
      ...DEFAULT_FOOD_PHOTO_MODELS,
    ]);
    expect(getConfiguredFoodPhotoModel()).toBe("gpt-5.6-luna(low)");
  });

  it("parses and dedupes the configured model list", () => {
    process.env.AI_GATEWAY_MODELS =
      "gpt-5.6-luna(medium), gpt-5.6-terra(low)\ngpt-5.6-luna(medium)";

    expect(getConfiguredFoodPhotoModels()).toEqual([
      "gpt-5.6-luna(medium)",
      "gpt-5.6-terra(low)",
    ]);
    expect(getConfiguredFoodPhotoModel()).toBe("gpt-5.6-luna(medium)");
  });

  it("falls back to the defaults when the list is only separators", () => {
    process.env.AI_GATEWAY_MODELS = " ,\n, ";

    expect(getConfiguredFoodPhotoModels()).toEqual([
      ...DEFAULT_FOOD_PHOTO_MODELS,
    ]);
  });
});
