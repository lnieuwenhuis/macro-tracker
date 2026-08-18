# Macro Tracker

[![Try Macro Tracker](https://img.shields.io/badge/try-macro.safasfly.dev-1f7a4d?style=flat-square)](https://macro.safasfly.dev)
[![CI](https://github.com/lnieuwenhuis/macro-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/lnieuwenhuis/macro-tracker/actions/workflows/ci.yml)
![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=nextdotjs)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square&logo=typescript&logoColor=white)
![Drizzle](https://img.shields.io/badge/Drizzle-ORM-c5f74f?style=flat-square)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-ready-4169e1?style=flat-square&logo=postgresql&logoColor=white)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

Macro Tracker is a phone-first macro tracking app for the day-to-day work of eating like you meant to. It is built around the stuff I actually want when I am logging food: fast daily entries, planned meals, reusable meals and days, barcode scanning, recipes, weight tracking, and enough stats to see patterns without turning breakfast into a spreadsheet ceremony.

The current app version is defined in [`apps/web/lib/app-version.ts`](apps/web/lib/app-version.ts) (`APP_VERSION`), which is the single source of truth — it is not duplicated here so this line cannot drift out of sync.

## Try It

The live app is here: [macro.safasfly.dev](https://macro.safasfly.dev)

Sign in with Google, set your goals during onboarding, and start logging. The hosted version is the easiest way to poke around before deciding whether you want to run your own copy.

## What You Can Do

- Log meals against a daily macro target, including eaten, planned, and skipped items.
- Scan barcodes and save products so repeat foods get faster over time.
- Estimate a meal from a photo when the AI helper is configured.
- Save reusable foods, meals, full-day templates, and recipes.
- Plan a day ahead, then turn planned meals into real logged meals.
- Track weight and body-fat notes alongside your food log.
- Review summaries, trends, rolling averages, adherence, records, and top foods.
- Use a scoped personal access token API for user-owned data.
- Install it as a PWA and use it comfortably from a phone.
- Moderate shared barcode data and audit changes from the owner/admin tools.

## Run It Yourself

Macro Tracker runs as two services: a Rust backend that owns database access and a Next.js frontend that calls it. The backend requires PostgreSQL; `file:` and `memory:` database URLs are not supported for the app runtime.

Requirements:

- Node.js 20+
- pnpm 10+
- A PostgreSQL database
- A Google sign-in flow through Shoo, which is the auth broker this app uses

Clone and install:

```bash
git clone https://github.com/lnieuwenhuis/macro-tracker.git macro-tracker
cd macro-tracker
pnpm install
```

Export the required environment variables in the shell or deployment environment for each service. Use the same `BACKEND_INTERNAL_SECRET` value for the backend and frontend.

```bash
export APP_URL=http://localhost:3000
export SESSION_SECRET=$(openssl rand -base64 48)
export BACKEND_INTERNAL_SECRET=$(openssl rand -base64 48)
export BACKEND_URL=http://127.0.0.1:4000
export DATABASE_URL=postgres://macro:macro@localhost:5432/macro_tracker
```

Required runtime variables:

| Variable | Service | Use |
| --- | --- | --- |
| `DATABASE_URL` | Backend and migration commands | PostgreSQL connection string for the Rust backend database. Must be `postgres://` or `postgresql://`, not `file:` or `memory:`. |
| `APP_URL` | Backend and frontend | Public URL of the web app, for example `http://localhost:3000` locally. |
| `SESSION_SECRET` | Backend and frontend | Long random secret used for sessions. Required in every environment, including local development — there is no built-in fallback. Generate a fresh value per environment (for example `openssl rand -base64 48`); never reuse a value from this README, a sample `.env`, or another environment, and keep it secret. |
| `BACKEND_INTERNAL_SECRET` | Backend and frontend | Shared secret the frontend sends when calling backend internal routes. |
| `BACKEND_URL` | Frontend | URL the Next.js app uses to reach the Rust backend. Defaults to `http://127.0.0.1:4000` outside production, but set it explicitly in deployments. |

The web package runs from `apps/web`, and its production start script reads `process.env` directly. A repo-root `.env` file is not loaded automatically by the start command.

Run migrations before starting the backend, then start the backend and web app as separate processes:

```bash
# terminal 1: apply PostgreSQL migrations
pnpm db:migrate

# terminal 2: start the Rust backend on port 4000
pnpm backend:start

# terminal 3: start the Next.js web app on port 3000
pnpm dev
```

For production, build the release backend and frontend, then start the two services independently:

```bash
# build artifacts before starting services
pnpm backend:build
pnpm build

# service 1
pnpm backend:start:release

# service 2
pnpm --filter @macro-tracker/web start
```

For a deployed instance, set `APP_URL` to the public URL, `BACKEND_URL` to the backend service URL reachable from the frontend server, and use real random values for `SESSION_SECRET` and `BACKEND_INTERNAL_SECRET`. If you use remote PostgreSQL, `DATABASE_URL` uses TLS with certificate verification by default when `sslmode` is omitted or set to `verify-full`; use `sslmode=require` only when your provider requires encrypted TLS without certificate verification.

The production build uses Next.js standalone output and starts that smaller server automatically when it is present. PostgreSQL pools default to 10 connections; set `POSTGRES_POOL_MAX` if you need a different cap. The old default of 3 was low enough that a burst of unauthenticated requests could exhaust it before any credential check ran.

## API Access

Macro Tracker API v1 is available under `/api/v1/*`. Create personal access tokens from `/settings/api`, then send them as `Authorization: Bearer <token>`. Tokens start with `mtk_v1_`, are shown only once, store only a hash in the database, and can be scoped to read or write daily logs, foods, templates, recipes, weight, goals, and stats.

OpenAPI JSON is available at `/api/v1/openapi.json`, and the readable docs page is `/docs/api`. API responses use `{ "ok": true, "data": ... }` for success and `{ "ok": false, "error": { "code": "...", "message": "..." } }` for failures. Public API dates use `YYYY-MM-DD`.

Self-hosted instances need the latest database migrations so the `api_tokens` table exists before users create tokens.

Useful optional environment variables:

| Variable | Use |
| --- | --- |
| `APP_TRUSTED_ORIGINS` | Extra comma-separated origins that are allowed during auth flows. |
| `SHOO_BASE_URL` | Alternate Shoo base URL. Defaults to `https://shoo.dev`. The Content-Security-Policy is built per request in `apps/web/proxy.ts`, so the runtime value is the one that matters; `connect-src` is derived from it so the browser can reach this origin for the sign-in token exchange. |
| `ADMIN_OWNER_EMAILS` | Comma-separated emails that should get owner-level admin access. |
| `POSTGRES_POOL_MAX` | Optional PostgreSQL pool cap. Defaults to `3` for small deployments. |
| `POSTGRES_POOL_IDLE_TIMEOUT_MS` | Optional idle timeout for pooled PostgreSQL clients. Defaults to `10000`. |
| `POSTGRES_POOL_CONNECTION_TIMEOUT_MS` | Optional PostgreSQL connection timeout. Defaults to `5000`. |
| `NEXT_CACHE_MAX_MEMORY_MB` | Optional Next.js in-memory cache cap in MB. Defaults to `0`, which disables the in-memory data cache entirely; set a non-zero value where cached fetches are expected to hit. |
| `AI_GATEWAY_URL` | OpenAI-compatible chat-completions URL that powers food-photo estimates, for example `http://cliproxyapi.railway.internal:8317/v1/chat/completions`. Must be `https` unless the host is loopback or `*.railway.internal`. See `infra/cliproxyapi/`. Food-photo analysis is unavailable without it. |
| `AI_GATEWAY_API_KEY` | Backend-only bearer key for the AI gateway. Required for food-photo estimates. |
| `AI_GATEWAY_MODELS` | Optional comma-separated model list. Defaults to `gpt-5.6-luna(low),gpt-5.6-luna(medium)`; the effort suffix is translated by CLIProxyAPI into the reasoning-effort parameter. Set on the web service too (for the admin benchmark page) if customized. |
| `AI_GATEWAY_MODEL_TIMEOUT_MS` | Optional per-model attempt timeout for food-photo estimates. Defaults to `20000`, clamped to 3–30s. |
| `ENABLE_TEST_ROUTES` | Enables controlled test-only routes. Leave off in production unless you are doing a controlled test run. |
| `TEST_ROUTES_SECRET` | Required whenever `ENABLE_TEST_ROUTES=true`; send it in the `x-test-route-secret` header. |
| `BACKEND_ENABLE_TEST_ROUTES` | Backend-side counterpart to `ENABLE_TEST_ROUTES`. Enables the test-only role-assignment RPC that Playwright uses. Never set this on a deployed backend. |

## Contributing

This is a pnpm workspace:

- `apps/web` - the Next.js app and PWA
- `apps/backend` - the Rust backend service
- `packages/db` - database schema, migrations, query layer, and database tests

Local development needs PostgreSQL plus the backend and frontend processes:

```bash
pnpm install
pnpm db:migrate

# terminal 1
pnpm backend:start

# terminal 2
pnpm dev
```

Run `pnpm backend:start` and `pnpm dev` in separate terminals so both services stay up while you work.

Useful checks. Use a dedicated PostgreSQL test database whose name clearly contains `test`, `tests`, `e2e`, or `ci`; destructive test setup refuses plain local app databases like `macro_tracker` by default. Point the Rust backend and JS test helpers at the same database for the check you are running so backend-backed routes and direct Drizzle assertions share state:

```bash
export TEST_DATABASE_URL="postgres://postgres:***@127.0.0.1:55432/macro_tracker_test"
export E2E_DATABASE_URL="postgres://postgres:***@127.0.0.1:55432/macro_tracker_e2e"

# Unit/integration checks use TEST_DATABASE_URL.
export DATABASE_URL="$TEST_DATABASE_URL"
pnpm db:migrate

# terminal 1: keep the backend running against $TEST_DATABASE_URL
pnpm backend:start

# terminal 2: run non-E2E checks
pnpm --filter @macro-tracker/db test
pnpm --filter @macro-tracker/web test
pnpm --filter @macro-tracker/web lint
pnpm typecheck
pnpm --filter @macro-tracker/web exec tsc --noEmit
pnpm --filter @macro-tracker/db exec tsc --noEmit

# E2E uses E2E_DATABASE_URL. Restart the backend against the same database
# before Playwright so global setup, the frontend, and the Rust backend share state.
DATABASE_URL="$E2E_DATABASE_URL" pnpm db:migrate

# terminal 1: keep the backend running against $E2E_DATABASE_URL
DATABASE_URL="$E2E_DATABASE_URL" pnpm backend:start

# terminal 2: run Playwright against that backend/database
DATABASE_URL="$E2E_DATABASE_URL" pnpm test:e2e
```

Database helpers:

```bash
pnpm db:migrate
pnpm db:studio
```

Migrations in this repo are hand-authored rather than generated — see
[`packages/db/MIGRATIONS.md`](packages/db/MIGRATIONS.md) for why and for the steps to add one.

### Destructive migrations

Migrations run forward only — there are no down-migrations, and deploy applies
them as a Railway `preDeployCommand`. Once a migration has dropped a table the
data is recoverable only from a backup, so any migration that drops or rewrites
data follows this runbook:

1. **Prefer deprecation over `DROP`.** Rename to `_deprecated_<name>` and keep
   it for one release. That turns a rollback into a rename instead of a restore.
   `0010` is the precedent for what to avoid: it backfills and then drops in the
   same migration, which is forward-safe but leaves no way back.
2. **Take a verified backup immediately before deploying.** Verified means
   restored into a scratch database and checked, not just written:

   ```bash
   pg_dump "$DATABASE_URL" --format=custom --file=pre-migration.dump
   createdb macro_tracker_restore_check
   pg_restore --dbname=macro_tracker_restore_check pre-migration.dump
   psql macro_tracker_restore_check -c "select count(*) from users;"
   ```

3. **Record the migration tag you are moving from**, so the rollback target is
   unambiguous:

   ```bash
   psql "$DATABASE_URL" -c "select * from drizzle.__drizzle_migrations order by created_at desc limit 5;"
   ```

4. **To roll back**, restore the dump into a fresh database and repoint
   `DATABASE_URL`; do not attempt to hand-reverse a dropped table in place.
5. **Deploy the backend first.** It refuses to serve before migrations apply
   (there is a CI test for this), so a failed migration fails closed rather than
   serving against a half-migrated schema.

## License

Macro Tracker is MIT licensed. See [LICENSE](LICENSE).
