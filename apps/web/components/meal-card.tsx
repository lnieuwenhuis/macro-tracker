"use client";

import type { MealEntryStatus, MealGroup, QuantityUnit } from "@macro-tracker/db";
import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";

import {
  getFloatingMenuLayout,
  type FloatingMenuLayout,
} from "@/lib/floating-menu";

import { NumberInputField } from "./number-input-field";
import { useDismissableLayer } from "./overlay-portal";

type MealDraft = {
  clientId: string;
  id?: string;
  mealGroupId?: string | null;
  status: MealEntryStatus;
  productId?: string | null;
  label: string;
  quantity: string;
  unit: QuantityUnit;
  servingMultiplier: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
  caloriesKcal: string;
  sortOrder: number;
};

type MealCardProps = {
  draft: MealDraft;
  busy: boolean;
  error?: string | null;
  /** True for ~2 s after a successful copy-to-today so the button can show confirmation. */
  isCopied?: boolean;
  mealGroups?: MealGroup[];
  onChange: (
    clientId: string,
    field: keyof Omit<MealDraft, "clientId" | "id" | "sortOrder">,
    value: string,
  ) => void;
  onSave: (clientId: string) => Promise<boolean>;
  onDelete: (clientId: string) => void;
  onDuplicate: (clientId: string) => void;
  onGroupChange?: (clientId: string, mealGroupId: string | null) => void;
  onStatusChange?: (clientId: string, status: MealEntryStatus) => void;
  onCopyToToday?: (clientId: string) => void;
  onDiscardChanges?: (clientId: string) => void;
};

const MENU_BOTTOM_INSET_PX = 112;
const MENU_VIEWPORT_MARGIN_PX = 8;

const MEAL_CARD_NUMBER_INPUT_CLASS =
  "w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2.5 pr-16 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]";

const MEAL_MACRO_CHIPS = [
  {
    key: "proteinG" as const,
    prefix: "P",
    colorClass:
      "rounded-md bg-[color-mix(in_srgb,var(--color-bar-protein)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-bar-protein)]",
  },
  {
    key: "carbsG" as const,
    prefix: "C",
    colorClass:
      "rounded-md bg-[color-mix(in_srgb,var(--color-bar-carbs)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-bar-carbs)]",
  },
  {
    key: "fatG" as const,
    prefix: "F",
    colorClass:
      "rounded-md bg-[color-mix(in_srgb,var(--color-bar-fat)_12%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-bar-fat)]",
  },
  {
    key: "caloriesKcal" as const,
    prefix: "",
    colorClass:
      "rounded-md bg-[var(--color-shell-panel)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-muted-strong)]",
  },
];

function MealCardComponent({ draft, busy, error, isCopied = false, mealGroups = [], onChange, onSave, onDelete, onDuplicate, onGroupChange, onStatusChange, onCopyToToday, onDiscardChanges }: MealCardProps) {
  const isSaved = Boolean(draft.id);
  const [isExpanded, setIsExpanded] = useState(!isSaved);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuLayout, setMenuLayout] = useState<FloatingMenuLayout | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);

  const heading = draft.label.trim() || "New item";
  // A macro chip only shows when meaningfully positive; parseFloat treats "" and "0" as not positive.
  const isPositive = (v: string) => parseFloat(v) > 0;
  const hasValues =
    isPositive(draft.proteinG) ||
    isPositive(draft.carbsG) ||
    isPositive(draft.fatG) ||
    isPositive(draft.caloriesKcal);
  const canCollapse = isExpanded && isSaved;

  const updateMenuLayout = useCallback(() => {
    const trigger = menuButtonRef.current;
    const menu = menuRef.current;

    if (!trigger || !menu) {
      return;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;

    setMenuLayout(
      getFloatingMenuLayout({
        triggerTop: triggerRect.top,
        triggerBottom: triggerRect.bottom,
        menuHeight: menu.scrollHeight,
        viewportHeight,
        bottomInset: MENU_BOTTOM_INSET_PX,
        topInset: MENU_VIEWPORT_MARGIN_PX,
      }),
    );
  }, []);

  useLayoutEffect(() => {
    if (!menuOpen) {
      return;
    }

    updateMenuLayout();

    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", updateMenuLayout);
    visualViewport?.addEventListener("scroll", updateMenuLayout);
    window.addEventListener("resize", updateMenuLayout);
    window.addEventListener("scroll", updateMenuLayout, true);

    return () => {
      visualViewport?.removeEventListener("resize", updateMenuLayout);
      visualViewport?.removeEventListener("scroll", updateMenuLayout);
      window.removeEventListener("resize", updateMenuLayout);
      window.removeEventListener("scroll", updateMenuLayout, true);
    };
  }, [confirmingDelete, menuOpen, updateMenuLayout]);

  const closeMenu = useCallback(() => {
    setConfirmingDelete(false);
    setMenuLayout(null);
    setMenuOpen(false);
  }, []);

  // Same outside-pointerdown + Escape dismissal as other dropdowns (see add-food-button.tsx); no roving-tabindex nav.
  useDismissableLayer({
    active: menuOpen,
    layerRef: menuContainerRef,
    onDismiss: closeMenu,
  });

  function toggleExpanded() {
    if (isExpanded) {
      if (!canCollapse) return;
      onDiscardChanges?.(draft.clientId);
      setMenuOpen(false);
      setConfirmingDelete(false);
      setIsExpanded(false);
      return;
    }

    setIsExpanded(true);
  }

  async function handleSave() {
    if (await onSave(draft.clientId)) {
      setMenuOpen(false);
      setConfirmingDelete(false);
      setIsExpanded(false);
    }
  }

  return (
    <article className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] shadow-[0_4px_16px_rgba(74,45,28,0.05)]">
      <div className="px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--color-ink)]">
            {heading}
          </h3>

          <span className={`shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${
            draft.status === "planned"
              ? "bg-[var(--color-card-muted)] text-[var(--color-accent)]"
              : draft.status === "skipped"
                ? "bg-[var(--color-card-muted)] text-[var(--color-muted)]"
                : "bg-[color-mix(in_srgb,var(--color-success)_14%,transparent)] text-[var(--color-success)]"
          }`}>
            {draft.status}
          </span>

          {isSaved && draft.status === "planned" && onStatusChange ? (
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onStatusChange(draft.clientId, "eaten");
              }}
              className="shrink-0 rounded-lg bg-[var(--color-accent)] px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
            >
              Mark eaten
            </button>
          ) : null}

          {isSaved && draft.status === "skipped" && onStatusChange ? (
            <button
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                onStatusChange(draft.clientId, "planned");
              }}
              className="shrink-0 rounded-lg border border-[var(--color-border-strong)] px-2.5 py-1 text-xs font-semibold text-[var(--color-muted)] disabled:opacity-50"
            >
              Restore
            </button>
          ) : null}

          {!isExpanded || canCollapse ? (
            <button
              type="button"
              disabled={busy}
              onClick={toggleExpanded}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-muted)] transition hover:bg-[var(--color-card-muted)] hover:text-[var(--color-ink)] disabled:opacity-50"
              aria-label={`${isExpanded ? "Collapse" : "Edit details for"} ${heading}`}
              aria-expanded={isExpanded}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {isExpanded ? <path d="M4 10l4-4 4 4" /> : <path d="M4 6l4 4 4-4" />}
              </svg>
            </button>
          ) : null}

          <div ref={menuContainerRef} className="relative shrink-0">
            <button
              ref={menuButtonRef}
              type="button"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation();
                if (menuOpen) {
                  closeMenu();
                  return;
                }

                setMenuOpen(true);
              }}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-[var(--color-muted)] transition hover:bg-[var(--color-card-muted)] hover:text-[var(--color-ink)] disabled:opacity-50"
              aria-label={`More actions for ${heading}`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <circle cx="3.5" cy="8" r="1.3" />
                <circle cx="8" cy="8" r="1.3" />
                <circle cx="12.5" cy="8" r="1.3" />
              </svg>
            </button>
            {menuOpen ? (
              <div
                ref={menuRef}
                role="menu"
                data-placement={menuLayout?.placement ?? "below"}
                className={[
                  "absolute right-0 z-50 w-44 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] py-1 text-sm shadow-xl",
                  (menuLayout?.placement ?? "below") === "above"
                    ? "bottom-9"
                    : "top-9",
                ].join(" ")}
                style={
                  menuLayout
                    ? { maxHeight: `${menuLayout.maxHeight}px` }
                    : undefined
                }
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    if (isExpanded) {
                      onDiscardChanges?.(draft.clientId);
                    }
                    setIsExpanded((expanded) => !expanded);
                    setMenuOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]"
                >
                  {isExpanded ? "Collapse" : "Edit details"}
                </button>
                {onStatusChange && isSaved ? (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onStatusChange(draft.clientId, "planned");
                        setMenuOpen(false);
                      }}
                      className="block w-full px-3 py-2 text-left text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]"
                    >
                      Mark planned
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onStatusChange(draft.clientId, "eaten");
                        setMenuOpen(false);
                      }}
                      className="block w-full px-3 py-2 text-left text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]"
                    >
                      Mark eaten
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onStatusChange(draft.clientId, "skipped");
                        setMenuOpen(false);
                      }}
                      className="block w-full px-3 py-2 text-left text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]"
                    >
                      Skip
                    </button>
                  </>
                ) : null}
                {onCopyToToday && isSaved ? (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={isCopied}
                    onClick={() => {
                      onCopyToToday(draft.clientId);
                      setMenuOpen(false);
                    }}
                    className="block w-full px-3 py-2 text-left text-[var(--color-ink)] hover:bg-[var(--color-card-muted)] disabled:opacity-50"
                  >
                    {isCopied ? "Copied" : "Copy to today"}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onDuplicate(draft.clientId);
                    setMenuOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]"
                >
                  Duplicate
                </button>
                {confirmingDelete ? (
                  <div className="mx-2 my-1 rounded-lg bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] p-2">
                    <p className="mb-2 text-xs font-semibold text-[var(--color-danger)]">
                      Delete this item?
                    </p>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(false)}
                        className="flex-1 rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-semibold text-[var(--color-muted)]"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          onDelete(draft.clientId);
                          setMenuOpen(false);
                          setConfirmingDelete(false);
                        }}
                        className="flex-1 rounded-md bg-[var(--color-danger)] px-2 py-1 text-xs font-semibold text-white disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => setConfirmingDelete(true)}
                    className="block w-full px-3 py-2 text-left text-[var(--color-danger)] hover:bg-[var(--color-card-muted)]"
                  >
                    Delete
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>

        {!isExpanded && (
          <div className="mt-1.5 flex items-center gap-1">
            {hasValues && (
              <div className="flex flex-1 flex-wrap items-center gap-1">
                {MEAL_MACRO_CHIPS.map(({ key, prefix, colorClass }) =>
                  isPositive(draft[key]) ? (
                    <span key={key} className={colorClass}>
                      {prefix ? `${prefix} ${draft[key]}g` : `${draft[key]} kcal`}
                    </span>
                  ) : null,
                )}
              </div>
            )}

            <span className="ml-auto text-[10px] font-medium text-[var(--color-muted)]">
              {draft.quantity} {draft.unit}
            </span>
          </div>
        )}
      </div>

      {isExpanded && (
        <div className="border-t border-[var(--color-border)] px-4 pb-4 pt-3">
          <label className="block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
              Name
            </span>
            <input
              type="text"
              value={draft.label}
              disabled={busy}
              onChange={(event) => onChange(draft.clientId, "label", event.target.value)}
              className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
              placeholder="Chicken breast, rice, banana..."
              autoFocus={!isSaved}
            />
          </label>

          <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
            <NumberInputField
              label="Quantity"
              value={draft.quantity}
              disabled={busy}
              step="0.01"
              unit={draft.unit}
              inputClassName={MEAL_CARD_NUMBER_INPUT_CLASS}
              onChange={(value) => onChange(draft.clientId, "quantity", value)}
            />
            <label className="block min-w-28">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
                Unit
              </span>
              <select
                value={draft.unit}
                disabled={busy}
                onChange={(event) => onChange(draft.clientId, "unit", event.target.value)}
                className="h-[42px] w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
              >
                <option value="g">g</option>
                <option value="ml">ml</option>
                <option value="serving">serving</option>
                <option value="count">count</option>
              </select>
            </label>
          </div>

          <label className="mt-3 block">
            <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
              Group
            </span>
            <select
              value={draft.mealGroupId ?? ""}
              disabled={busy}
              onChange={(event) => {
                const nextGroupId = event.target.value || null;
                if (onGroupChange) {
                  onGroupChange(draft.clientId, nextGroupId);
                } else {
                  onChange(draft.clientId, "mealGroupId", event.target.value);
                }
              }}
              className="h-[42px] w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            >
              <option value="">Ungrouped</option>
              {mealGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.label}
                </option>
              ))}
            </select>
          </label>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <NumberInputField
              label="Protein"
              value={draft.proteinG}
              disabled={busy}
              step="0.1"
              unit="g"
              inputClassName={MEAL_CARD_NUMBER_INPUT_CLASS}
              onChange={(value) => onChange(draft.clientId, "proteinG", value)}
            />
            <NumberInputField
              label="Carbs"
              value={draft.carbsG}
              disabled={busy}
              step="0.1"
              unit="g"
              inputClassName={MEAL_CARD_NUMBER_INPUT_CLASS}
              onChange={(value) => onChange(draft.clientId, "carbsG", value)}
            />
            <NumberInputField
              label="Fat"
              value={draft.fatG}
              disabled={busy}
              step="0.1"
              unit="g"
              inputClassName={MEAL_CARD_NUMBER_INPUT_CLASS}
              onChange={(value) => onChange(draft.clientId, "fatG", value)}
            />
            <NumberInputField
              label="Calories"
              value={draft.caloriesKcal}
              disabled={busy}
              step="1"
              unit="kcal"
              inputClassName={MEAL_CARD_NUMBER_INPUT_CLASS}
              onChange={(value) => onChange(draft.clientId, "caloriesKcal", value)}
            />
          </div>

          {error ? (
            <p className="mt-3 text-sm text-[var(--color-danger)]">{error}</p>
          ) : null}

          <button
            type="button"
            disabled={busy}
            onClick={() => void handleSave()}
            className="mt-3 w-full rounded-xl bg-[var(--color-accent)] px-4 py-2.5 text-sm font-semibold text-white transition-transform duration-150 hover:-translate-y-0.5 disabled:cursor-wait disabled:opacity-70"
          >
            {busy ? "Saving..." : isSaved ? "Update" : "Save"}
          </button>
        </div>
      )}
    </article>
  );
}

// Memoized: a day's log re-renders every card on each keystroke otherwise; callers must pass stable callbacks.
export const MealCard = memo(MealCardComponent);

export type { MealDraft };
