export default function Loading() {
  return (
    <main className="min-h-screen bg-[var(--color-app-bg)] text-[var(--color-ink)]">
      <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col">
        <div className="macro-loading-shell flex min-h-screen flex-col">
          <header className="px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:px-6">
            <div className="flex items-center gap-3">
              <div className="macro-loading-block h-10 w-10 rounded-xl" />
              <div className="macro-loading-block h-7 flex-1 rounded-full" />
              <div className="h-10 w-10" />
            </div>

            <div className="mt-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-shell-panel)] px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <div className="macro-loading-block h-9 w-9 rounded-xl" />
                <div className="macro-loading-block h-5 w-40 rounded-full" />
                <div className="macro-loading-block h-9 w-9 rounded-xl" />
              </div>
            </div>
          </header>

          <div className="flex-1 space-y-4 px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:px-6">
            <section className="rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5 shadow-[0_12px_32px_rgba(0,0,0,0.06)]">
              <div className="macro-loading-block h-4 w-24 rounded-full" />
              <div className="mt-4 space-y-3">
                <div className="macro-loading-block h-16 rounded-2xl" />
                <div className="macro-loading-block h-16 rounded-2xl" />
                <div className="macro-loading-block h-16 rounded-2xl" />
              </div>
            </section>

            <section className="rounded-3xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-5 shadow-[0_8px_24px_rgba(74,45,28,0.05)]">
              <div className="macro-loading-block h-4 w-28 rounded-full" />
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="macro-loading-block h-24 rounded-2xl" />
                <div className="macro-loading-block h-24 rounded-2xl" />
                <div className="macro-loading-block h-24 rounded-2xl" />
                <div className="macro-loading-block h-24 rounded-2xl" />
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
