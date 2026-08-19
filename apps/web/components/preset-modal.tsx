"use client";

import type { MealTemplate } from "@macro-tracker/db";
import { useMemo, useState } from "react";

import {
  canEditAsSingleFoodTemplate,
  getTemplateMacroTotals,
  isDayTemplate,
  isFoodItemTemplate,
} from "@/lib/template-macros";
import {
  getInitialPresetTemplateKind,
  resolvePresetModalActiveKind,
  type PresetTemplateKind,
} from "@/lib/preset-modal-state";

import { ConfirmDeleteButton } from "./confirm-delete-button";
import { CloseButton } from "./close-button";
import { NumberInputField } from "./number-input-field";
import { OverlayPortal, useBodyScrollLock, useEscapeDismiss } from "./overlay-portal";

type PresetMutationState =
  | { type: "save" }
  | { type: "apply"; presetId: string }
  | { type: "update" | "delete"; presetId: string };

type PresetModalProps = {
  presets: MealTemplate[];
  mutation: PresetMutationState | null;
  errorMessage: string | null;
  initialKind?: PresetTemplateKind | null;
  onClose: () => void;
  onSelect: (preset: MealTemplate) => void;
  onSave: (input: TemplateMacroInput) => Promise<boolean>;
  onUpdate: (id: string, input: TemplateMacroInput) => Promise<boolean>;
  onDelete: (presetId: string) => Promise<boolean>;
};

type TemplateMacroInput = {
  label: string;
  proteinG: number;
  carbsG: number;
  fatG: number;
  caloriesKcal: number;
};

type PresetDraft = {
  label: string;
  proteinG: string;
  carbsG: string;
  fatG: string;
  caloriesKcal: string;
};

function emptyDraft(): PresetDraft {
  return { label: "", proteinG: "", carbsG: "", fatG: "", caloriesKcal: "" };
}

function presetToDraft(preset: MealTemplate): PresetDraft {
  const item = preset.items[0] ?? null;
  return {
    label: preset.label,
    proteinG: String(item?.proteinG ?? 0),
    carbsG: String(item?.carbsG ?? 0),
    fatG: String(item?.fatG ?? 0),
    caloriesKcal: String(item?.caloriesKcal ?? 0),
  };
}

const PRESET_NUMBER_INPUT_CLASS =
  "w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2 pr-9 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60";

export function PresetModal({
  presets,
  mutation,
  errorMessage,
  initialKind = null,
  onClose,
  onSelect,
  onSave,
  onUpdate,
  onDelete,
}: PresetModalProps) {
  const [showCreateForm, setShowCreateForm] = useState(presets.length === 0);
  const [draft, setDraft] = useState<PresetDraft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<PresetDraft>(emptyDraft);
  const mutationsDisabled = mutation !== null;
  const foodItemPresets = useMemo(
    () => presets.filter(isFoodItemTemplate),
    [presets],
  );
  const dayPresets = useMemo(
    () => presets.filter(isDayTemplate),
    [presets],
  );
  const [selectedKind, setSelectedKind] = useState<PresetTemplateKind>(() =>
    initialKind ??
      getInitialPresetTemplateKind({
        foodItemCount: foodItemPresets.length,
        dayCount: dayPresets.length,
      }),
  );
  const activeKind = resolvePresetModalActiveKind({ selectedKind });
  const visiblePresets = activeKind === "food" ? foodItemPresets : dayPresets;
  const activeLabel = activeKind === "food" ? "food item templates" : "day templates";
  useBodyScrollLock();

  function dismissModal() {
    if (mutation) {
      return;
    }

    if (editingId) {
      setEditingId(null);
      return;
    }

    onClose();
  }

  function selectKind(kind: PresetTemplateKind) {
    if (mutation) {
      return;
    }

    setSelectedKind(kind);
    setEditingId(null);
    if (kind === "day") {
      setShowCreateForm(false);
    }
  }

  useEscapeDismiss(!mutation, dismissModal);

  async function handleSave() {
    if (!draft.label.trim()) return;
    const saved = await onSave({
      label: draft.label.trim(),
      proteinG: Number(draft.proteinG) || 0,
      carbsG: Number(draft.carbsG) || 0,
      fatG: Number(draft.fatG) || 0,
      caloriesKcal: Math.round(Number(draft.caloriesKcal) || 0),
    });

    if (!saved) {
      return;
    }

    setDraft(emptyDraft());
    setShowCreateForm(false);
  }

  function startEdit(preset: MealTemplate) {
    if (!canEditAsSingleFoodTemplate(preset)) {
      return;
    }

    setEditingId(preset.id);
    setEditDraft(presetToDraft(preset));
    setShowCreateForm(false);
  }

  async function handleUpdate() {
    if (!editDraft.label.trim() || !editingId) return;
    const updated = await onUpdate(editingId, {
      label: editDraft.label.trim(),
      proteinG: Number(editDraft.proteinG) || 0,
      carbsG: Number(editDraft.carbsG) || 0,
      fatG: Number(editDraft.fatG) || 0,
      caloriesKcal: Math.round(Number(editDraft.caloriesKcal) || 0),
    });

    if (!updated) {
      return;
    }

    setEditingId(null);
  }

  return (
    <OverlayPortal>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
        onClick={dismissModal}
        aria-hidden="true"
      />

      {/* Modal panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Meal Templates"
        aria-busy={mutation ? "true" : "false"}
        className="fixed inset-x-4 top-[8%] z-50 mx-auto max-h-[82vh] max-w-sm overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-2xl"
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-[var(--color-ink)]">Meal Templates</h2>
          <CloseButton
            onClick={onClose}
            disabled={mutationsDisabled}
            className="rounded-lg p-1.5 text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
            iconSize={18}
          />
        </div>

        {errorMessage ? (
          <p className="mb-4 rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/8 px-3 py-2 text-sm text-[var(--color-danger)]">
            {errorMessage}
          </p>
        ) : null}

        <div className="mb-4 grid grid-cols-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-card-muted)] p-1">
          {[
            { kind: "food" as const, label: "Food items", count: foodItemPresets.length },
            { kind: "day" as const, label: "Days", count: dayPresets.length },
          ].map((option) => {
            const isActive = activeKind === option.kind;
            return (
              <button
                key={option.kind}
                type="button"
                onClick={() => selectKind(option.kind)}
                disabled={mutationsDisabled}
                aria-pressed={isActive}
                className={[
                  "rounded-lg px-3 py-2 text-xs font-bold transition",
                  isActive
                    ? "bg-[var(--color-surface-strong)] text-[var(--color-accent)] shadow-sm"
                    : "text-[var(--color-muted)] hover:text-[var(--color-ink)]",
                ].join(" ")}
              >
                {option.label} ({option.count})
              </button>
            );
          })}
        </div>

        {/* Empty state */}
        {visiblePresets.length === 0 && (
          <p className="py-3 text-center text-sm text-[var(--color-muted)]">
            No {activeLabel} yet.
          </p>
        )}

        {/* Preset list */}
        {visiblePresets.length > 0 && (
          <div className="space-y-2">
            {visiblePresets.map((preset) => {
              const totals = getTemplateMacroTotals(preset.items);
              const canEditPreset = canEditAsSingleFoodTemplate(preset);
              const itemCount = preset.items.length;

              return editingId === preset.id ? (
                /* Inline edit form */
                <div
                  key={preset.id}
                  className="rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-card-subtle)] p-3"
                >
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
                      Name
                    </span>
                    <input
                      type="text"
                      value={editDraft.label}
                      disabled={mutationsDisabled}
                      onChange={(e) => setEditDraft({ ...editDraft, label: e.target.value })}
                      className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
                    />
                  </label>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <NumberInputField label="Protein" value={editDraft.proteinG} unit="g" step="0.1" disabled={mutationsDisabled} inputClassName={PRESET_NUMBER_INPUT_CLASS} onChange={(v) => setEditDraft({ ...editDraft, proteinG: v })} />
                    <NumberInputField label="Carbs" value={editDraft.carbsG} unit="g" step="0.1" disabled={mutationsDisabled} inputClassName={PRESET_NUMBER_INPUT_CLASS} onChange={(v) => setEditDraft({ ...editDraft, carbsG: v })} />
                    <NumberInputField label="Fat" value={editDraft.fatG} unit="g" step="0.1" disabled={mutationsDisabled} inputClassName={PRESET_NUMBER_INPUT_CLASS} onChange={(v) => setEditDraft({ ...editDraft, fatG: v })} />
                    <NumberInputField label="Calories" value={editDraft.caloriesKcal} unit="kcal" step="1" disabled={mutationsDisabled} inputClassName={PRESET_NUMBER_INPUT_CLASS} onChange={(v) => setEditDraft({ ...editDraft, caloriesKcal: v })} />
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      disabled={mutationsDisabled}
                      className="flex-1 rounded-xl border border-[var(--color-border-strong)] px-4 py-2 text-sm font-semibold text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleUpdate}
                      disabled={!editDraft.label.trim() || mutationsDisabled}
                      className="flex-1 rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {mutation?.type === "update" && mutation.presetId === preset.id ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
              ) : (
                /* Normal row */
                <div
                  key={preset.id}
                  className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] px-3 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--color-ink)]">
                      {preset.label}
                    </p>
                    <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5">
                      <span className="text-[10px] font-semibold text-[var(--color-bar-protein)]">P {totals.proteinG}g</span>
                      <span className="text-[10px] font-semibold text-[var(--color-bar-carbs)]">C {totals.carbsG}g</span>
                      <span className="text-[10px] font-semibold text-[var(--color-bar-fat)]">F {totals.fatG}g</span>
                      <span className="text-[10px] font-semibold text-[var(--color-muted)]">{totals.caloriesKcal} kcal</span>
                      {itemCount > 1 ? (
                        <span className="text-[10px] font-semibold text-[var(--color-muted)]">{itemCount} items</span>
                      ) : null}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onSelect(preset)}
                    disabled={mutationsDisabled}
                    className="shrink-0 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-white transition hover:-translate-y-0.5"
                  >
                    {mutation?.type === "apply" && mutation.presetId === preset.id
                      ? "Adding..."
                      : "Add"}
                  </button>

                  {canEditPreset ? (
                    <button
                      type="button"
                      onClick={() => startEdit(preset)}
                      disabled={mutationsDisabled}
                      className="shrink-0 rounded-lg p-1.5 text-[var(--color-muted)] transition hover:text-[var(--color-accent)]"
                      aria-label={`Edit ${preset.label}`}
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9.5 2.5l2 2L4 12H2v-2L9.5 2.5z" />
                      </svg>
                    </button>
                  ) : null}

                  <ConfirmDeleteButton
                    onConfirm={() => void onDelete(preset.id)}
                    disabled={mutationsDisabled}
                    ariaLabel={`Delete ${preset.label}`}
                    className="shrink-0 rounded-lg p-1.5 text-[var(--color-muted)] transition hover:text-[var(--color-danger)]"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                      <line x1="3" y1="3" x2="11" y2="11" />
                      <line x1="11" y1="3" x2="3" y2="11" />
                    </svg>
                  </ConfirmDeleteButton>
                </div>
              );
            })}
          </div>
        )}

        {/* Create form toggle */}
        {activeKind === "food" ? (
          <button
            type="button"
            onClick={() => { setShowCreateForm(!showCreateForm); setEditingId(null); }}
            disabled={mutationsDisabled}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--color-border-strong)] px-4 py-2.5 text-sm font-medium text-[var(--color-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              {showCreateForm ? (
                <line x1="3" y1="7" x2="11" y2="7" />
              ) : (
                <>
                  <line x1="7" y1="2" x2="7" y2="12" />
                  <line x1="2" y1="7" x2="12" y2="7" />
                </>
              )}
            </svg>
            {showCreateForm ? "Cancel" : "Save new template"}
          </button>
        ) : null}

        {/* Inline create form */}
        {activeKind === "food" && showCreateForm && (
          <div className="mt-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
                Name
              </span>
              <input
                type="text"
                value={draft.label}
                disabled={mutationsDisabled}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="Chicken breast..."
                className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
              />
            </label>

            <div className="mt-2 grid grid-cols-2 gap-2">
              <NumberInputField label="Protein" value={draft.proteinG} unit="g" step="0.1" disabled={mutationsDisabled} inputClassName={PRESET_NUMBER_INPUT_CLASS} onChange={(v) => setDraft({ ...draft, proteinG: v })} />
              <NumberInputField label="Carbs" value={draft.carbsG} unit="g" step="0.1" disabled={mutationsDisabled} inputClassName={PRESET_NUMBER_INPUT_CLASS} onChange={(v) => setDraft({ ...draft, carbsG: v })} />
              <NumberInputField label="Fat" value={draft.fatG} unit="g" step="0.1" disabled={mutationsDisabled} inputClassName={PRESET_NUMBER_INPUT_CLASS} onChange={(v) => setDraft({ ...draft, fatG: v })} />
              <NumberInputField label="Calories" value={draft.caloriesKcal} unit="kcal" step="1" disabled={mutationsDisabled} inputClassName={PRESET_NUMBER_INPUT_CLASS} onChange={(v) => setDraft({ ...draft, caloriesKcal: v })} />
            </div>

            <button
              type="button"
              onClick={handleSave}
              disabled={!draft.label.trim() || mutationsDisabled}
              className="mt-3 w-full rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation?.type === "save" ? "Saving template..." : "Save template"}
            </button>
          </div>
        )}
      </div>
    </OverlayPortal>
  );
}
