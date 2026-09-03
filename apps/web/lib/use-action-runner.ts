"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type ActionResult = {
  ok: boolean;
  error?: string;
};

type RunOptions<T extends ActionResult> = {
  fallbackError: string;
  refresh?: boolean;
  clearErrorFirst?: boolean;
  onSuccess?: (result: T) => void;
  onError?: () => void;
};

export function useActionRunner() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run<T extends ActionResult>(
    action: () => Promise<T>,
    options: RunOptions<T>,
  ) {
    if (options.clearErrorFirst !== false) {
      setError(null);
    }

    startTransition(async () => {
      const result = await action();

      if (!result.ok) {
        setError(result.error ?? options.fallbackError);
        options.onError?.();
        return;
      }

      options.onSuccess?.(result);

      if (options.refresh) {
        router.refresh();
      }
    });
  }

  return {
    run,
    isPending,
    error,
    setError,
    clearError: () => setError(null),
  };
}
