import { type AppWarmupCacheKey } from "@/lib/app-warmup";
import { resetFullRoutePrefetchCache } from "@/lib/full-prefetch";

const CACHE_INVALIDATION_EVENT = "macro-tracker-app-cache-invalidate";

export function invalidateAppDataCache(keys: AppWarmupCacheKey[]) {
  if (typeof window === "undefined") {
    return;
  }

  resetFullRoutePrefetchCache();
  window.dispatchEvent(
    new CustomEvent<AppWarmupCacheKey[]>(CACHE_INVALIDATION_EVENT, {
      detail: keys,
    }),
  );
}
