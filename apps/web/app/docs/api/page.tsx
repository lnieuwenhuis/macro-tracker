import type { Metadata } from "next";
import { API_SCOPE_VALUES } from "@macro-tracker/db";

import { API_V1_ENDPOINTS, formatApiV1ScopeSummary } from "@/lib/api-v1-openapi";

export const metadata: Metadata = {
  title: "API Docs | Macro Tracker",
};

const endpointGroups = [
  "Account and goals",
  "Daily logs",
  "Foods and barcodes",
  "Templates",
  "Recipes",
  "Weight and stats",
];

export default function ApiDocsPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-8 text-[var(--color-ink)] sm:px-8">
      <header className="space-y-3">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
          Docs
        </p>
        <h1 className="font-serif text-3xl font-semibold">
          Macro Tracker API v1
        </h1>
        <p className="max-w-2xl text-sm text-[var(--color-muted)]">
          Use personal access tokens to read and write normal user-owned Macro Tracker data.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl font-semibold">Authentication</h2>
        <pre className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4 text-sm">
          <code>{`curl /api/v1/goals \\
  -H "Authorization: Bearer mtk_v1_your_token"`}</code>
        </pre>
        <p className="text-sm text-[var(--color-muted)]">
          API responses are wrapped as {"{"} ok, data {"}"} or {"{"} ok, error {"}"}. Dates use YYYY-MM-DD.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl font-semibold">Scopes</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {API_SCOPE_VALUES.map((scope) => (
            <code
              key={scope}
              className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-3 py-2 text-sm"
            >
              {scope}
            </code>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl font-semibold">Endpoint Groups</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {endpointGroups.map((group) => (
            <div
              key={group}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-strong)] px-4 py-3 text-sm font-semibold"
            >
              {group}
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl font-semibold">Endpoints</h2>
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
          <table className="min-w-full border-collapse text-sm">
            <thead className="bg-[var(--color-card-muted)] text-left">
              <tr>
                <th className="px-4 py-3 font-semibold">Method</th>
                <th className="px-4 py-3 font-semibold">Path</th>
                <th className="px-4 py-3 font-semibold">Scopes</th>
              </tr>
            </thead>
            <tbody>
              {API_V1_ENDPOINTS.flatMap((endpoint) =>
                endpoint.methods.map((method) => (
                  <tr
                    key={`${method.method}:${endpoint.path}`}
                    className="border-t border-[var(--color-border)]"
                  >
                    <td className="px-4 py-3 font-mono uppercase">
                      {method.method}
                    </td>
                    <td className="px-4 py-3 font-mono">{endpoint.path}</td>
                    <td className="px-4 py-3 text-[var(--color-muted)]">
                      {formatApiV1ScopeSummary(method)}
                    </td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-[var(--color-muted)]">
          OpenAPI JSON is available at /api/v1/openapi.json.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="font-serif text-2xl font-semibold">Example Request</h2>
        <pre className="overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4 text-sm">
          <code>{`curl -X POST /api/v1/days/2026-03-19/entries \\
  -H "Authorization: Bearer mtk_v1_your_token" \\
  -H "Content-Type: application/json" \\
  -d '{
    "label": "Greek yogurt",
    "proteinG": 20,
    "carbsG": 8,
    "fatG": 0,
    "caloriesKcal": 118
  }'`}</code>
        </pre>
      </section>
    </main>
  );
}
