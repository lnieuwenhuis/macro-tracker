import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_FOOD_PHOTO_FALLBACK_MODELS,
  DEFAULT_FOOD_PHOTO_MODEL,
  DEFAULT_GATEWAY_FOOD_PHOTO_MODELS,
  getConfiguredFoodPhotoModel,
  getConfiguredFoodPhotoModels,
  isFreeOpenRouterModel,
} from "@/lib/ai-food-photo";

const managedEnvVars = [
  "OPENROUTER_MODEL",
  "OPENROUTER_FALLBACK_MODELS",
  "AI_GATEWAY_URL",
  "AI_GATEWAY_MODELS",
] as const;
const originalEnv = Object.fromEntries(
  managedEnvVars.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of managedEnvVars) {
    if (originalEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalEnv[name];
    }
  }
});

describe("food photo OpenRouter model config", () => {
  it("uses the free defaults", () => {
    delete process.env.OPENROUTER_MODEL;
    delete process.env.OPENROUTER_FALLBACK_MODELS;
    delete process.env.AI_GATEWAY_URL;

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

describe("food photo AI gateway model config", () => {
  it("defaults to the Luna models when the gateway is configured", () => {
    process.env.AI_GATEWAY_URL =
      "http://cliproxyapi.railway.internal:8317/v1/chat/completions";
    delete process.env.AI_GATEWAY_MODELS;

    expect(getConfiguredFoodPhotoModels()).toEqual([
      ...DEFAULT_GATEWAY_FOOD_PHOTO_MODELS,
    ]);
    expect(getConfiguredFoodPhotoModel()).toBe("gpt-5.6-luna(low)");
  });

  it("uses configured gateway models without the free-model restriction", () => {
    process.env.AI_GATEWAY_URL =
      "http://cliproxyapi.railway.internal:8317/v1/chat/completions";
    process.env.AI_GATEWAY_MODELS =
      "gpt-5.6-luna(medium), gpt-5.6-terra(low)\ngpt-5.6-luna(medium)";

    expect(getConfiguredFoodPhotoModels()).toEqual([
      "gpt-5.6-luna(medium)",
      "gpt-5.6-terra(low)",
    ]);
  });

  it("ignores gateway models when no gateway is configured", () => {
    delete process.env.AI_GATEWAY_URL;
    delete process.env.OPENROUTER_MODEL;
    delete process.env.OPENROUTER_FALLBACK_MODELS;
    process.env.AI_GATEWAY_MODELS = "gpt-5.6-luna(low)";

    expect(getConfiguredFoodPhotoModels()).toEqual([
      DEFAULT_FOOD_PHOTO_MODEL,
      ...DEFAULT_FOOD_PHOTO_FALLBACK_MODELS,
    ]);
  });
});
