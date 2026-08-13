"use client";

import { type ReactNode, useRef, useState } from "react";

import { useDismissableLayer } from "./overlay-portal";

type AddFoodButtonProps = {
  onCustom: () => void;
  onPreset: () => void;
  onScan: () => void;
  onPhoto?: () => void;
  onRecipe?: () => void;
};

type AddFoodMenuItemProps = {
  icon: ReactNode;
  label: string;
  onSelect: () => void;
};

function AddFoodMenuItem({ icon, label, onSelect }: AddFoodMenuItemProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm font-medium text-[var(--color-ink)] transition hover:bg-[var(--color-shell-panel)]"
    >
      {icon}
      {label}
    </button>
  );
}

function TemplateIcon() {
  return (
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
  );
}

function CustomIcon() {
  return (
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
  );
}

function ScanIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <rect x="1" y="1" width="4" height="4" />
      <rect x="10" y="1" width="4" height="4" />
      <rect x="1" y="10" width="4" height="4" />
      <line x1="7.5" y1="1" x2="7.5" y2="6" />
      <line x1="7.5" y1="9" x2="7.5" y2="14" />
      <line x1="10" y1="10" x2="14" y2="10" />
      <line x1="10" y1="13" x2="14" y2="13" />
    </svg>
  );
}

function PhotoIcon() {
  return (
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
      <rect x="2" y="3" width="11" height="9" rx="2" />
      <path d="M5 3l1-1h3l1 1" />
      <circle cx="7.5" cy="7.5" r="2" />
    </svg>
  );
}

function RecipeIcon() {
  return (
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
      <path d="M3 1.5h9a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12V3A1.5 1.5 0 0 1 3 1.5z" />
      <path d="M5 5h5" />
      <path d="M5 7.5h5" />
      <path d="M5 10h3" />
    </svg>
  );
}

export function AddFoodButton({
  onCustom,
  onPreset,
  onScan,
  onPhoto,
  onRecipe,
}: AddFoodButtonProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useDismissableLayer({
    active: open,
    layerRef: containerRef,
    onDismiss: () => setOpen(false),
  });

  function selectMenuItem(onSelect: () => void) {
    setOpen(false);
    onSelect();
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-accent)] text-white shadow-md transition hover:-translate-y-0.5"
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
          <AddFoodMenuItem
            icon={<TemplateIcon />}
            label="Template"
            onSelect={() => selectMenuItem(onPreset)}
          />
          <AddFoodMenuItem
            icon={<CustomIcon />}
            label="Custom"
            onSelect={() => selectMenuItem(onCustom)}
          />
          <AddFoodMenuItem
            icon={<ScanIcon />}
            label="Scan"
            onSelect={() => selectMenuItem(onScan)}
          />
          {onPhoto && (
            <AddFoodMenuItem
              icon={<PhotoIcon />}
              label="Photo"
              onSelect={() => selectMenuItem(onPhoto)}
            />
          )}
          {onRecipe && (
            <AddFoodMenuItem
              icon={<RecipeIcon />}
              label="Recipe"
              onSelect={() => selectMenuItem(onRecipe)}
            />
          )}
        </div>
      )}
    </div>
  );
}
