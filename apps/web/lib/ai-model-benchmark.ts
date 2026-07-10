import type {
  AnalyzeFoodPhotoFailureKind,
  FoodPhotoEstimate,
} from "./ai-food-photo";

export type MacroBenchmarkMacros = {
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
};

export type MacroBenchmarkCategory =
  | "fruit"
  | "protein"
  | "grain"
  | "vegetable"
  | "dairy"
  | "fat"
  | "legume";

export type MacroBenchmarkFixture = {
  id: string;
  name: string;
  servingDescription: string;
  assetFileName: string;
  thumbnailUrl: string;
  imageSourceUrl: string;
  expected: MacroBenchmarkMacros;
  expectedSource: string;
  category: MacroBenchmarkCategory;
};

export type MacroBenchmarkModelCaseResult = {
  model: string;
  ok: boolean;
  latencyMs: number | null;
  estimate: FoodPhotoEstimate | null;
  absoluteError: MacroBenchmarkMacros | null;
  normalizedErrorPct: number | null;
  error: string | null;
  failureKind?: AnalyzeFoodPhotoFailureKind;
  retryable?: boolean;
  wasSkipped?: boolean;
};

export type MacroBenchmarkCaseResult = {
  fixtureId: string;
  fixtureName: string;
  servingDescription: string;
  thumbnailUrl: string;
  imageSourceUrl: string;
  expected: MacroBenchmarkMacros;
  expectedSource: string;
  category: MacroBenchmarkCategory;
  current: MacroBenchmarkModelCaseResult;
  candidate: MacroBenchmarkModelCaseResult;
};

export type MacroBenchmarkMode = "compare" | "candidate_only";

export type MacroBenchmarkBaseline = {
  currentModel: string;
  fixtureIds: string[];
  results: MacroBenchmarkModelCaseResult[];
  createdAt: string;
};

export type MacroBenchmarkModelSummary = {
  model: string;
  completedCases: number;
  failedCases: number;
  skippedCases: number;
  averageLatencyMs: number | null;
  averageErrorPct: number | null;
  reliabilityPct: number;
  failureBreakdown: Record<
    AnalyzeFoodPhotoFailureKind | "skipped",
    number
  >;
  categoryAverages: Record<MacroBenchmarkCategory, number | null>;
};

export type MacroBenchmarkResult = {
  currentModel: string;
  candidateModel: string;
  fixtureCount: number;
  totalFixtureCount: number;
  comparedSameModel: boolean;
  mode: MacroBenchmarkMode;
  usedBaseline: boolean;
  baselineCreatedAt: string | null;
  fixtures: MacroBenchmarkFixture[];
  cases: MacroBenchmarkCaseResult[];
  summaries: {
    current: MacroBenchmarkModelSummary | null;
    candidate: MacroBenchmarkModelSummary;
  };
};
