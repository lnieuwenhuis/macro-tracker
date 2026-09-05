"use client";

import { useSyncExternalStore } from "react";

// Never derive the skip label from new Date() during render (server UTC vs device clock mismatch); tick after mount.
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
