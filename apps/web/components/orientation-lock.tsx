"use client";

import { useEffect } from "react";

/**
 * Attempts to lock the screen orientation to portrait when the app is running
 * as an installed PWA (standalone/fullscreen). Has no effect in regular browser
 * tabs because the Screen Orientation API requires a fullscreen context there.
 */
// `lock` is defined in the Screen Orientation API spec but is absent from
// TypeScript's built-in ScreenOrientation type.
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: string) => Promise<void>;
};

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
