"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  type AppWarmupCacheKey,
  type AppWarmupPayload,
} from "@/lib/app-warmup";

const CACHE_INVALIDATION_EVENT = "macro-tracker-app-cache-invalidate";

type CacheStatus = "idle" | "warming" | "ready" | "error";

type AppDataCacheContextValue = {
  payload: AppWarmupPayload | null;
  status: CacheStatus;
  staleKeys: ReadonlySet<AppWarmupCacheKey>;
  warmup: (selectedDate: string) => Promise<void>;
  invalidate: (keys: AppWarmupCacheKey[]) => void;
};

const AppDataCacheContext = createContext<AppDataCacheContextValue | null>(null);

export function invalidateAppDataCache(keys: AppWarmupCacheKey[]) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<AppWarmupCacheKey[]>(CACHE_INVALIDATION_EVENT, {
      detail: keys,
    }),
  );
}

export function AppDataCacheProvider({ children }: { children: ReactNode }) {
  const [payload, setPayload] = useState<AppWarmupPayload | null>(null);
  const [status, setStatus] = useState<CacheStatus>("idle");
  const [staleKeys, setStaleKeys] = useState<Set<AppWarmupCacheKey>>(
    () => new Set(),
  );
  const [warmedDates, setWarmedDates] = useState<Set<string>>(() => new Set());

  const invalidate = useCallback((keys: AppWarmupCacheKey[]) => {
    if (keys.length === 0) {
      return;
    }

    setStaleKeys((current) => new Set([...current, ...keys]));
  }, []);

  const warmup = useCallback(
    async (selectedDate: string) => {
      if (warmedDates.has(selectedDate)) {
        return;
      }

      setStatus("warming");

      try {
        const response = await fetch(
          `/api/app/warmup?date=${encodeURIComponent(selectedDate)}`,
          {
            credentials: "same-origin",
            headers: {
              Accept: "application/json",
            },
          },
        );

        if (!response.ok) {
          throw new Error(`Warmup failed with ${response.status}`);
        }

        const nextPayload = (await response.json()) as AppWarmupPayload;
        setPayload(nextPayload);
        setWarmedDates((current) => new Set([...current, selectedDate]));
        setStaleKeys(new Set());
        setStatus("ready");
      } catch {
        setStatus("error");
      }
    },
    [warmedDates],
  );

  useEffect(() => {
    function handleInvalidation(event: Event) {
      const keys = (event as CustomEvent<AppWarmupCacheKey[]>).detail ?? [];
      invalidate(keys);
    }

    window.addEventListener(CACHE_INVALIDATION_EVENT, handleInvalidation);
    return () => {
      window.removeEventListener(CACHE_INVALIDATION_EVENT, handleInvalidation);
    };
  }, [invalidate]);

  const value = useMemo<AppDataCacheContextValue>(
    () => ({
      payload,
      status,
      staleKeys,
      warmup,
      invalidate,
    }),
    [invalidate, payload, staleKeys, status, warmup],
  );

  return (
    <AppDataCacheContext.Provider value={value}>
      {children}
    </AppDataCacheContext.Provider>
  );
}

export function useAppDataCache() {
  const context = useContext(AppDataCacheContext);
  if (!context) {
    throw new Error("useAppDataCache must be used inside AppDataCacheProvider.");
  }

  return context;
}

export function useWarmAppData(selectedDate: string, enabled = true) {
  const { warmup } = useAppDataCache();

  useEffect(() => {
    if (!enabled) {
      return;
    }

    void warmup(selectedDate);
  }, [enabled, selectedDate, warmup]);
}
