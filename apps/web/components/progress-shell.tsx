"use client";

import type { MacroGoals, WeightPageData } from "@macro-tracker/db";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { ProgressTab } from "@/lib/ui-mode";

import { ExperimentalAppShell, ExperimentalSettingsButton } from "./experimental-app-shell";
import { GoalsPanel } from "./goals-shell";
import { WeightPanel } from "./weight-shell";

type ProgressShellProps = {
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  goals: MacroGoals;
  weightData: WeightPageData;
  initialTab: ProgressTab;
};

export function ProgressShell({
  userEmail,
  canAccessAdmin,
  selectedDate,
  goals,
  weightData,
  initialTab,
}: ProgressShellProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<ProgressTab>(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  function handleTabChange(nextTab: ProgressTab) {
    setActiveTab(nextTab);
    router.replace(`/progress?date=${selectedDate}&tab=${nextTab}`, {
      scroll: false,
    });
  }

  return (
    <ExperimentalAppShell
      userEmail={userEmail}
      canAccessAdmin={canAccessAdmin}
      selectedDate={selectedDate}
      title="Goals & Weight"
      activeTab="progress"
      topBar={({ openSettings }) => (
        <div className="mb-4 flex items-center gap-3">
          <section className="flex-1 rounded-[1.45rem] border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface-strong)_92%,transparent)] p-1 shadow-[0_16px_30px_rgba(0,0,0,0.12)] backdrop-blur-xl">
            <div
              role="tablist"
              aria-label="Progress views"
              className="grid h-12 grid-cols-2 gap-2"
            >
              {([
                { id: "goals", label: "Goals" },
                { id: "weight", label: "Weight" },
              ] as const).map((tab) => {
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => handleTabChange(tab.id)}
                    className={[
                      "h-full rounded-[1.05rem] px-4 text-sm font-semibold transition",
                      isActive
                        ? "bg-[var(--color-accent)] text-white shadow-[0_10px_24px_rgba(0,0,0,0.14)]"
                        : "text-[var(--color-muted-strong)] hover:bg-[var(--color-card-muted)]",
                    ].join(" ")}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </section>
          <ExperimentalSettingsButton onClick={openSettings} />
        </div>
      )}
    >
      {activeTab === "goals" ? (
        <GoalsPanel goals={goals} />
      ) : (
        <WeightPanel selectedDate={selectedDate} weightData={weightData} />
      )}
    </ExperimentalAppShell>
  );
}
