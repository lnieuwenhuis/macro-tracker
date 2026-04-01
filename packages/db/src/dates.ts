import {
  addDays,
  endOfISOWeek,
  endOfMonth,
  format,
  isValid,
  parseISO,
  startOfISOWeek,
  startOfMonth,
  subDays,
} from "date-fns";

import type { PeriodAverageLabel } from "./types";

export type DateRange = {
  startDate: string;
  endDate: string;
};

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

export function getIsoWeekRange(value: string): DateRange {
  const date = parseISO(value);

  return {
    startDate: toDateString(startOfISOWeek(date)),
    endDate: toDateString(endOfISOWeek(date)),
  };
}

export function getCalendarMonthRange(value: string): DateRange {
  const date = parseISO(value);

  return {
    startDate: toDateString(startOfMonth(date)),
    endDate: toDateString(endOfMonth(date)),
  };
}

export function getRollingRange(value: string, days: number): DateRange {
  const date = parseISO(value);

  return {
    startDate: toDateString(subDays(date, days - 1)),
    endDate: toDateString(date),
  };
}

export function getPeriodRanges(value: string): Record<PeriodAverageLabel, DateRange> {
  return {
    week: getIsoWeekRange(value),
    month: getCalendarMonthRange(value),
    rolling7: getRollingRange(value, 7),
    rolling30: getRollingRange(value, 30),
  };
}
