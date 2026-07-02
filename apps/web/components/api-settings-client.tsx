"use client";

import { useActionState, useMemo, useState } from "react";

import {
  createApiTokenAction,
  revokeApiTokenAction,
  type CreateApiTokenActionState,
} from "@/lib/api-token-actions";
import type { ApiScope, ApiTokenRecord } from "@macro-tracker/db";

type ApiSettingsClientProps = {
  tokens: ApiTokenRecord[];
  scopes: ApiScope[];
};

const scopeLabels: Record<ApiScope, string> = {
  "read:account": "Read account",
  "read:daily": "Read daily logs",
  "write:daily": "Write daily logs",
  "read:foods": "Read foods",
  "write:foods": "Write foods",
  "read:templates": "Read templates",
  "write:templates": "Write templates",
  "read:recipes": "Read recipes",
  "write:recipes": "Write recipes",
  "read:weight": "Read weight",
  "write:weight": "Write weight",
  "read:goals": "Read goals",
  "write:goals": "Write goals",
  "read:stats": "Read stats",
};

const allPresetScopes = Object.keys(scopeLabels) as ApiScope[];

export const API_TOKEN_PRESETS = [
  {
    id: "read_only_dashboard",
    label: "Read-only dashboard",
    name: "Read-only dashboard",
    expires: "90",
    scopes: [
      "read:account",
      "read:daily",
      "read:foods",
      "read:templates",
      "read:recipes",
      "read:weight",
      "read:goals",
      "read:stats",
    ],
  },
  {
    id: "shortcut_logger",
    label: "Shortcut logger",
    name: "Shortcut logger",
    expires: "90",
    scopes: [
      "read:account",
      "read:daily",
      "write:daily",
      "read:foods",
      "read:templates",
      "read:recipes",
      "read:goals",
      "read:stats",
    ],
  },
  {
    id: "full_automation",
    label: "Full automation",
    name: "Full automation",
    expires: "never",
    scopes: allPresetScopes,
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  name: string;
  expires: "90" | "never";
  scopes: readonly ApiScope[];
}>;

const initialState: CreateApiTokenActionState = {};

export function getVisibleApiTokens(
  tokens: ApiTokenRecord[],
  stateRecord?: ApiTokenRecord,
) {
  if (!stateRecord) {
    return tokens;
  }
  if (tokens.some((token) => token.id === stateRecord.id)) {
    return tokens;
  }

  return [stateRecord, ...tokens];
}

function formatDate(value: string | null) {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function ApiSettingsClient({ tokens, scopes }: ApiSettingsClientProps) {
  const [state, formAction, pending] = useActionState(
    createApiTokenAction,
    initialState,
  );
  const [tokenName, setTokenName] = useState("");
  const [expires, setExpires] = useState<"90" | "never">("90");
  const [selectedScopes, setSelectedScopes] = useState<ApiScope[]>(scopes);
  const visibleTokens = useMemo(
    () => getVisibleApiTokens(tokens, state.record),
    [state.record, tokens],
  );
  const availableScopes = useMemo(() => new Set(scopes), [scopes]);

  function applyPreset(preset: (typeof API_TOKEN_PRESETS)[number]) {
    setTokenName(preset.name);
    setExpires(preset.expires);
    setSelectedScopes(
      preset.scopes.filter((scope) => availableScopes.has(scope)),
    );
  }

  function toggleScope(scope: ApiScope) {
    setSelectedScopes((current) =>
      current.includes(scope)
        ? current.filter((item) => item !== scope)
        : [...current, scope],
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-5 py-8 sm:px-8">
      <header className="space-y-2">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-[var(--color-muted-strong)]">
          Settings
        </p>
        <h1 className="font-serif text-3xl font-semibold text-[var(--color-ink)]">
          API access
        </h1>
        <p className="max-w-2xl text-sm text-[var(--color-muted)]">
          Create personal access tokens for apps that need Macro Tracker data.
        </p>
      </header>

      {state.token ? (
        <section className="rounded-lg border border-[var(--color-success)] bg-[var(--color-surface-strong)] p-4">
          <p className="text-sm font-semibold text-[var(--color-ink)]">
            New token
          </p>
          <p className="mt-2 break-all rounded-md bg-[var(--color-surface-strong)] p-3 font-mono text-sm text-[var(--color-ink)]">
            {state.token}
          </p>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            Copy this now. It will not be shown again.
          </p>
        </section>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <form
          action={formAction}
          className="space-y-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5"
        >
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
              Presets
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              {API_TOKEN_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className="rounded-md border border-[var(--color-border)] px-3 py-2 text-left text-sm font-semibold text-[var(--color-ink)] transition hover:bg-[var(--color-card-muted)]"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="token-name"
              className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]"
            >
              Token name
            </label>
            <input
              id="token-name"
              name="name"
              required
              maxLength={80}
              value={tokenName}
              onChange={(event) => setTokenName(event.target.value)}
              placeholder="iPhone shortcut"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
            />
          </div>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
              Expiry
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-ink)]">
                <input
                  type="radio"
                  name="expires"
                  value="90"
                  checked={expires === "90"}
                  onChange={() => setExpires("90")}
                />
                90 days
              </label>
              <label className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-ink)]">
                <input
                  type="radio"
                  name="expires"
                  value="never"
                  checked={expires === "never"}
                  onChange={() => setExpires("never")}
                />
                Never expires
              </label>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
              Full user API access
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {scopes.map((scope) => (
                <label
                  key={scope}
                  className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-ink)]"
                >
                  <input
                    name="scopes"
                    type="checkbox"
                    value={scope}
                    checked={selectedScopes.includes(scope)}
                    onChange={() => toggleScope(scope)}
                  />
                  {scopeLabels[scope]}
                </label>
              ))}
            </div>
          </fieldset>

          {state.ok === false ? (
            <p className="rounded-md border border-[var(--color-danger)] px-3 py-2 text-sm text-[var(--color-danger)]">
              {state.error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-60"
          >
            {pending ? "Creating..." : "Create token"}
          </button>
        </form>

        <aside className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
            Token format
          </p>
          <p className="break-all font-mono text-sm text-[var(--color-ink)]">
            mtk_v1_...
          </p>
          <p className="text-sm text-[var(--color-muted)]">
            Send it as an Authorization bearer token.
          </p>
        </aside>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="font-serif text-2xl font-semibold text-[var(--color-ink)]">
            Tokens
          </h2>
        </div>

        <div className="grid gap-3">
          {visibleTokens.length === 0 ? (
            <p className="rounded-lg border border-[var(--color-border)] p-4 text-sm text-[var(--color-muted)]">
              No API tokens yet.
            </p>
          ) : (
            visibleTokens.map((token) => (
              <article
                key={token.id}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-strong)] p-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <h3 className="truncate text-sm font-semibold text-[var(--color-ink)]">
                      {token.name}
                    </h3>
                    <p className="font-mono text-xs text-[var(--color-muted)]">
                      {token.tokenPrefix}...
                    </p>
                    <p className="text-xs text-[var(--color-muted)]">
                      Created {formatDate(token.createdAt)} | Last used {formatDate(token.lastUsedAt)} | Expires {formatDate(token.expiresAt)}
                    </p>
                    <p className="text-xs text-[var(--color-muted)]">
                      {token.scopes.join(", ")}
                    </p>
                  </div>
                  {token.revokedAt ? (
                    <span className="rounded-md border border-[var(--color-border)] px-3 py-1 text-xs font-semibold text-[var(--color-muted)]">
                      Revoked
                    </span>
                  ) : (
                    <form action={revokeApiTokenAction}>
                      <input type="hidden" name="tokenId" value={token.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-[var(--color-danger)] px-3 py-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-danger)] transition hover:bg-[var(--color-danger)] hover:text-white"
                      >
                        Revoke
                      </button>
                    </form>
                  )}
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
