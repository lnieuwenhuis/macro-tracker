"use client";

import { type FormEvent, useState } from "react";

import type { GymSlot } from "@macro-tracker/db";
import { minutesToTimeInput, timeInputToMinutes } from "@/lib/gym-time";

import { CompactModal } from "./compact-modal";
import {
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
  TEXT_INPUT_CLASS,
  WEEKDAY_LABELS,
} from "./gym-ui";

type GymSlotFormModalProps = {
  mode: "create" | "edit";
  slot: GymSlot | null;
  isPending: boolean;
  onClose: () => void;
  onSubmit: (input: {
    id?: string;
    title: string;
    description: string | null;
    recurrence: "once" | "weekly";
    slotDate?: string | null;
    weekday?: number | null;
    startMinute: number;
    endMinute: number;
  }) => void;
};

export function GymSlotFormModal({
  mode,
  slot,
  isPending,
  onClose,
  onSubmit,
}: GymSlotFormModalProps) {
  const [title, setTitle] = useState(slot?.title ?? "");
  const [description, setDescription] = useState(slot?.description ?? "");
  const [recurrence, setRecurrence] = useState<"once" | "weekly">(
    slot?.recurrence ?? "weekly",
  );
  const [slotDate, setSlotDate] = useState(slot?.slotDate ?? "");
  const [weekday, setWeekday] = useState(slot?.weekday ?? 1);
  const [startTime, setStartTime] = useState(
    slot ? minutesToTimeInput(slot.startMinute) : "17:00",
  );
  const [endTime, setEndTime] = useState(
    slot ? minutesToTimeInput(slot.endMinute) : "18:00",
  );
  const [formError, setFormError] = useState<string | null>(null);

  const occurrenceChanged =
    mode === "edit" &&
    slot !== null &&
    (slot.recurrence === "weekly"
      ? weekday !== slot.weekday
      : slotDate !== slot.slotDate);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const startMinute = timeInputToMinutes(startTime, "start");
    const endMinute = timeInputToMinutes(endTime, "end");
    if (startMinute >= endMinute) {
      setFormError(
        "A slot must start before it ends; overnight slots aren't supported.",
      );
      return;
    }
    if (recurrence === "once" && !slotDate) {
      setFormError("Pick a date for the one-off slot.");
      return;
    }
    onSubmit({
      ...(slot ? { id: slot.id } : {}),
      title: title.trim() || "Gym",
      description: description.trim() || null,
      recurrence,
      slotDate: recurrence === "once" ? slotDate : null,
      weekday: recurrence === "weekly" ? weekday : null,
      startMinute,
      endMinute,
    });
  }

  return (
    <CompactModal
      ariaLabel={mode === "create" ? "Add gym slot" : "Edit gym slot"}
      title={mode === "create" ? "Add gym slot" : "Edit gym slot"}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-[var(--color-muted-strong)]">
            Title
          </span>
          <input
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Gym"
            maxLength={100}
            className={TEXT_INPUT_CLASS}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-[var(--color-muted-strong)]">
            Description <span className="font-normal">(only you see this)</span>
          </span>
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            maxLength={500}
            className={`${TEXT_INPUT_CLASS} resize-none`}
          />
        </label>

        <div>
          <span className="mb-1 block text-xs font-semibold text-[var(--color-muted-strong)]">
            Repeats
          </span>
          <div className="grid grid-cols-2 gap-2">
            {([
              { id: "weekly", label: "Every week" },
              { id: "once", label: "One day" },
            ] as const).map((option) => (
              <button
                key={option.id}
                type="button"
                disabled={mode === "edit"}
                onClick={() => setRecurrence(option.id)}
                aria-pressed={recurrence === option.id}
                className={[
                  "rounded-xl border px-3 py-2 text-sm font-semibold transition disabled:opacity-60",
                  recurrence === option.id
                    ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-accent-strong)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface-strong)] text-[var(--color-ink)]",
                ].join(" ")}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {recurrence === "weekly" ? (
          <div>
            <span className="mb-1 block text-xs font-semibold text-[var(--color-muted-strong)]">
              Day of the week
            </span>
            <div className="grid grid-cols-7 gap-1">
              {WEEKDAY_LABELS.map((label, index) => {
                const value = index + 1;
                return (
                  <button
                    key={label}
                    type="button"
                    onClick={() => setWeekday(value)}
                    aria-pressed={weekday === value}
                    className={[
                      "rounded-lg px-1 py-2 text-xs font-semibold transition",
                      weekday === value
                        ? "bg-[var(--color-accent)] text-white"
                        : "bg-[var(--color-card-muted)] text-[var(--color-muted-strong)]",
                    ].join(" ")}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <label className="block min-w-0">
            <span className="mb-1 block text-xs font-semibold text-[var(--color-muted-strong)]">
              Date
            </span>
            <input
              type="date"
              value={slotDate}
              onChange={(event) => setSlotDate(event.target.value)}
              className={`${TEXT_INPUT_CLASS} min-w-0 appearance-none`}
            />
          </label>
        )}

        {/* iOS Safari gives time inputs an intrinsic min width; min-w-0 plus appearance-none keeps them inside the grid. */}
        <div className="grid grid-cols-2 gap-2">
          <label className="block min-w-0">
            <span className="mb-1 block text-xs font-semibold text-[var(--color-muted-strong)]">
              From
            </span>
            <input
              type="time"
              value={startTime}
              onChange={(event) => setStartTime(event.target.value)}
              required
              className={`${TEXT_INPUT_CLASS} min-w-0 appearance-none`}
            />
          </label>
          <label className="block min-w-0">
            <span className="mb-1 block text-xs font-semibold text-[var(--color-muted-strong)]">
              Until
            </span>
            <input
              type="time"
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
              required
              className={`${TEXT_INPUT_CLASS} min-w-0 appearance-none`}
            />
          </label>
        </div>

        {occurrenceChanged ? (
          <p className="text-xs text-[var(--color-danger)]">
            Moving this slot to another day resets its day statuses.
          </p>
        ) : null}
        {formError ? (
          <p className="text-sm text-[var(--color-danger)]" role="alert">
            {formError}
          </p>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON_CLASS}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={isPending}
            className={PRIMARY_BUTTON_CLASS}
          >
            {mode === "create" ? "Add slot" : "Save changes"}
          </button>
        </div>
      </form>
    </CompactModal>
  );
}
