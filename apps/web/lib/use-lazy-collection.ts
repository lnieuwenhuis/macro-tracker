"use client";

import { useRef, useState } from "react";

import { createLazyCollectionLoader } from "./lazy-collection";

export function useLazyCollection<T>(
  loadItems: () => Promise<T[]>,
  fallbackError: string,
) {
  const [items, setItems] = useState<T[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loaderRef = useRef<ReturnType<typeof createLazyCollectionLoader<T[]>> | null>(null);
  loaderRef.current ??= createLazyCollectionLoader(loadItems);
  const loader = loaderRef.current;

  async function ensureLoaded() {
    if (loaded || loading) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const loadedItems = await loader.load();
      setItems(loadedItems);
      setLoaded(true);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : fallbackError);
    }
    setLoading(false);
  }

  return { items, setItems, loaded, loading, error, ensureLoaded };
}
