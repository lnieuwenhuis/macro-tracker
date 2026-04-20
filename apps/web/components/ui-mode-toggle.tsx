"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { prepareNavigationMotion } from "@/lib/navigation-motion";
import { useUiMode } from "@/lib/ui-mode-client";
import { mapRouteForUiMode, setUiMode, type UiMode } from "@/lib/ui-mode";

type UiModeToggleProps = {
  onModeChange?: (mode: UiMode) => void;
};

export function UiModeToggle({ onModeChange }: UiModeToggleProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const currentMode = useUiMode();
  const nextMode = currentMode === "legacy" ? "experimental" : "legacy";

  function handleToggle() {
    const currentHref = searchParams.size > 0
      ? `${pathname}?${searchParams.toString()}`
      : pathname;
    const nextHref = mapRouteForUiMode({
      pathname,
      searchParams,
      nextMode,
    });

    setUiMode(nextMode);
    onModeChange?.(nextMode);

    startTransition(() => {
      if (nextHref === currentHref) {
        router.refresh();
        return;
      }

      prepareNavigationMotion(nextHref, "screen");
      router.push(nextHref);
    });
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={currentMode === "experimental"}
      disabled={isPending}
      onClick={handleToggle}
      className="flex w-full items-center justify-between gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-3 py-3 text-left transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-card-muted)] disabled:opacity-60"
    >
      <span className="min-w-0">
        <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
          Experimental UI
        </span>
        <span className="mt-1 block text-sm text-[var(--color-muted)]">
          {currentMode === "experimental"
            ? "Using the new bottom-bar layout."
            : "Switch to the new bottom-bar layout."}
        </span>
      </span>
      <span
        className={[
          "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition",
          currentMode === "experimental"
            ? "border-[var(--color-accent)] bg-[var(--color-accent)]"
            : "border-[var(--color-border-strong)] bg-[var(--color-card-muted)]",
        ].join(" ")}
      >
        <span
          className={[
            "absolute left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
            currentMode === "experimental" ? "translate-x-5" : "translate-x-0",
          ].join(" ")}
        />
      </span>
    </button>
  );
}
