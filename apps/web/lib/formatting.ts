import { addDays, format, parseISO, subDays } from "date-fns";

// Re-exported so display code keeps importing formatting helpers from one place.
export { formatMacroValue } from "./numbers";

export function formatSelectedDate(value: string) {
  return format(parseISO(value), "EEEE, d MMMM");
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
