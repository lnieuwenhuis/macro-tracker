"use client";

import { useSyncExternalStore } from "react";

function subscribe(notify: () => void) {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
}

function getSnapshot() {
  return navigator.onLine;
}

function getServerSnapshot() {
  // Assume online on the server — the banner only ever appears after
  // hydration if the client actually reports offline.
  return true;
}

export function OfflineBanner() {
  const isOnline = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (isOnline) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-2 border-b border-[var(--color-accent)]/40 bg-[var(--color-accent)]/15 px-4 py-2 text-xs font-semibold text-[var(--color-accent-strong)] backdrop-blur"
      style={{ paddingTop: "calc(0.5rem + env(safe-area-inset-top))" }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <line x1="1" y1="1" x2="23" y2="23" />
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
        <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
        <line x1="12" y1="20" x2="12.01" y2="20" />
      </svg>
      <span>You&rsquo;re offline — changes may not be saved.</span>
    </div>
  );
}
