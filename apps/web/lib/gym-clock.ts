"use client";

import { useSyncExternalStore } from "react";

// The tense-aware skip label needs a clock, but the label may NEVER be
// derived from `new Date()` during render: the server (UTC) and the device
// disagree for hours every day, which is a guaranteed hydration mismatch.
// SSR/hydration render from `getServerSnapshot` (null → neutral past form);
// after mount a minute tick (re-fired when the tab becomes visible again)
// keeps a long-mounted screen honest.
function subscribeToMinuteClock(notify: () => void) {
  const interval = window.setInterval(notify, 60_000);
  const onVisible = () => notify();
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(interval);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

function getNowMinute() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

function getServerNowMinute(): number | null {
  return null;
}

/** Current minute-of-day on the client; `null` during SSR and hydration. */
export function useGymNowMinute() {
  return useSyncExternalStore(
    subscribeToMinuteClock,
    getNowMinute,
    getServerNowMinute,
  );
}
