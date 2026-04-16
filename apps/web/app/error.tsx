"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to console so developers can see what went wrong. Production
    // telemetry, if/when wired up, can hook in here too.
    console.error(error);
  }, [error]);

  const isDev = process.env.NODE_ENV !== "production";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[var(--color-app-bg)] px-4 py-16 text-[var(--color-ink)]">
      <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-6 text-center shadow-sm">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-danger)]/10 text-[var(--color-danger)]">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>
        <h2 className="font-serif text-xl font-semibold text-[var(--color-ink)]">
          Something went wrong
        </h2>
        <p className="text-sm text-[var(--color-muted)]">
          We hit an unexpected error. You can try again, or head back to the
          home screen.
        </p>
        {isDev && error.message ? (
          <pre className="max-h-48 w-full overflow-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-card-muted)] p-3 text-left text-xs text-[var(--color-muted-strong)]">
            {error.message}
          </pre>
        ) : null}
        <div className="flex w-full flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={reset}
            className="flex-1 rounded-full bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5"
          >
            Try again
          </button>
          <Link
            href="/"
            className="flex-1 rounded-full border border-[var(--color-border-strong)] px-4 py-2 text-sm font-semibold text-[var(--color-muted-strong)] transition hover:text-[var(--color-ink)]"
          >
            Back to home
          </Link>
        </div>
      </div>
    </main>
  );
}
