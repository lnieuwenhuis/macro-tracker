export type ScreenMotion =
  | "none"
  | "intro"
  | "screen"
  | "screen-forward"
  | "screen-backward"
  | "day-forward"
  | "day-backward"
  | "day-jump";

type PendingNavigation = {
  pathname: string;
  selectedDate: string | null;
  motion: Exclude<ScreenMotion, "none" | "intro">;
};

let currentSignature: string | null = null;
let pendingNavigation: PendingNavigation | null = null;

function parseHref(href: string) {
  const url = new URL(href, "https://macro-tracker.local");

  return {
    pathname: url.pathname,
    selectedDate: url.searchParams.get("date"),
  };
}

function matchesPendingNavigation(
  pathname: string,
  selectedDate: string,
  pending: PendingNavigation | null,
) {
  return (
    pending !== null &&
    pending.pathname === pathname &&
    (pending.selectedDate === null || pending.selectedDate === selectedDate)
  );
}

export function getScreenSignature(pathname: string, selectedDate: string) {
  return `${pathname}?date=${selectedDate}`;
}

export function prepareNavigationMotion(
  href: string,
  motion: Exclude<ScreenMotion, "none" | "intro">,
) {
  pendingNavigation = {
    ...parseHref(href),
    motion,
  };
}

export function resolveNavigationMotion(pathname: string, selectedDate: string): ScreenMotion {
  if (matchesPendingNavigation(pathname, selectedDate, pendingNavigation)) {
    return pendingNavigation!.motion;
  }

  if (currentSignature === null) {
    return "intro";
  }

  return currentSignature === getScreenSignature(pathname, selectedDate)
    ? "none"
    : "screen";
}

export function markNavigationRendered(pathname: string, selectedDate: string) {
  currentSignature = getScreenSignature(pathname, selectedDate);

  if (matchesPendingNavigation(pathname, selectedDate, pendingNavigation)) {
    pendingNavigation = null;
  }
}

export function resetNavigationMotionState() {
  currentSignature = null;
  pendingNavigation = null;
}
