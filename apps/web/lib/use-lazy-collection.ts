"use client";

import { useRef, useState } from "react";

export function useLazyCollection<T>(
  loadItems: () => Promise<T[]>,
  fallbackError: string,
) {
  const [items, setItems] = useState<T[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const inFlightRef = useRef<Promise<void> | null>(null);

  function ensureLoaded() {
    if (loadedRef.current) {
      return;
    }

    if (inFlightRef.current) {
      return inFlightRef.current;
    }

    setLoading(true);
    setError(null);
    const inFlight = loadItems()
      .then((loadedItems) => {
        setItems(loadedItems);
        loadedRef.current = true;
        setLoaded(true);
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : fallbackError);
      })
      .finally(() => {
        inFlightRef.current = null;
        setLoading(false);
      });
    inFlightRef.current = inFlight;
    return inFlight;
  }

  return { items, setItems, loaded, loading, error, ensureLoaded };
}
