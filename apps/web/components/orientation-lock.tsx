"use client";

import { useEffect } from "react";

/**
 * Attempts to lock the screen orientation to portrait when the app is running
 * as an installed PWA (standalone/fullscreen). Has no effect in regular browser
 * tabs because the Screen Orientation API requires a fullscreen context there.
 */
export function OrientationLock() {
  useEffect(() => {
    if (
      typeof screen !== "undefined" &&
      typeof screen.orientation?.lock === "function"
    ) {
      screen.orientation.lock("portrait").catch(() => {
        // Silently ignored — locking only works in PWA standalone/fullscreen mode
      });
    }
  }, []);

  return null;
}
