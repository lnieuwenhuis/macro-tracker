import type { GymSlotStatus } from "@macro-tracker/db";

/**
 * Converts a `<input type="time">` value ("HH:MM") to minutes since midnight.
 * An END input of "00:00" means "until midnight" and maps to 1440 so a plain
 * 23:00-00:00 slot stays representable; a START of "00:00" is minute 0.
 */
export function timeInputToMinutes(value: string, role: "start" | "end") {
  const [hours = "0", minutes = "0"] = value.split(":");
  const total = Number(hours) * 60 + Number(minutes);
  if (role === "end" && total === 0) {
    return 1440;
  }
  return total;
}

/**
 * Friend codes are stored as 8 bare characters; display them as "AB23-CD45"
 * for readability. Anything unexpected (old data, emails) passes through.
 */
export function formatFriendCode(code: string) {
  if (/^[A-Z0-9]{8}$/.test(code)) {
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }
  return code;
}

/** The inverse mapping for populating a time input (1440 renders as 00:00). */
export function minutesToTimeInput(minute: number) {
  const normalized = minute === 1440 ? 0 : minute;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * The tense-aware status label (user requirement: a skip reads "Skipping"
 * before the slot's time and "Skipped" after).
 *
 * `nowMinute` is the current minute-of-day when `date` is today, `null` when
 * the tense cannot be known yet — during SSR/hydration the caller passes
 * `null` and this returns the neutral past form, so the server and hydration
 * renders can never disagree with the client clock (a real hydration-mismatch
 * bug this contract exists to prevent). The day-level comparison uses
 * `todayStr`, which the server resolved in the user's timezone-cookie zone.
 */
export function gymStatusLabel(
  status: GymSlotStatus,
  input: {
    date: string;
    todayStr: string;
    endMinute: number;
    nowMinute: number | null;
  },
) {
  if (status !== "skipped") {
    return status === "going" ? "Going" : status === "maybe" ? "Maybe" : "Done";
  }
  const { date, todayStr, endMinute, nowMinute } = input;
  if (date < todayStr) {
    return "Skipped";
  }
  if (date > todayStr) {
    return "Skipping";
  }
  if (nowMinute === null) {
    return "Skipped";
  }
  return nowMinute < endMinute ? "Skipping" : "Skipped";
}
