import { addDays, format, parseISO, subDays } from "date-fns";

export function formatSelectedDate(value: string) {
  return format(parseISO(value), "EEEE, d MMMM");
}

export function formatShortDate(value: string) {
  return format(parseISO(value), "d MMM");
}

export function formatMacroValue(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
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
