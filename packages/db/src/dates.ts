import { addDays, format, isValid, parseISO, subDays } from "date-fns";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function toDateString(value: Date) {
  return format(value, "yyyy-MM-dd");
}

export function todayDateString(now = new Date()) {
  return toDateString(now);
}

export function isValidDateString(value: string) {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }

  return isValid(parseISO(value));
}

export function ensureDateString(
  value: string | null | undefined,
  fallback = todayDateString(),
) {
  if (!value) {
    return fallback;
  }

  return isValidDateString(value) ? value : fallback;
}

export function previousDateString(value: string) {
  return toDateString(subDays(parseISO(value), 1));
}

export function nextDateString(value: string) {
  return toDateString(addDays(parseISO(value), 1));
}
