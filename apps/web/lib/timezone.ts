/**
 * Per-user timezone support.
 *
 * "Today" is a user-facing concept, so it has to be resolved in the user's own
 * IANA zone rather than the Node process zone (UTC in production). The browser
 * publishes its zone into a cookie during the initial HTML parse, which lets
 * server components and server actions resolve the same calendar day the user
 * is looking at.
 *
 * This module is isomorphic on purpose — the server helpers that read the
 * cookie live in `./server-timezone`.
 */

export const TIMEZONE_COOKIE_NAME = "mt_tz";
export const TIMEZONE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

// IANA zone names are `Area/Location` (plus a few legacy single-segment names
// like `UTC`). Bounding the shape first keeps a hostile cookie from reaching
// Intl at all.
const TIME_ZONE_PATTERN = /^[A-Za-z0-9+_-]+(?:\/[A-Za-z0-9+_-]+){0,2}$/;
const MAX_TIME_ZONE_LENGTH = 64;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(value: string | null | undefined): value is string {
  if (!value || value.length > MAX_TIME_ZONE_LENGTH || !TIME_ZONE_PATTERN.test(value)) {
    return false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(value: string | null | undefined) {
  return isValidTimeZone(value) ? value : null;
}

function getFormatter(timeZone: string) {
  const cached = formatterCache.get(timeZone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  formatterCache.set(timeZone, formatter);

  return formatter;
}

/** Calendar day (`yyyy-MM-dd`) that `instant` falls on inside `timeZone`. */
export function dateStringInTimeZone(timeZone: string, instant = new Date()) {
  const parts = getFormatter(timeZone).formatToParts(instant);
  let year = "";
  let month = "";
  let day = "";

  for (const part of parts) {
    if (part.type === "year") year = part.value;
    else if (part.type === "month") month = part.value;
    else if (part.type === "day") day = part.value;
  }

  return `${year.padStart(4, "0")}-${month}-${day}`;
}

/** The browser's IANA zone, or `null` where `Intl` cannot resolve one. */
export function resolveBrowserTimeZone() {
  try {
    return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}
