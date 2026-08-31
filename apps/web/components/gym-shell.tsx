"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";

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
import {
  formatFriendCode,
  gymStatusLabel,
  minutesToTimeInput,
  timeInputToMinutes,
} from "@/lib/gym-time";

import { AppShell } from "./app-shell";
import { CompactModal } from "./compact-modal";
import { ConfirmDeleteButton } from "./confirm-delete-button";
import { GymOverlapList } from "./gym-overlap-list";

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const SECTION_HEADING_CLASS =
  "text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]";
const CARD_CLASS =
  "rounded-2xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-4 shadow-[0_4px_16px_rgba(74,45,28,0.05)]";
const EMPTY_STATE_CLASS =
  "rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] px-5 py-8 text-center text-sm text-[var(--color-muted)]";
const PRIMARY_BUTTON_CLASS =
  "rounded-full bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:opacity-60";
const SECONDARY_BUTTON_CLASS =
  "rounded-full border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-4 py-2 text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)] disabled:opacity-60";
const TEXT_INPUT_CLASS =
  "w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]";

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
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"schedule" | "buddies">("schedule");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        setStatusOverrides({});
        return;
      }
      router.refresh();
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
              setError(null);
              startTransition(async () => {
                const result = await inviteGymBuddyAction({ identifier });
                if (!result.ok) {
                  setError(result.error ?? "Something went wrong.");
                  return;
                }
                done(result.result === "accepted"
                  ? "You're now gym buddies!"
                  : "Invite sent.");
                router.refresh();
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

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 5h11" />
      <path d="M7 5V3.5h4V5" />
      <path d="M5 5l.7 9h6.6L13 5" />
    </svg>
  );
}

type BuddiesPanelProps = {
  lists: GymPageData["buddies"];
  friendCode: string;
  isPending: boolean;
  onInvite: (identifier: string, done: (message: string) => void) => void;
  onRespond: (buddyId: string, accept: boolean) => void;
  onRemove: (buddyId: string) => void;
};

function BuddiesPanel({
  lists,
  friendCode,
  isPending,
  onInvite,
  onRespond,
  onRemove,
}: BuddiesPanelProps) {
  const [identifier, setIdentifier] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [showDeclined, setShowDeclined] = useState(false);
  const [copied, setCopied] = useState(false);

  function handleInvite(event: FormEvent) {
    event.preventDefault();
    const trimmed = identifier.trim();
    if (!trimmed) {
      return;
    }
    setNotice(null);
    onInvite(trimmed, (message) => {
      setIdentifier("");
      setNotice(message);
    });
  }

  function handleCopyCode() {
    void navigator.clipboard
      .writeText(formatFriendCode(friendCode))
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // Clipboard access can be denied; the code is still visible to copy
        // by hand, so silently doing nothing beats an error state here.
      });
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className={SECTION_HEADING_CLASS}>Your friend code</h2>
        <div className={`${CARD_CLASS} mt-2 flex items-center justify-between gap-3`}>
          <p
            data-testid="gym-friend-code"
            className="font-mono text-lg font-bold tracking-[0.12em] text-[var(--color-ink)]"
          >
            {formatFriendCode(friendCode)}
          </p>
          <button
            type="button"
            onClick={handleCopyCode}
            className={`${SECONDARY_BUTTON_CLASS} shrink-0`}
            aria-label="Copy your friend code"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Share this instead of your email — anyone with it can send you a
          buddy invite.
        </p>
      </section>

      <section>
        <h2 className={SECTION_HEADING_CLASS}>Invite a buddy</h2>
        <form onSubmit={handleInvite} className="mt-2 flex gap-2">
          <input
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            placeholder="their@email.com or AB23-CD45"
            aria-label="Buddy email address or friend code"
            className={TEXT_INPUT_CLASS}
          />
          <button
            type="submit"
            disabled={isPending || identifier.trim().length === 0}
            className={`${PRIMARY_BUTTON_CLASS} shrink-0`}
          >
            Invite
          </button>
        </form>
        {notice ? (
          <p className="mt-2 text-sm text-[var(--color-success)]" role="status">
            {notice}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Buddies see each other&rsquo;s gym times and statuses — never slot
          descriptions.
        </p>
      </section>

      {lists.pendingIncoming.length > 0 ? (
        <section>
          <h2 className={SECTION_HEADING_CLASS}>Invites for you</h2>
          <div className="mt-2 space-y-2">
            {lists.pendingIncoming.map((invite) => (
              <div
                key={invite.id}
                className={`${CARD_CLASS} flex items-center justify-between gap-3`}
              >
                <p className="min-w-0 truncate text-sm font-semibold text-[var(--color-ink)]">
                  {invite.user.name}
                </p>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => onRespond(invite.id, true)}
                    disabled={isPending}
                    className={PRIMARY_BUTTON_CLASS}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    onClick={() => onRespond(invite.id, false)}
                    disabled={isPending}
                    className={SECONDARY_BUTTON_CLASS}
                    title="They won't be able to invite you again"
                  >
                    Decline
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <h2 className={SECTION_HEADING_CLASS}>Your buddies</h2>
        <div className="mt-2 space-y-2">
          {lists.accepted.length === 0 ? (
            <div className={EMPTY_STATE_CLASS}>
              No gym buddies yet — invite someone above.
            </div>
          ) : (
            lists.accepted.map((buddy) => (
              <div
                key={buddy.id}
                className={`${CARD_CLASS} flex items-center justify-between gap-3`}
              >
                <p className="min-w-0 truncate text-sm font-semibold text-[var(--color-ink)]">
                  {buddy.user.name}
                </p>
                <ConfirmDeleteButton
                  onConfirm={() => onRemove(buddy.id)}
                  ariaLabel={`Remove ${buddy.user.name}`}
                  disabled={isPending}
                >
                  <TrashIcon />
                </ConfirmDeleteButton>
              </div>
            ))
          )}
        </div>
      </section>

      {lists.pendingOutgoing.length > 0 ? (
        <section>
          <h2 className={SECTION_HEADING_CLASS}>Sent invites</h2>
          <div className="mt-2 space-y-2">
            {lists.pendingOutgoing.map((invite) => (
              <div
                key={invite.id}
                className={`${CARD_CLASS} flex items-center justify-between gap-3`}
              >
                <p className="min-w-0 truncate text-sm text-[var(--color-muted-strong)]">
                  {formatFriendCode(invite.identifier)}
                </p>
                <ConfirmDeleteButton
                  onConfirm={() => onRemove(invite.id)}
                  ariaLabel={`Cancel invite to ${formatFriendCode(invite.identifier)}`}
                  disabled={isPending}
                >
                  <TrashIcon />
                </ConfirmDeleteButton>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {lists.declined.length > 0 ? (
        <section>
          <button
            type="button"
            onClick={() => setShowDeclined((value) => !value)}
            className={`${SECTION_HEADING_CLASS} flex items-center gap-1`}
            aria-expanded={showDeclined}
          >
            Declined
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={showDeclined ? "rotate-180 transition" : "transition"}
            >
              <path d="M3 5l3 3 3-3" />
            </svg>
          </button>
          {showDeclined ? (
            <div className="mt-2 space-y-2">
              {lists.declined.map((entry) => (
                <div
                  key={entry.id}
                  className={`${CARD_CLASS} flex items-center justify-between gap-3`}
                >
                  <p className="min-w-0 truncate text-sm text-[var(--color-muted-strong)]">
                    {entry.user.name}
                  </p>
                  <ConfirmDeleteButton
                    onConfirm={() => onRemove(entry.id)}
                    ariaLabel={`Unblock ${entry.user.name}`}
                    title="Lets them invite you again"
                    disabled={isPending}
                  >
                    <svg width="15" height="15" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="9" cy="9" r="6.5" />
                      <path d="M6.5 9h5" />
                    </svg>
                  </ConfirmDeleteButton>
                </div>
              ))}
              <p className="text-xs text-[var(--color-muted)]">
                People you declined can&rsquo;t invite you again unless you
                remove them from this list.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

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

function GymSlotFormModal({
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
          {mode === "edit" ? (
            <p className="mt-1 text-xs text-[var(--color-muted)]">
              A slot&rsquo;s repeat kind can&rsquo;t change after creation.
            </p>
          ) : null}
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

        {/*
          iOS Safari gives date/time inputs a large intrinsic minimum width
          that a 1fr grid track cannot shrink (grid items default to
          min-width auto), so the "Until" field overflowed the modal on
          phones. `min-w-0` on both the grid items and the inputs plus
          `appearance-none` (so WebKit respects the width at all) keeps the
          pair inside the form.
        */}
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
