import { addDays, format, parseISO, subDays } from "date-fns";

// Re-exported so display code keeps importing formatting helpers from one place.
export { formatMacroValue } from "./numbers";

export function formatSelectedDate(value: string) {
  // Short form: the date pill has a round button on both sides, and the long form no longer fits at 375px.
  return format(parseISO(value), "EEE, d MMM");
}

// Owns gym time's one special case: minute 1440 ("until midnight") renders as "00:00", never "24:00".
export function formatMinutesAsTime(minute: number) {
  const normalized = minute === 1440 ? 0 : minute;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function formatShortDate(value: string) {
  return format(parseISO(value), "d MMM");
}

export function formatPeriodRange(startDate: string, endDate: string) {
  return `${formatShortDate(startDate)} to ${formatShortDate(endDate)}`;
}

export function previousDateString(value: string) {
  return format(subDays(parseISO(value), 1), "yyyy-MM-dd");
}

export function nextDateString(value: string) {
  return format(addDays(parseISO(value), 1), "yyyy-MM-dd");
}
