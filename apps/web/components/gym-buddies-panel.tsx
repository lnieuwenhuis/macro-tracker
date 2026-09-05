"use client";

import { type FormEvent, useState } from "react";

import type { GymPageData } from "@macro-tracker/db";
import { formatFriendCode } from "@/lib/gym-time";

import { ConfirmDeleteButton } from "./confirm-delete-button";
import {
  CARD_CLASS,
  EMPTY_STATE_CLASS,
  PRIMARY_BUTTON_CLASS,
  SECONDARY_BUTTON_CLASS,
  SECTION_HEADING_CLASS,
  TEXT_INPUT_CLASS,
  TrashIcon,
} from "./gym-ui";

type BuddiesPanelProps = {
  lists: GymPageData["buddies"];
  friendCode: string;
  isPending: boolean;
  onInvite: (identifier: string, done: (message: string) => void) => void;
  onRespond: (buddyId: string, accept: boolean) => void;
  onRemove: (buddyId: string) => void;
};

export function BuddiesPanel({
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
        // Clipboard access can be denied; the code stays on screen to copy by hand.
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
