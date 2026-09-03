import type { GymSlotStatus } from "@macro-tracker/db";

import { formatMinutesAsTime } from "./formatting";

const END_OF_DAY_MINUTE = 1440;
const BARE_FRIEND_CODE = /^[A-Z0-9]{8}$/;

// An END input of "00:00" means "until midnight" (a plain 23:00-00:00 slot).
export function timeInputToMinutes(value: string, role: "start" | "end") {
  const [hours = "0", minutes = "0"] = value.split(":");
  const total = Number(hours) * 60 + Number(minutes);
  if (role === "end" && total === 0) {
    return END_OF_DAY_MINUTE;
  }
  return total;
}

export function formatFriendCode(code: string) {
  if (BARE_FRIEND_CODE.test(code)) {
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  }
  return code;
}

export function minutesToTimeInput(minute: number) {
  return formatMinutesAsTime(minute);
}

// `nowMinute` is null during SSR/hydration so server and client never disagree on a skip's tense.
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
