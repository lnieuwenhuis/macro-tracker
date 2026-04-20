"use client";

import type { MacroGoals, StatsPageData } from "@macro-tracker/db";
import { useState } from "react";

import { AppShell } from "./app-shell";
import { formatShortDate } from "@/lib/formatting";

type StatsShellProps = {
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  statsData: StatsPageData;
  goals: MacroGoals;
};

type MacroField = "caloriesKcal" | "proteinG" | "carbsG" | "fatG";

type MacroMeta = {
  field: MacroField;
  label: string;
  unit: string;
  color: string;
};

const MACRO_META: Record<MacroField, MacroMeta> = {
  caloriesKcal: {
    field: "caloriesKcal",
    label: "Calories",
    unit: "kcal",
    color: "var(--color-bar-calories)",
  },
  proteinG: {
    field: "proteinG",
    label: "Protein",
    unit: "g",
    color: "var(--color-bar-protein)",
  },
  carbsG: {
    field: "carbsG",
    label: "Carbs",
    unit: "g",
    color: "var(--color-bar-carbs)",
  },
  fatG: {
    field: "fatG",
    label: "Fat",
    unit: "g",
    color: "var(--color-bar-fat)",
  },
};

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4">
      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--color-muted-strong)]">
        {label}
      </span>
      <span className="mt-1.5 text-2xl font-bold tabular-nums text-[var(--color-ink)]">
        {value}
      </span>
      {sub && (
        <span className="mt-0.5 text-[11px] text-[var(--color-muted)]">{sub}</span>
      )}
    </div>
  );
}

function MacroTrendChart({
  data,
  goal,
  field,
  unit,
  color,
}: {
  data: StatsPageData["allDailyTotals"];
  goal: number | null;
  field: MacroField;
  unit: string;
  color: string;
}) {
  const last30 = data.slice(-30);
  if (last30.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-[var(--color-muted)]">No data yet.</p>
    );
  }

  const values = last30.map((d) => d[field]);
  const maxVal = Math.max(...values, goal ?? 0, field === "caloriesKcal" ? 100 : 10);
  const barW = 8;
  const gap = 3;
  const chartH = 72;
  const totalW = last30.length * (barW + gap) - gap;

  return (
    <div>
      <div className="overflow-x-auto">
        <svg
          width="100%"
          height={chartH + 4}
          viewBox={`0 0 ${totalW} ${chartH + 4}`}
          preserveAspectRatio="none"
          className="block h-[76px] w-full"
          style={{ minWidth: totalW }}
        >
          {goal && goal > 0 && (
            <line
              x1={0}
              y1={chartH - (goal / maxVal) * chartH}
              x2={totalW}
              y2={chartH - (goal / maxVal) * chartH}
              stroke="var(--color-accent)"
              strokeWidth="1.5"
              strokeDasharray="4 3"
              opacity="0.7"
            />
          )}
          {last30.map((d, i) => {
            const value = d[field];
            const barH = Math.max(2, (value / maxVal) * chartH);
            const x = i * (barW + gap);
            const y = chartH - barH;
            const hitGoal = goal && goal > 0 && value >= goal * 0.9;
            return (
              <rect
                key={d.date}
                x={x}
                y={y}
                width={barW}
                height={barH}
                fill={hitGoal ? "var(--color-success)" : color}
                rx="2"
                opacity="0.85"
              />
            );
          })}
        </svg>
        <div className="mt-1 flex justify-between text-[10px] text-[var(--color-muted)]">
          <span>{last30[0] ? formatShortDate(last30[0].date) : ""}</span>
          <span>{last30[last30.length - 1] ? formatShortDate(last30[last30.length - 1].date) : ""}</span>
        </div>
      </div>
      {/* Legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[var(--color-muted)]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: color, opacity: 0.85 }} />
          Under goal
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-[var(--color-success)] opacity-85" />
          At/over goal
        </span>
        {goal && goal > 0 ? (
          <span className="ml-auto">
            Goal: {goal} {unit}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function MacroSplitBar({
  proteinG,
  carbsG,
  fatG,
}: {
  proteinG: number;
  carbsG: number;
  fatG: number;
}) {
  // Convert to calories for split (protein=4, carbs=4, fat=9)
  const proteinCal = proteinG * 4;
  const carbsCal = carbsG * 4;
  const fatCal = fatG * 9;
  const total = proteinCal + carbsCal + fatCal;

  if (total === 0) {
    return <p className="text-sm text-[var(--color-muted)]">No data yet.</p>;
  }

  const pPct = Math.round((proteinCal / total) * 100);
  const cPct = Math.round((carbsCal / total) * 100);
  const fPct = 100 - pPct - cPct;

  return (
    <div className="space-y-3">
      <div className="flex h-4 w-full overflow-hidden rounded-full">
        <div style={{ width: `${pPct}%`, backgroundColor: "var(--color-bar-protein)" }} />
        <div style={{ width: `${cPct}%`, backgroundColor: "var(--color-bar-carbs)" }} />
        <div style={{ width: `${fPct}%`, backgroundColor: "var(--color-bar-fat)" }} />
      </div>
      <div className="flex gap-4 text-xs font-semibold">
        <span style={{ color: "var(--color-bar-protein)" }}>Protein {pPct}%</span>
        <span style={{ color: "var(--color-bar-carbs)" }}>Carbs {cPct}%</span>
        <span style={{ color: "var(--color-bar-fat)" }}>Fat {fPct}%</span>
      </div>
    </div>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function StatsShell({
  userEmail,
  canAccessAdmin,
  selectedDate,
  statsData,
  goals,
}: StatsShellProps) {
  return (
    <AppShell
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      activeTab="stats"
      showDateNavigation={false}
    >
      <StatsPanels statsData={statsData} goals={goals} />
    </AppShell>
  );
}

export function StatsPanels({
  statsData,
  goals,
}: {
  statsData: StatsPageData;
  goals: MacroGoals;
}) {
  const { allDailyTotals, totalDaysTracked, currentStreak, longestStreak,
    totalProteinG, totalCarbsG, totalFatG, totalCaloriesKcal,
    bestCalorieDay, topLabels } = statsData;

  const [selectedMacro, setSelectedMacro] = useState<MacroField>("caloriesKcal");
  const macroMeta = MACRO_META[selectedMacro];
  const goalForMacro = goals[selectedMacro];

  if (totalDaysTracked === 0) {
    return (
      <section className="flex min-h-[60vh] items-center justify-center">
          <div className="w-full rounded-[2rem] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-strong)] px-6 py-10 text-center shadow-[0_18px_44px_rgba(0,0,0,0.06)]">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[var(--color-card-muted)] text-[var(--color-accent)]">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 22V14" />
                <path d="M14 22V8" />
                <path d="M22 22v-5" />
              </svg>
            </div>
            <h2 className="mt-5 text-xl font-bold text-[var(--color-ink)]">No stats yet</h2>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              Start logging meals to see your stats!
            </p>
          </div>
        </section>
    );
  }

  const avgCalories = totalDaysTracked > 0
    ? Math.round(totalCaloriesKcal / totalDaysTracked)
    : 0;

  const avgProtein = totalDaysTracked > 0
    ? Math.round(totalProteinG / totalDaysTracked)
    : 0;

  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];

  return (
    <div className="space-y-5">

        {/* Key stat cards */}
        <section>
          <h2 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
            Overview
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label="Days Tracked"
              value={String(totalDaysTracked)}
              sub={totalDaysTracked === 1 ? "day" : "days total"}
            />
            <StatCard
              label="Current Streak"
              value={`${currentStreak}🔥`}
              sub={`Best: ${longestStreak} days`}
            />
            <StatCard
              label="Avg Calories"
              value={`${avgCalories}`}
              sub="kcal per day"
            />
            <StatCard
              label="Avg Protein"
              value={`${avgProtein}g`}
              sub="per day"
            />
          </div>
        </section>

        {/* Macro trend chart */}
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5">
          <div className="mb-4">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              {macroMeta.label} Trend
            </h2>
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">Last 30 logged days</p>
          </div>

          {/* Pill tab selector */}
          <div
            role="tablist"
            aria-label="Macro"
            className="mb-4 flex flex-wrap gap-1.5"
          >
            {(Object.keys(MACRO_META) as MacroField[]).map((macro) => {
              const meta = MACRO_META[macro];
              const isActive = macro === selectedMacro;
              return (
                <button
                  key={macro}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setSelectedMacro(macro)}
                  className="rounded-full px-3 py-1 text-xs font-semibold transition"
                  style={
                    isActive
                      ? { backgroundColor: meta.color, color: "white" }
                      : {
                          backgroundColor: "var(--color-card-muted)",
                          color: "var(--color-muted)",
                        }
                  }
                >
                  {meta.label}
                </button>
              );
            })}
          </div>

          <MacroTrendChart
            data={allDailyTotals}
            goal={goalForMacro}
            field={selectedMacro}
            unit={macroMeta.unit}
            color={macroMeta.color}
          />
        </section>

        {/* Macro split */}
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5">
          <div className="mb-4">
            <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Average Macro Split
            </h2>
            <p className="mt-1 text-[11px] text-[var(--color-muted)]">Based on all tracked days</p>
          </div>
          <MacroSplitBar
            proteinG={totalDaysTracked > 0 ? totalProteinG / totalDaysTracked : 0}
            carbsG={totalDaysTracked > 0 ? totalCarbsG / totalDaysTracked : 0}
            fatG={totalDaysTracked > 0 ? totalFatG / totalDaysTracked : 0}
          />
        </section>

        {/* All-time totals */}
        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5">
          <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
            All-Time Totals
          </h2>
          <div className="space-y-3">
            {[
              { label: "Calories", value: formatNumber(totalCaloriesKcal), unit: "kcal", color: "var(--color-bar-calories)" },
              { label: "Protein", value: formatNumber(totalProteinG), unit: "g", color: "var(--color-bar-protein)" },
              { label: "Carbs", value: formatNumber(totalCarbsG), unit: "g", color: "var(--color-bar-carbs)" },
              { label: "Fat", value: formatNumber(totalFatG), unit: "g", color: "var(--color-bar-fat)" },
            ].map(({ label, value, unit, color }) => (
              <div key={label} className="flex items-baseline justify-between">
                <span className="text-sm font-semibold text-[var(--color-ink)]">{label}</span>
                <span className="tabular-nums text-sm font-bold" style={{ color }}>
                  {value}
                  <span className="ml-0.5 text-xs font-medium text-[var(--color-muted)]">{unit}</span>
                </span>
              </div>
            ))}
          </div>
          {bestCalorieDay && (
            <div className="mt-4 rounded-xl bg-[var(--color-card-muted)] px-3 py-2.5">
              <p className="text-xs text-[var(--color-muted)]">
                Best calorie day:{" "}
                <span className="font-semibold text-[var(--color-ink)]">
                  {formatShortDate(bestCalorieDay.date)} — {bestCalorieDay.caloriesKcal} kcal
                </span>
              </p>
            </div>
          )}
        </section>

        {/* Top foods */}
        {topLabels.length > 0 && (
          <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5">
            <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
              Most Logged Foods
            </h2>
            <div className="space-y-2.5">
              {topLabels.map((item, index) => (
                <div key={item.label} className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-sm shrink-0">{medals[index]}</span>
                    <span className="truncate text-sm font-semibold text-[var(--color-ink)]">
                      {item.label}
                    </span>
                  </div>
                  <span className="shrink-0 text-xs font-semibold text-[var(--color-muted)]">
                    {item.count}×
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
  );
}
