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
