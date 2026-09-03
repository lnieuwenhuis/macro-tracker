"use client";

import { useState } from "react";

import type {
  GymPageData,
  GymResolvedSlot,
  GymSlot,
  GymSlotStatus,
} from "@macro-tracker/db";
import {
  deleteGymSlotAction,
  inviteGymBuddyAction,
  removeGymBuddyAction,
  respondGymBuddyInviteAction,
  saveGymSlotAction,
  setGymSlotStatusAction,
} from "@/lib/actions";
import { formatMinutesAsTime, formatSelectedDate } from "@/lib/formatting";
import { useGymNowMinute } from "@/lib/gym-clock";
import { gymStatusLabel } from "@/lib/gym-time";
import { useActionRunner } from "@/lib/use-action-runner";

import { AppShell } from "./app-shell";
import { CompactModal } from "./compact-modal";
import { ConfirmDeleteButton } from "./confirm-delete-button";
import { BuddiesPanel } from "./gym-buddies-panel";
import { GymOverlapList } from "./gym-overlap-list";
import { GymSlotFormModal } from "./gym-slot-form-modal";
import {
  CARD_CLASS,
  EMPTY_STATE_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
  SECTION_HEADING_CLASS,
  TrashIcon,
  WEEKDAY_LABELS,
} from "./gym-ui";

function statusChipClass(status: GymSlotStatus) {
  const base =
    "shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] transition";
  switch (status) {
    case "going":
      return `${base} bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-[var(--color-accent-strong)]`;
    case "done":
      return `${base} bg-[color-mix(in_srgb,var(--color-success)_18%,transparent)] text-[var(--color-success)]`;
    case "skipped":
      return `${base} bg-[color-mix(in_srgb,var(--color-danger)_14%,transparent)] text-[var(--color-danger)]`;
    default:
      return `${base} bg-[var(--color-card-muted)] text-[var(--color-muted-strong)]`;
  }
}

function slotTimeRange(slot: { startMinute: number; endMinute: number }) {
  return `${formatMinutesAsTime(slot.startMinute)}–${formatMinutesAsTime(slot.endMinute)}`;
}

function describeSlotSchedule(slot: GymSlot) {
  if (slot.recurrence === "weekly") {
    const weekday = WEEKDAY_LABELS[(slot.weekday ?? 1) - 1] ?? "Mon";
    return `Every ${weekday} · ${slotTimeRange(slot)}`;
  }
  return `${slot.slotDate ? formatSelectedDate(slot.slotDate) : "One-off"} · ${slotTimeRange(slot)}`;
}

type GymShellProps = {
  userEmail: string;
  canAccessAdmin: boolean;
  selectedDate: string;
  todayStr: string;
  data: GymPageData;
};

export function GymShell({
  userEmail,
  canAccessAdmin,
  selectedDate,
  todayStr,
  data,
}: GymShellProps) {
  const { run, isPending, error } = useActionRunner();
  const [activeTab, setActiveTab] = useState<"schedule" | "buddies">("schedule");
  const [statusOverrides, setStatusOverrides] = useState<
    Record<string, GymSlotStatus>
  >({});
  const [statusChooser, setStatusChooser] = useState<GymResolvedSlot | null>(null);
  const [slotModal, setSlotModal] = useState<
    | { mode: "create" }
    | { mode: "edit"; slot: GymSlot }
    | null
  >(null);
  const [weeklyDeleteTarget, setWeeklyDeleteTarget] = useState<GymSlot | null>(null);
  const nowMinute = useGymNowMinute();

  function runAction(action: () => Promise<{ ok: boolean; error?: string }>) {
    run(action, {
      fallbackError: "Something went wrong.",
      refresh: true,
      onError: () => setStatusOverrides({}),
    });
  }

  function effectiveStatus(slot: GymResolvedSlot): GymSlotStatus {
    return statusOverrides[slot.id] ?? slot.status;
  }

  function handleStatusPick(slot: GymResolvedSlot, status: GymSlotStatus) {
    setStatusChooser(null);
    if (status === effectiveStatus(slot)) {
      return;
    }
    setStatusOverrides((current) => ({ ...current, [slot.id]: status }));
    runAction(() =>
      setGymSlotStatusAction({ slotId: slot.id, date: selectedDate, status }),
    );
  }

  function handleDeleteSlot(slot: GymSlot) {
    setWeeklyDeleteTarget(null);
    runAction(() => deleteGymSlotAction({ id: slot.id }));
  }

  const buddyLists = data.buddies;
  const pendingInviteCount = buddyLists.pendingIncoming.length;

  const statusLabelFor = (slot: GymResolvedSlot, status: GymSlotStatus) =>
    gymStatusLabel(status, {
      date: selectedDate,
      todayStr,
      endMinute: slot.endMinute,
      nowMinute,
    });

  return (
    <>
      <AppShell
        userEmail={userEmail}
        canAccessAdmin={canAccessAdmin}
        selectedDate={selectedDate}
        title="Gym Schedule"
        activeTab="log"
        showDateNavigation
        basePath="/gym"
        showGymShortcut
        gymShortcutActive
        todayStr={todayStr}
      >
        <div className="mb-4 rounded-[1.45rem] border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface-strong)_92%,transparent)] p-1 shadow-[0_16px_30px_rgba(0,0,0,0.12)] backdrop-blur-xl">
          <div
            role="tablist"
            aria-label="Gym schedule views"
            className="grid h-12 grid-cols-2 gap-2"
          >
            {([
              { id: "schedule", label: "Schedule" },
              { id: "buddies", label: "Buddies" },
            ] as const).map((tab) => {
              const isActive = activeTab === tab.id;
              const showDot = tab.id === "buddies" && pendingInviteCount > 0;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTab(tab.id)}
                  className={[
                    "relative h-full rounded-[1.05rem] px-4 text-sm font-semibold transition",
                    isActive
                      ? "bg-[var(--color-accent)] text-white shadow-[0_10px_24px_rgba(0,0,0,0.14)]"
                      : "text-[var(--color-muted-strong)] hover:bg-[var(--color-card-muted)]",
                  ].join(" ")}
                >
                  {tab.label}
                  {showDot ? (
                    <span
                      className={[
                        "absolute right-3 top-3 h-2 w-2 rounded-full",
                        isActive ? "bg-white" : "bg-[var(--color-accent)]",
                      ].join(" ")}
                      aria-hidden="true"
                    />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {error ? (
          <p className="mb-4 text-sm text-[var(--color-danger)]" role="alert">
            {error}
          </p>
        ) : null}

        {activeTab === "schedule" ? (
          <div className="space-y-6">
            {data.overlaps.length > 0 ? (
              <section>
                <h2 className={SECTION_HEADING_CLASS}>Gym buddies overlap</h2>
                <div className="mt-2">
                  <GymOverlapList overlaps={data.overlaps} />
                </div>
              </section>
            ) : null}

            <section>
              <div className="flex items-center justify-between gap-3">
                <h2 className={SECTION_HEADING_CLASS}>
                  {formatSelectedDate(selectedDate)}
                </h2>
              </div>
              <div className="mt-2 space-y-2">
                {data.day.own.length === 0 ? (
                  <div className={EMPTY_STATE_CLASS}>
                    No gym time planned this day.
                  </div>
                ) : (
                  data.day.own.map((slot) => {
                    const status = effectiveStatus(slot);
                    return (
                      <article
                        key={slot.id}
                        className={`${CARD_CLASS} flex items-center justify-between gap-3`}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[var(--color-ink)]">
                            {slot.title}
                          </p>
                          <p className="text-xs text-[var(--color-muted)]">
                            {slotTimeRange(slot)}
                            {slot.recurrence === "weekly" ? " · repeats weekly" : ""}
                          </p>
                          {slot.description ? (
                            <p className="mt-1 truncate text-xs text-[var(--color-muted)]">
                              {slot.description}
                            </p>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => setStatusChooser(slot)}
                          disabled={isPending}
                          className={statusChipClass(status)}
                          aria-label={`Change status for ${slot.title}`}
                        >
                          {statusLabelFor(slot, status)}
                        </button>
                      </article>
                    );
                  })
                )}
              </div>
            </section>

            {data.day.buddies.map((buddy) => (
              <section key={buddy.user.id}>
                <h2 className={SECTION_HEADING_CLASS}>{buddy.user.name}</h2>
                <div className="mt-2 space-y-2">
                  {buddy.slots.length === 0 ? (
                    <div className={EMPTY_STATE_CLASS}>
                      No gym time planned this day.
                    </div>
                  ) : (
                    buddy.slots.map((slot) => (
                      <article
                        key={slot.id}
                        className={`${CARD_CLASS} flex items-center justify-between gap-3`}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[var(--color-ink)]">
                            {slot.title}
                          </p>
                          <p className="text-xs text-[var(--color-muted)]">
                            {slotTimeRange(slot)}
                          </p>
                        </div>
                        <span className={statusChipClass(slot.status)}>
                          {statusLabelFor(slot, slot.status)}
                        </span>
                      </article>
                    ))
                  )}
                </div>
              </section>
            ))}

            <section>
              <div className="flex items-center justify-between gap-3">
                <h2 className={SECTION_HEADING_CLASS}>Your slots</h2>
                <button
                  type="button"
                  onClick={() => setSlotModal({ mode: "create" })}
                  className={PRIMARY_BUTTON_CLASS}
                >
                  Add slot
                </button>
              </div>
              <div className="mt-2 space-y-2">
                {data.slots.length === 0 ? (
                  <div className={EMPTY_STATE_CLASS}>
                    Add a slot to share when you&rsquo;ll be at the gym.
                  </div>
                ) : (
                  data.slots.map((slot) => (
                    <article
                      key={slot.id}
                      className={`${CARD_CLASS} flex items-center justify-between gap-3`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[var(--color-ink)]">
                          {slot.title}
                        </p>
                        <p className="text-xs text-[var(--color-muted)]">
                          {describeSlotSchedule(slot)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setSlotModal({ mode: "edit", slot })}
                          disabled={isPending}
                          className="rounded-lg p-1.5 text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
                          aria-label={`Edit ${slot.title}`}
                        >
                          <svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12.5 3.5l2 2L6 14l-2.8.8L4 12z" />
                          </svg>
                        </button>
                        {slot.recurrence === "weekly" ? (
                          <button
                            type="button"
                            onClick={() => setWeeklyDeleteTarget(slot)}
                            disabled={isPending}
                            className="rounded-lg p-1.5 text-[var(--color-muted)] transition hover:text-[var(--color-danger)]"
                            aria-label={`Delete ${slot.title}`}
                          >
                            <TrashIcon />
                          </button>
                        ) : (
                          <ConfirmDeleteButton
                            onConfirm={() => handleDeleteSlot(slot)}
                            ariaLabel={`Delete ${slot.title}`}
                            disabled={isPending}
                          >
                            <TrashIcon />
                          </ConfirmDeleteButton>
                        )}
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          </div>
        ) : (
          <BuddiesPanel
            lists={buddyLists}
            friendCode={data.friendCode}
            isPending={isPending}
            onInvite={(identifier, done) => {
              run(() => inviteGymBuddyAction({ identifier }), {
                fallbackError: "Something went wrong.",
                refresh: true,
                onSuccess: (result) =>
                  done(result.result === "accepted"
                    ? "You're now gym buddies!"
                    : "Invite sent."),
              });
            }}
            onRespond={(buddyId, accept) =>
              runAction(() => respondGymBuddyInviteAction({ buddyId, accept }))
            }
            onRemove={(buddyId) =>
              runAction(() => removeGymBuddyAction({ buddyId }))
            }
          />
        )}
      </AppShell>

      {statusChooser ? (
        <CompactModal
          ariaLabel="Change slot status"
          title={statusChooser.title}
          onClose={() => setStatusChooser(null)}
        >
          <div className="space-y-2">
            {(["going", "maybe", "skipped", "done"] as const).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => handleStatusPick(statusChooser, status)}
                className={[
                  "flex w-full items-center justify-between rounded-xl border px-4 py-3 text-sm font-semibold transition",
                  effectiveStatus(statusChooser) === status
                    ? "border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] text-[var(--color-accent-strong)]"
                    : "border-[var(--color-border)] bg-[var(--color-surface-strong)] text-[var(--color-ink)] hover:bg-[var(--color-card-muted)]",
                ].join(" ")}
              >
                {status === "skipped"
                  ? `Skip ${selectedDate === todayStr ? "today" : "this day"}`
                  : statusLabelFor(statusChooser, status)}
                <span className={statusChipClass(status)}>
                  {statusLabelFor(statusChooser, status)}
                </span>
              </button>
            ))}
          </div>
        </CompactModal>
      ) : null}

      {slotModal ? (
        <GymSlotFormModal
          mode={slotModal.mode}
          slot={slotModal.mode === "edit" ? slotModal.slot : null}
          isPending={isPending}
          onClose={() => setSlotModal(null)}
          onSubmit={(input) => {
            setSlotModal(null);
            runAction(() => saveGymSlotAction(input));
          }}
        />
      ) : null}

      {weeklyDeleteTarget ? (
        <CompactModal
          ariaLabel="Delete weekly slot"
          title="Delete weekly slot?"
          onClose={() => setWeeklyDeleteTarget(null)}
        >
          <p className="text-sm text-[var(--color-muted-strong)]">
            This removes <strong>{weeklyDeleteTarget.title}</strong> every week,
            along with its day statuses. To skip just one day, use the
            slot&rsquo;s status instead.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setWeeklyDeleteTarget(null)}
              className={SECONDARY_BUTTON_CLASS}
            >
              Keep it
            </button>
            <button
              type="button"
              onClick={() => handleDeleteSlot(weeklyDeleteTarget)}
              disabled={isPending}
              className="rounded-full bg-[var(--color-danger)] px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:opacity-60"
            >
              Delete series
            </button>
          </div>
        </CompactModal>
      ) : null}
    </>
  );
}
