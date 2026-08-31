"use client";

import { useMemo, useState, type FormEvent } from "react";

import type {
  MacroBenchmarkBaseline,
  MacroBenchmarkModelCaseResult,
  MacroBenchmarkModelSummary,
  MacroBenchmarkResult,
} from "@/lib/ai-model-benchmark";
import type { AnalyzeFoodPhotoFailureKind } from "@/lib/ai-food-photo";

type ApiResponse =
  | {
      ok: true;
      result: MacroBenchmarkResult;
    }
  | {
      ok: false;
      error: string;
    };

const BASELINE_CACHE_PREFIX = "macro-benchmark-baseline:v2:";
const BASELINE_TTL_MS = 24 * 60 * 60 * 1000;

const FAILURE_LABELS: Record<AnalyzeFoodPhotoFailureKind, string> = {
  missing_api_key: "AI provider API key missing",
  invalid_image: "Fixture image unavailable",
  provider_rate_limit: "Provider rate limit hit",
  provider_quota: "Provider quota/balance unavailable",
  provider_image_access: "Provider could not fetch fixture image",
  provider_error: "Provider error",
  empty_response: "Model returned no content",
  invalid_json: "Model returned invalid JSON",
  unsupported_model: "Model may not support vision input",
  unknown: "Unknown failure",
};

function formatMacroValue(value: number, unit: string) {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}${unit}`;
}

function formatExpected(macros: {
  caloriesKcal: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
}) {
  return [
    formatMacroValue(macros.caloriesKcal, " kcal"),
    formatMacroValue(macros.proteinG, "g P"),
    formatMacroValue(macros.carbsG, "g C"),
    formatMacroValue(macros.fatG, "g F"),
  ].join(" / ");
}

function isFreshBaseline(value: unknown): value is MacroBenchmarkBaseline & {
  fixtureLimit: number;
} {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  const createdAt =
    typeof record.createdAt === "string" ? Date.parse(record.createdAt) : NaN;
  const now = Date.now();

  return (
    typeof record.currentModel === "string" &&
    typeof record.fixtureLimit === "number" &&
    Array.isArray(record.fixtureIds) &&
    Array.isArray(record.results) &&
    Number.isFinite(createdAt) &&
    createdAt <= now &&
    now - createdAt <= BASELINE_TTL_MS
  );
}

export function readCachedBaseline(fixtureLimit: number, currentModel: string) {
  if (typeof window === "undefined") {
    return null;
  }

  let newest: (MacroBenchmarkBaseline & { fixtureLimit: number }) | null = null;
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(BASELINE_CACHE_PREFIX)) {
      continue;
    }

    try {
      const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null");
      if (
        !isFreshBaseline(parsed) ||
        parsed.fixtureLimit !== fixtureLimit ||
        parsed.currentModel !== currentModel
      ) {
        continue;
      }

      if (
        !newest ||
        Date.parse(parsed.createdAt) > Date.parse(newest.createdAt)
      ) {
        newest = parsed;
      }
    } catch {
      window.localStorage.removeItem(key);
    }
  }

  return newest;
}

export function shouldCacheBenchmarkBaseline(result: MacroBenchmarkResult) {
  if (result.mode === "candidate_only" || !result.summaries.current) {
    return false;
  }

  if (result.cases.length === 0) {
    return false;
  }

  if (result.cases.some((item) => !item.current.ok)) {
    return false;
  }

  return (
    result.summaries.current.completedCases === result.cases.length &&
    result.summaries.current.failedCases === 0 &&
    result.summaries.current.skippedCases === 0
  );
}

export function getBaselineCacheCreatedAt(
  result: Pick<MacroBenchmarkResult, "baselineCreatedAt" | "usedBaseline">,
  createdAt = new Date().toISOString(),
) {
  return result.usedBaseline ? result.baselineCreatedAt : createdAt;
}

export function getBenchmarkCallCountText(params: {
  cachedBaseline: MacroBenchmarkBaseline | null;
  candidateOnly: boolean;
  currentModel: string;
  fixtureLimit: number;
  model: string;
}) {
  if (params.candidateOnly) {
    return `This run will make up to ${params.fixtureLimit} AI provider calls.`;
  }

  if (params.cachedBaseline?.currentModel === params.currentModel) {
    if (params.model.trim() === params.currentModel) {
      return "This run can use the cached baseline and may make 0 AI provider calls.";
    }

    return `This run will make up to ${params.fixtureLimit} AI provider calls using a cached baseline.`;
  }

  return `This run will make up to ${params.fixtureLimit * 2} AI provider calls. Same-model runs are deduplicated automatically.`;
}

function writeBaselineCache(result: MacroBenchmarkResult) {
  if (typeof window === "undefined" || !shouldCacheBenchmarkBaseline(result)) {
    return;
  }

  const createdAt = getBaselineCacheCreatedAt(result);
  if (!createdAt) {
    return;
  }

  const payload = {
    createdAt,
    currentModel: result.currentModel,
    fixtureLimit: result.fixtureCount,
    fixtureIds: result.cases.map((item) => item.fixtureId),
    results: result.cases.map((item) => item.current),
  };
  const key = `${BASELINE_CACHE_PREFIX}${result.currentModel}:${result.fixtureCount}`;
  window.localStorage.setItem(key, JSON.stringify(payload));
}

function SummaryCard({
  label,
  summary,
}: {
  label: string;
  summary: MacroBenchmarkModelSummary;
}) {
  const failures = Object.entries(summary.failureBreakdown)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) =>
      kind === "skipped"
        ? `${count} skipped`
        : `${count} ${FAILURE_LABELS[kind as AnalyzeFoodPhotoFailureKind]}`,
    )
    .join(", ");

  return (
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
        {label}
      </p>
      <p className="mt-2 break-all font-mono text-xs text-[var(--color-muted-strong)]">
        {summary.model}
      </p>
      <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
            Avg error
          </p>
          <p className="mt-1 text-2xl font-bold text-[var(--color-ink)]">
            {summary.averageErrorPct === null
              ? "n/a"
              : `${summary.averageErrorPct.toFixed(1)}%`}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
            Reliability
          </p>
          <p className="mt-1 text-2xl font-bold text-[var(--color-ink)]">
            {summary.reliabilityPct.toFixed(0)}%
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-[var(--color-muted)]">
            Avg latency
          </p>
          <p className="mt-1 text-2xl font-bold text-[var(--color-ink)]">
            {summary.averageLatencyMs === null
              ? "n/a"
              : `${summary.averageLatencyMs}ms`}
          </p>
        </div>
      </div>
      <p className="mt-3 text-xs text-[var(--color-muted)]">
        {summary.completedCases} completed, {summary.failedCases} failed,{" "}
        {summary.skippedCases} skipped
      </p>
      {failures ? (
        <p className="mt-2 break-words text-xs text-[var(--color-muted)]">
          {failures}
        </p>
      ) : null}
    </div>
  );
}

function ResultCell({ result }: { result: MacroBenchmarkModelCaseResult }) {
  const [showDetails, setShowDetails] = useState(false);

  if (!result.ok || !result.estimate) {
    const failureKind = result.failureKind ?? "unknown";
    const label = result.wasSkipped
      ? "Skipped"
      : FAILURE_LABELS[failureKind] ?? "Model failed";

    return (
      <div className="min-w-0 text-sm">
        <p className="break-words font-semibold text-[var(--color-danger)]">
          {label}
        </p>
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          {result.latencyMs === null ? "not run" : `${result.latencyMs}ms`}
          {result.retryable ? " - retryable" : ""}
        </p>
        {result.error ? (
          <>
            <button
              type="button"
              onClick={() => setShowDetails((value) => !value)}
              className="mt-2 text-xs font-semibold text-[var(--color-accent)] underline-offset-4 hover:underline"
            >
              {showDetails ? "Hide details" : "Show details"}
            </button>
            {showDetails ? (
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] p-3 text-xs text-[var(--color-muted-strong)]">
                {result.error}
              </pre>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-w-0 text-sm">
      <p className="break-words font-semibold text-[var(--color-ink)]">
        {formatExpected(result.estimate)}
      </p>
      <p className="mt-1 text-xs text-[var(--color-muted)]">
        Error {result.normalizedErrorPct?.toFixed(1)}% - {result.latencyMs}ms
      </p>
      <p className="mt-1 line-clamp-2 break-words text-xs text-[var(--color-muted)]">
        {result.estimate.label}
      </p>
    </div>
  );
}

export function AdminAiBenchmarkClient({
  currentModel,
}: {
  currentModel: string;
}) {
  const [model, setModel] = useState("");
  const [fixtureLimit, setFixtureLimit] = useState(4);
  const [reuseBaseline, setReuseBaseline] = useState(true);
  const [candidateOnly, setCandidateOnly] = useState(false);
  const [result, setResult] = useState<MacroBenchmarkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  const cachedBaseline = useMemo(
    () =>
      reuseBaseline && !candidateOnly
        ? readCachedBaseline(fixtureLimit, currentModel)
        : null,
    [candidateOnly, currentModel, fixtureLimit, reuseBaseline],
  );

  const callCountText = useMemo(() => {
    return getBenchmarkCallCountText({
      cachedBaseline,
      candidateOnly,
      currentModel,
      fixtureLimit,
      model,
    });
  }, [cachedBaseline, candidateOnly, currentModel, fixtureLimit, model]);

  const verdict = useMemo(() => {
    if (!result || result.mode === "candidate_only") {
      return null;
    }

    if (result.comparedSameModel) {
      return "Candidate matches current model; each fixture was only called once.";
    }

    const current = result.summaries.current;
    const candidate = result.summaries.candidate;
    if (!current) {
      return null;
    }

    if (current.reliabilityPct < 60 && candidate.reliabilityPct < 60) {
      return "Not enough successful cases to compare accuracy.";
    }

    if (candidate.reliabilityPct <= current.reliabilityPct - 30) {
      return "The candidate was materially less reliable; compare accuracy only after reliability improves.";
    }

    if (current.reliabilityPct <= candidate.reliabilityPct - 30) {
      return "The candidate was materially more reliable on this fixture set.";
    }

    if (current.completedCases < 3 || candidate.completedCases < 3) {
      return "At least 3 successful cases per model are needed to compare accuracy.";
    }

    const currentError = current.averageErrorPct;
    const candidateError = candidate.averageErrorPct;

    if (currentError === null || candidateError === null) {
      return "Compare completed cases below; at least one model had failures.";
    }

    if (candidateError < currentError) {
      return "The candidate was more accurate on this fixture set.";
    }

    if (candidateError > currentError) {
      return "The current model was more accurate on this fixture set.";
    }

    return "Accuracy tied on this fixture set; compare latency and failures.";
  }, [result]);

  async function runBenchmark(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setIsRunning(true);

    try {
      const baseline =
        reuseBaseline && !candidateOnly
          ? readCachedBaseline(fixtureLimit, currentModel)
          : null;
      const response = await fetch("/api/admin/ai-model-benchmark", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          baseline,
          fixtureLimit,
          mode: candidateOnly ? "candidate_only" : "compare",
          model,
        }),
      });
      const payload = (await response.json()) as ApiResponse;

      if (!payload.ok) {
        setError(payload.error);
        return;
      }

      setResult(payload.result);
      writeBaselineCache(payload.result);
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Benchmark request failed.",
      );
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="space-y-5">
      <form className="grid gap-3 lg:grid-cols-[1fr_12rem_auto]" onSubmit={runBenchmark}>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
            Candidate model
          </span>
          <input
            type="text"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="gpt-5.6-luna(low)"
            className="w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3 font-mono text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
            Fixture count
          </span>
          <select
            value={fixtureLimit}
            onChange={(event) => setFixtureLimit(Number(event.target.value))}
            className="w-full rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
          >
            <option value={4}>4 smoke</option>
            <option value={8}>8 quick</option>
            <option value={12}>12 standard</option>
            <option value={18}>18 full</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={isRunning}
          className="self-end rounded-2xl bg-[var(--color-accent)] px-5 py-3 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
        >
          {isRunning ? "Running benchmark" : "Run benchmark"}
        </button>
        <div className="lg:col-span-3 flex flex-wrap gap-4 pt-1 text-sm text-[var(--color-muted-strong)]">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={reuseBaseline}
              onChange={(event) => setReuseBaseline(event.target.checked)}
              disabled={candidateOnly}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            Reuse current-model baseline from last 24h
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={candidateOnly}
              onChange={(event) => setCandidateOnly(event.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            Candidate only
          </label>
        </div>
      </form>

      <div className="space-y-2 text-sm text-[var(--color-muted)]">
        <p>
          Each run uses local fixture images with standard serving-size nutrition
          references. This tests model ability to identify food and follow the
          stated serving, not real-world weighed portion estimation.
        </p>
        <p>{callCountText}</p>
        {cachedBaseline ? (
          <p>
            Current model baseline available from{" "}
            {new Date(cachedBaseline.createdAt).toLocaleString()}.
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="break-words rounded-2xl border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/10 px-4 py-3 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-2">
            {result.summaries.current ? (
              <SummaryCard label="Current model" summary={result.summaries.current} />
            ) : null}
            <SummaryCard label="Candidate model" summary={result.summaries.candidate} />
          </div>

          <div className="space-y-1 text-xs text-[var(--color-muted)]">
            <p>
              Ran {result.fixtureCount} of {result.totalFixtureCount} available
              fixtures.
            </p>
            {result.usedBaseline && result.baselineCreatedAt ? (
              <p>
                Current model baseline reused from{" "}
                {new Date(result.baselineCreatedAt).toLocaleString()}.
              </p>
            ) : null}
          </div>

          {verdict ? (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-4 py-3 text-sm font-semibold text-[var(--color-ink)]">
              {verdict}
            </div>
          ) : null}

          <div className="space-y-4">
            {result.cases.map((item) => (
              <div
                key={item.fixtureId}
                className="grid gap-4 rounded-2xl border border-[var(--color-border)] p-4 xl:grid-cols-[minmax(14rem,1.2fr)_minmax(10rem,0.8fr)_minmax(16rem,1fr)_minmax(16rem,1fr)]"
              >
                <div className="flex min-w-0 gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.thumbnailUrl}
                    alt={item.fixtureName}
                    className="h-16 w-16 shrink-0 rounded-2xl object-cover"
                  />
                  <div className="min-w-0">
                    <p className="break-words font-semibold text-[var(--color-ink)]">
                      {item.fixtureName}
                    </p>
                    <p className="mt-1 break-words text-xs text-[var(--color-muted)]">
                      {item.servingDescription}
                    </p>
                    <a
                      href={item.imageSourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block text-xs font-semibold text-[var(--color-accent)] underline-offset-4 hover:underline"
                    >
                      Image source
                    </a>
                  </div>
                </div>
                <div className="min-w-0 text-sm text-[var(--color-muted-strong)]">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                    Expected
                  </p>
                  <p className="mt-2 break-words font-semibold text-[var(--color-ink)]">
                    {formatExpected(item.expected)}
                  </p>
                  <p className="mt-1 break-words text-xs text-[var(--color-muted)]">
                    {item.expectedSource}
                  </p>
                </div>
                {result.summaries.current ? (
                  <div className="min-w-0">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                      Current
                    </p>
                    <ResultCell result={item.current} />
                  </div>
                ) : null}
                <div className="min-w-0">
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-muted-strong)]">
                    Candidate
                  </p>
                  <ResultCell result={item.candidate} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
