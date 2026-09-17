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

// Next control-flow throws (redirect/notFound) must keep propagating; anything
// else rejected before the server responds is a transport failure.
function isFrameworkControlFlowError(error: unknown) {
  return (
    error instanceof Error &&
    typeof (error as Error & { digest?: unknown }).digest === "string" &&
    (((error as Error & { digest: string }).digest.startsWith("NEXT_REDIRECT") ||
      (error as Error & { digest: string }).digest.startsWith("NEXT_NOT_FOUND")))
  );
}

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
      let result: T;
      try {
        result = await action();
      } catch (error) {
        if (isFrameworkControlFlowError(error)) {
          throw error;
        }
        setError(options.fallbackError);
        options.onError?.();
        return;
      }

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
