import { cookies } from "next/headers";

import { getLocalDateString } from "./startup-date";
import {
  TIMEZONE_COOKIE_NAME,
  dateStringInTimeZone,
  normalizeTimeZone,
} from "./timezone";

/** The requesting browser's IANA zone, or null before the cookie is set (first request, or cookies disabled). */
export async function getRequestTimeZone() {
  const cookieStore = await cookies();

  return normalizeTimeZone(cookieStore.get(TIMEZONE_COOKIE_NAME)?.value);
}

/** The user's calendar day; falls back to the server's own day until the client shell corrects it post-hydration. */
export async function getRequestToday(now = new Date()) {
  const timeZone = await getRequestTimeZone();

  return timeZone ? dateStringInTimeZone(timeZone, now) : getLocalDateString(now);
}

function getCookieValue(cookieHeader: string | null, name: string) {
  if (!cookieHeader) {
    return null;
  }

  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) {
      continue;
    }
    if (part.slice(0, index).trim() !== name) {
      continue;
    }
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  return null;
}

// Layout-safe variant: the root layout already awaits headers() for the CSP
// nonce, so it reads the already-fetched Headers instead of adding a
// cookies() dependency. Invalid values fall back the same way.
export function getRequestTodayFromHeaders(headers: Headers, now = new Date()) {
  const timeZone = normalizeTimeZone(
    getCookieValue(headers.get("cookie"), TIMEZONE_COOKIE_NAME),
  );

  return timeZone ? dateStringInTimeZone(timeZone, now) : getLocalDateString(now);
}
