import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBenchmarkCallCountText,
  readCachedBaseline,
  shouldCacheBenchmarkBaseline,
} from "@/components/admin-ai-benchmark-client";
import type {
  MacroBenchmarkModelCaseResult,
  MacroBenchmarkResult,
} from "@/lib/ai-model-benchmark";

const successResult: MacroBenchmarkModelCaseResult = {
  model: "current/free",
  ok: true,
  latencyMs: 100,
  estimate: {
    label: "banana",
    caloriesKcal: 105,
    proteinG: 1.3,
    carbsG: 27,
    fatG: 0.4,
    confidence: 0.9,
    notes: [],
  },
  absoluteError: {
    caloriesKcal: 0,
    proteinG: 0,
    carbsG: 0,
    fatG: 0,
  },
  normalizedErrorPct: 0,
  error: null,
};

function failedResult(
  overrides?: Partial<MacroBenchmarkModelCaseResult>,
): MacroBenchmarkModelCaseResult {
  return {
    model: "current/free",
    ok: false,
    latencyMs: 100,
    estimate: null,
    absoluteError: null,
    normalizedErrorPct: null,
    error: "Provider failed.",
    failureKind: "unsupported_model",
    retryable: false,
    ...overrides,
  };
}

function benchmarkResult(params?: {
  currentResults?: MacroBenchmarkModelCaseResult[];
  mode?: MacroBenchmarkResult["mode"];
}): MacroBenchmarkResult {
  const currentResults = params?.currentResults ?? [
    successResult,
    successResult,
    successResult,
    successResult,
  ];
  const completedCases = currentResults.filter((result) => result.ok).length;
  const failedCases = currentResults.filter(
    (result) => !result.ok && !result.wasSkipped,
  ).length;
  const skippedCases = currentResults.filter(
    (result) => result.wasSkipped,
  ).length;

  return {
    currentModel: "current/free",
    candidateModel: "candidate/free",
    fixtureCount: currentResults.length,
    totalFixtureCount: currentResults.length,
    comparedSameModel: false,
    mode: params?.mode ?? "compare",
    usedBaseline: false,
    baselineCreatedAt: null,
    fixtures: [],
    cases: currentResults.map((current, index) => ({
      fixtureId: `fixture-${index}`,
      fixtureName: `Fixture ${index}`,
      servingDescription: "One serving.",
      thumbnailUrl: "/benchmark-foods/test.jpg",
      imageSourceUrl: "https://example.com/test.jpg",
      expected: {
        caloriesKcal: 105,
        proteinG: 1.3,
        carbsG: 27,
        fatG: 0.4,
      },
      expectedSource: "test",
      category: "fruit",
      current,
      candidate: successResult,
    })),
    summaries: {
      current:
        params?.mode === "candidate_only"
          ? null
          : {
              model: "current/free",
              completedCases,
              failedCases,
              skippedCases,
              averageLatencyMs: 100,
              averageErrorPct: 0,
              reliabilityPct: (completedCases / currentResults.length) * 100,
              failureBreakdown: {
                missing_api_key: 0,
                invalid_image: 0,
                provider_rate_limit: 0,
                provider_quota: 0,
                provider_image_access: 0,
                provider_error: 0,
                empty_response: 0,
                invalid_json: 0,
                unsupported_model: failedCases,
                unknown: 0,
                skipped: skippedCases,
              },
              categoryAverages: {
                fruit: 0,
                protein: null,
                grain: null,
                vegetable: null,
                dairy: null,
                fat: null,
                legume: null,
              },
            },
      candidate: {
        model: "candidate/free",
        completedCases: currentResults.length,
        failedCases: 0,
        skippedCases: 0,
        averageLatencyMs: 100,
        averageErrorPct: 0,
        reliabilityPct: 100,
        failureBreakdown: {
          missing_api_key: 0,
          invalid_image: 0,
          provider_rate_limit: 0,
          provider_quota: 0,
          provider_image_access: 0,
          provider_error: 0,
          empty_response: 0,
          invalid_json: 0,
          unsupported_model: 0,
          unknown: 0,
          skipped: 0,
        },
        categoryAverages: {
          fruit: 0,
          protein: null,
          grain: null,
          vegetable: null,
          dairy: null,
          fat: null,
          legume: null,
        },
      },
    },
  };
}

describe("shouldCacheBenchmarkBaseline", () => {
  it("allows complete successful compare baselines", () => {
    expect(shouldCacheBenchmarkBaseline(benchmarkResult())).toBe(true);
  });

  it("keeps candidate-only behavior uncached", () => {
    expect(
      shouldCacheBenchmarkBaseline(benchmarkResult({ mode: "candidate_only" })),
    ).toBe(false);
  });

  it("rejects mostly failed or skipped current-model baselines", () => {
    expect(
      shouldCacheBenchmarkBaseline(
        benchmarkResult({
          currentResults: [
            successResult,
            failedResult(),
            failedResult({ latencyMs: null, wasSkipped: true }),
            failedResult({ latencyMs: null, wasSkipped: true }),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects any failed current-model baseline row", () => {
    expect(
      shouldCacheBenchmarkBaseline(
        benchmarkResult({
          currentResults: [
            successResult,
            successResult,
            successResult,
            failedResult(),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("rejects transient provider-capacity failures", () => {
    expect(
      shouldCacheBenchmarkBaseline(
        benchmarkResult({
          currentResults: [
            failedResult({
              error: "Rate limit exceeded.",
              failureKind: "provider_rate_limit",
              retryable: true,
            }),
            successResult,
            successResult,
            successResult,
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("readCachedBaseline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires an exact configured current-model match", () => {
    const createdAt = new Date().toISOString();
    const storageEntries: Record<string, string> = {
      "macro-benchmark-baseline:v2:current/free:4": JSON.stringify({
        currentModel: "current/free",
        createdAt,
        fixtureLimit: 4,
        fixtureIds: ["fixture-0"],
        results: [successResult],
      }),
      "macro-benchmark-baseline:v2:old/free:4": JSON.stringify({
        currentModel: "old/free",
        createdAt: new Date(Date.now() + 1000).toISOString(),
        fixtureLimit: 4,
        fixtureIds: ["fixture-0"],
        results: [successResult],
      }),
    };

    vi.stubGlobal("window", {
      localStorage: {
        get length() {
          return Object.keys(storageEntries).length;
        },
        key(index: number) {
          return Object.keys(storageEntries)[index] ?? null;
        },
        getItem(key: string) {
          return storageEntries[key] ?? null;
        },
        removeItem(key: string) {
          delete storageEntries[key];
        },
      },
    });

    expect(readCachedBaseline(4, "current/free")?.currentModel).toBe(
      "current/free",
    );
    expect(readCachedBaseline(4, "new/free")).toBeNull();
  });
});

describe("getBenchmarkCallCountText", () => {
  const cachedBaseline = {
    currentModel: "current/free",
    createdAt: new Date().toISOString(),
    fixtureIds: [],
    results: [],
  };

  it("advertises cached savings only for the configured current model", () => {
    expect(
      getBenchmarkCallCountText({
        cachedBaseline,
        candidateOnly: false,
        currentModel: "new/free",
        fixtureLimit: 4,
        model: "candidate/free",
      }),
    ).toBe(
      "This run will make up to 8 AI provider calls. Same-model runs are deduplicated automatically.",
    );

    expect(
      getBenchmarkCallCountText({
        cachedBaseline,
        candidateOnly: false,
        currentModel: "current/free",
        fixtureLimit: 4,
        model: "candidate/free",
      }),
    ).toBe("This run will make up to 4 AI provider calls using a cached baseline.");
  });
});
