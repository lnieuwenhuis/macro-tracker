import { format } from "date-fns";

type StartupDateRedirectInput = {
  requestedDate: string | null;
  selectedDate: string;
  localDate: string;
};

export function getLocalDateString(now = new Date()) {
  return format(now, "yyyy-MM-dd");
}

export function getStartupDateRedirect({
  requestedDate,
  selectedDate,
  localDate,
}: StartupDateRedirectInput) {
  if (requestedDate === selectedDate) {
    return null;
  }

  if (requestedDate === null && selectedDate === localDate) {
    return null;
  }

  return localDate;
}
