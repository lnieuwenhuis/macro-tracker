"use client";

import { useEffect, useRef, useState } from "react";

export function useCopiedFlash(delayMs: number) {
  const [copiedIds, setCopiedIds] = useState<Set<string>>(new Set());
  const timersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  function flash(id: string) {
    setCopiedIds((prev) => new Set([...prev, id]));
    const existingTimer = timersRef.current.get(id);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }
    timersRef.current.set(
      id,
      window.setTimeout(() => {
        timersRef.current.delete(id);
        setCopiedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }, delayMs),
    );
  }

  return { copiedIds, setCopiedIds, flash };
}
