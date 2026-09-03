// Warms a lazily-imported chunk once the browser goes idle, so opening it later never waits on a network round trip.
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
