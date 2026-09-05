"use client";

import { useEffect } from "react";

type LockableOrientation = ScreenOrientation & {
  // `lock` is in the Screen Orientation API spec but absent from TypeScript's built-in type.
  lock?: (orientation: string) => Promise<void>;
};

// Locks orientation to portrait only inside an installed PWA; the Screen Orientation API needs a fullscreen context.
export function OrientationLock() {
  useEffect(() => {
    const orientation =
      typeof screen !== "undefined"
        ? (screen.orientation as LockableOrientation)
        : undefined;
    if (typeof orientation?.lock === "function") {
      orientation.lock("portrait").catch(() => {
        // Silently ignored — locking only works in PWA standalone/fullscreen mode
      });
    }
  }, []);

  return null;
}
