import { cookies } from "next/headers";

import { getLocalDateString } from "./startup-date";
import {
  TIMEZONE_COOKIE_NAME,
  dateStringInTimeZone,
  normalizeTimeZone,
} from "./timezone";

/**
 * The requesting browser's IANA zone, or `null` before the cookie is set (the
 * very first HTML request of a session, or a client with cookies disabled).
 */
export async function getRequestTimeZone() {
  const cookieStore = await cookies();

  return normalizeTimeZone(cookieStore.get(TIMEZONE_COOKIE_NAME)?.value);
}

/**
 * The calendar day the user is currently in. Falls back to the server's own
 * day only when the browser zone is not known yet; the client shell corrects
 * that case after hydration.
 */
export async function getRequestToday(now = new Date()) {
  const timeZone = await getRequestTimeZone();

  return timeZone ? dateStringInTimeZone(timeZone, now) : getLocalDateString(now);
}
