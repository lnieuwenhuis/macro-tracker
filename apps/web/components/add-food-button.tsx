"use client";

import { useEffect, useRef, useState } from "react";

type AddFoodButtonProps = {
  onCustom: () => void;
  onPreset: () => void;
};

export function AddFoodButton({ onCustom, onPreset }: AddFoodButtonProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-accent)] text-white shadow-md transition hover:-translate-y-0.5"
        aria-label="Add food"
        aria-expanded={open}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 18 18"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          style={{ transition: "transform 0.15s", transform: open ? "rotate(45deg)" : "rotate(0deg)" }}
        >
          <line x1="9" y1="3" x2="9" y2="15" />
          <line x1="3" y1="9" x2="15" y2="9" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-1.5 min-w-[140px] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] py-1 shadow-lg">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onPreset();
            }}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-[var(--color-ink)] transition hover:bg-[var(--color-shell-panel)]"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 15 15"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="2" y="2" width="11" height="11" rx="2.5" />
              <line x1="7.5" y1="5" x2="7.5" y2="10" />
              <line x1="5" y1="7.5" x2="10" y2="7.5" />
            </svg>
            Preset
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onCustom();
            }}
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-[var(--color-ink)] transition hover:bg-[var(--color-shell-panel)]"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 15 15"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            >
              <line x1="7.5" y1="2.5" x2="7.5" y2="12.5" />
              <line x1="2.5" y1="7.5" x2="12.5" y2="7.5" />
            </svg>
            Custom
          </button>
        </div>
      )}
    </div>
  );
}
