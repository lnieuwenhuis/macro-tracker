"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import type { ComposeAction } from "@/lib/compose";
import { getLocalDateString } from "@/lib/startup-date";
import { prepareNavigationMotion } from "@/lib/navigation-motion";
import { getWarmupRoutes } from "@/lib/app-warmup";
import { prefetchFullRoute } from "@/lib/full-prefetch";
import { useUiMode } from "@/lib/ui-mode-client";

import { useWarmAppData } from "./app-data-cache";
import { ExperimentalAddSheet } from "./experimental-add-sheet";
import { ExperimentalBottomNav } from "./experimental-bottom-nav";

const APP_PATHNAMES = ["/", "/progress", "/recipes", "/summary", "/goals", "/weight", "/stats"];

function isAppPathname(pathname: string) {
  return APP_PATHNAMES.some(
    (p) => pathname === p || (p !== "/" && pathname.startsWith(p + "/")),
  );
}

function pathnameToActiveTab(
  pathname: string,
): "log" | "progress" | "recipes" | "summary" {
  if (pathname.startsWith("/progress")) return "progress";
  if (pathname.startsWith("/recipes")) return "recipes";
  if (pathname.startsWith("/summary")) return "summary";
  return "log";
}

export function ExperimentalLayoutNav() {
  const uiMode = useUiMode();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [, startNavigation] = useTransition();
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const selectedDate = searchParams.get("date") ?? getLocalDateString();
  const warmupEnabled = uiMode === "experimental" && isAppPathname(pathname);
  useWarmAppData(selectedDate, warmupEnabled);

  useEffect(() => {
    if (!warmupEnabled) {
      return;
    }

    for (const href of getWarmupRoutes(selectedDate)) {
      prefetchFullRoute(router, href);
    }
  }, [router, selectedDate, warmupEnabled]);

  if (!warmupEnabled) {
    return null;
  }

  const activeTab = pathnameToActiveTab(pathname);

  function handleAddSelection(action: ComposeAction) {
    setAddSheetOpen(false);

    if (pathname === "/") {
      // On the log page: delegate to the dashboard shell via custom event
      window.dispatchEvent(new CustomEvent("macro-tracker-add", { detail: action }));
      return;
    }

    // On other pages: navigate to the log page with the compose action
    const href = `/?date=${selectedDate}&compose=${action}`;
    prepareNavigationMotion(href, "screen-backward");
    startNavigation(() => {
      router.push(href);
    });
  }

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-3xl">
          <ExperimentalBottomNav
            activeTab={activeTab}
            selectedDate={selectedDate}
            onAdd={() => setAddSheetOpen(true)}
          />
        </div>
      </div>

      <ExperimentalAddSheet
        open={addSheetOpen}
        onClose={() => setAddSheetOpen(false)}
        onSelect={handleAddSelection}
      />
    </>
  );
}
