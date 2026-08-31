import type { GymOverlap } from "@macro-tracker/db";

import { formatMinutesAsTime } from "@/lib/formatting";

/**
 * The overlap rows shared by the home-page "Gym Buddies" card and the /gym
 * schedule tab. Confirmed overlaps get the accent tint; tentative ones (a
 * "maybe" on either side) stay muted and read "might overlap".
 */
export function GymOverlapList({ overlaps }: { overlaps: GymOverlap[] }) {
  if (overlaps.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2" data-testid="gym-overlap-list">
      {overlaps.map((overlap) => (
        <div
          key={overlap.buddy.id}
          className={[
            "rounded-2xl border p-3 text-sm transition",
            overlap.tentative
              ? "border-[var(--color-border)] bg-[var(--color-card-subtle)] text-[var(--color-muted-strong)]"
              : "border-[color-mix(in_srgb,var(--color-accent)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-ink)]",
          ].join(" ")}
        >
          <span className="font-semibold">You and {overlap.buddy.name}</span>{" "}
          {overlap.tentative ? "might overlap" : "overlap"}{" "}
          {overlap.windows
            .map(
              (window) =>
                `${formatMinutesAsTime(window.startMinute)}–${formatMinutesAsTime(window.endMinute)}`,
            )
            .join(", ")}
        </div>
      ))}
    </div>
  );
}
