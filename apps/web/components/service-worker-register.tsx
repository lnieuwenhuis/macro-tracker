"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        registrations.forEach((registration) => {
          void registration.unregister();
        });
      });

      caches.keys().then((cacheNames) => {
        cacheNames.forEach((cacheName) => {
          void caches.delete(cacheName);
        });
      });

      return;
    }

    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Ignore service worker registration failures in unsupported contexts.
    });
  }, []);

  return null;
}
