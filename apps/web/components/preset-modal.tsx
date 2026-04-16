"use client";

import type { FoodPreset } from "@macro-tracker/db";
import { useEffect, useState } from "react";

import { ConfirmDeleteButton } from "./confirm-delete-button";
import { OverlayPortal, useBodyScrollLock } from "./overlay-portal";

type PresetMutationState =
  | { type: "save" }
  | { type: "update" | "delete"; presetId: string };

type PresetModalProps = {
  presets: FoodPreset[];
  mutation: PresetMutationState | null;
  errorMessage: string | null;
  onClose: () => void;
  onSelect: (preset: FoodPreset) => void;
  onSave: (input: Omit<FoodPreset, "id" | "userId">) => Promise<boolean>;
  onUpdate: (id: string, input: Omit<FoodPreset, "id" | "userId">) => Promise<boolean>;
  onDelete: (presetId: string) => Promise<boolean>;
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

function presetToDraft(preset: FoodPreset): PresetDraft {
  return {
    label: preset.label,
    proteinG: String(preset.proteinG),
    carbsG: String(preset.carbsG),
    fatG: String(preset.fatG),
    caloriesKcal: String(preset.caloriesKcal),
  };
}

function SmallInput({
  label,
  value,
  unit,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  unit: string;
  step: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-muted-strong)]">
        {label}
      </span>
      <div className="relative">
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-card-muted)] px-3 py-2 pr-9 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60"
        />
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-[var(--color-muted)]">
          {unit}
        </span>
      </div>
    </label>
  );
}

export function PresetModal({
  presets,
  mutation,
  errorMessage,
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
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (mutation) {
        return;
      }

      if (e.key === "Escape") {
        if (editingId) {
          setEditingId(null);
        } else {
          onClose();
        }
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [editingId, mutation, onClose]);

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

  function startEdit(preset: FoodPreset) {
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
        aria-label="Food Presets"
        aria-busy={mutation ? "true" : "false"}
        className="fixed inset-x-4 top-[8%] z-50 mx-auto max-h-[82vh] max-w-sm overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-2xl"
      >
        {/* Header */}
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-bold text-[var(--color-ink)]">Food Presets</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={mutationsDisabled}
            className="rounded-lg p-1.5 text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
            aria-label="Close"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="4" y1="4" x2="14" y2="14" />
              <line x1="14" y1="4" x2="4" y2="14" />
            </svg>
          </button>
        </div>

        {errorMessage ? (
          <p className="mb-4 rounded-xl border border-[var(--color-danger)]/20 bg-[var(--color-danger)]/8 px-3 py-2 text-sm text-[var(--color-danger)]">
            {errorMessage}
          </p>
        ) : null}

        {/* Empty state */}
        {presets.length === 0 && (
          <p className="py-3 text-center text-sm text-[var(--color-muted)]">
            No presets yet — save one below.
          </p>
        )}

        {/* Preset list */}
        {presets.length > 0 && (
          <div className="space-y-2">
            {presets.map((preset) =>
              editingId === preset.id ? (
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
                    <SmallInput label="Protein" value={editDraft.proteinG} unit="g" step="0.1" disabled={mutationsDisabled} onChange={(v) => setEditDraft({ ...editDraft, proteinG: v })} />
                    <SmallInput label="Carbs" value={editDraft.carbsG} unit="g" step="0.1" disabled={mutationsDisabled} onChange={(v) => setEditDraft({ ...editDraft, carbsG: v })} />
                    <SmallInput label="Fat" value={editDraft.fatG} unit="g" step="0.1" disabled={mutationsDisabled} onChange={(v) => setEditDraft({ ...editDraft, fatG: v })} />
                    <SmallInput label="Calories" value={editDraft.caloriesKcal} unit="kcal" step="1" disabled={mutationsDisabled} onChange={(v) => setEditDraft({ ...editDraft, caloriesKcal: v })} />
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
                      <span className="text-[10px] font-semibold text-[var(--color-bar-protein)]">P {preset.proteinG}g</span>
                      <span className="text-[10px] font-semibold text-[var(--color-bar-carbs)]">C {preset.carbsG}g</span>
                      <span className="text-[10px] font-semibold text-[var(--color-bar-fat)]">F {preset.fatG}g</span>
                      <span className="text-[10px] font-semibold text-[var(--color-muted)]">{preset.caloriesKcal} kcal</span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onSelect(preset)}
                    disabled={mutation?.type === "delete" && mutation.presetId === preset.id}
                    className="shrink-0 rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-semibold text-white transition hover:-translate-y-0.5"
                  >
                    Add
                  </button>

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
              )
            )}
          </div>
        )}

        {/* Create form toggle */}
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
          {showCreateForm ? "Cancel" : "Save new preset"}
        </button>

        {/* Inline create form */}
        {showCreateForm && (
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
              <SmallInput label="Protein" value={draft.proteinG} unit="g" step="0.1" disabled={mutationsDisabled} onChange={(v) => setDraft({ ...draft, proteinG: v })} />
              <SmallInput label="Carbs" value={draft.carbsG} unit="g" step="0.1" disabled={mutationsDisabled} onChange={(v) => setDraft({ ...draft, carbsG: v })} />
              <SmallInput label="Fat" value={draft.fatG} unit="g" step="0.1" disabled={mutationsDisabled} onChange={(v) => setDraft({ ...draft, fatG: v })} />
              <SmallInput label="Calories" value={draft.caloriesKcal} unit="kcal" step="1" disabled={mutationsDisabled} onChange={(v) => setDraft({ ...draft, caloriesKcal: v })} />
            </div>

            <button
              type="button"
              onClick={handleSave}
              disabled={!draft.label.trim() || mutationsDisabled}
              className="mt-3 w-full rounded-xl bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation?.type === "save" ? "Saving preset..." : "Save preset"}
            </button>
          </div>
        )}
      </div>
    </OverlayPortal>
  );
}
