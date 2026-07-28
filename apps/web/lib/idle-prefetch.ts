/**
 * Warm lazily-imported chunks once the browser goes idle.
 *
 * Modal code is deliberately kept out of the initial bundle, but a user who
 * opens one should never wait on a network round trip. Fetching the chunks
 * shortly after hydration keeps the smaller first load without changing how
 * the UI behaves when it is actually used.
 *
 * Returns a cleanup function suitable for returning straight from `useEffect`.
 */
export function prefetchOnIdle(load: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(load, { timeout: 3000 });
    return () => window.cancelIdleCallback?.(handle);
  }

  const handle = window.setTimeout(load, 1500);
  return () => window.clearTimeout(handle);
}
