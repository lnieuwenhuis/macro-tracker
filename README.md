# Macro Tracker

[![Try Macro Tracker](https://img.shields.io/badge/try-macro.safasfly.dev-1f7a4d?style=flat-square)](https://macro.safasfly.dev)
[![CI](https://github.com/lnieuwenhuis/marco-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/lnieuwenhuis/marco-tracker/actions/workflows/ci.yml)
![Next.js](https://img.shields.io/badge/Next.js-16-black?style=flat-square&logo=nextdotjs)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?style=flat-square&logo=typescript&logoColor=white)
![Drizzle](https://img.shields.io/badge/Drizzle-ORM-c5f74f?style=flat-square)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-ready-4169e1?style=flat-square&logo=postgresql&logoColor=white)
![PGlite](https://img.shields.io/badge/PGlite-local%20friendly-5f6fef?style=flat-square)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

Macro Tracker is a phone-first macro tracking app for the day-to-day work of eating like you meant to. It is built around the stuff I actually want when I am logging food: fast daily entries, planned meals, reusable meals and days, barcode scanning, recipes, weight tracking, and enough stats to see patterns without turning breakfast into a spreadsheet ceremony.

Current app version: `v2.10`

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

You can run Macro Tracker with either PostgreSQL or a local PGlite file. For a small personal instance, PGlite is the quickest path. For a public deployment, use PostgreSQL.

Requirements:

- Node.js 20+
- pnpm 10+
- A Google sign-in flow through Shoo, which is the auth broker this app uses
- Either PostgreSQL or a PGlite file database

Clone and install:

```bash
git clone https://github.com/lnieuwenhuis/marco-tracker.git macro-tracker
cd macro-tracker
pnpm install
```

Export the required environment variables in the shell or deployment environment that starts the web app:

```bash
export APP_URL=http://localhost:3000
export SESSION_SECRET=change-this-to-a-long-random-string
export DATABASE_URL=file:./macro-tracker.db
```

The web package runs from `apps/web`, and its production start script reads `process.env` directly. A repo-root `.env` file is not loaded automatically by the start command. If you use a relative PGlite URL such as `file:./macro-tracker.db`, it is resolved relative to the web app process working directory; use an absolute `file:/.../macro-tracker.db` path if that location needs to be unambiguous.

Then build and run:

```bash
pnpm build
pnpm --filter @macro-tracker/web start
```

For a deployed instance, set `APP_URL` to the public URL and use a real `SESSION_SECRET`. If you use remote PostgreSQL, `DATABASE_URL` uses TLS with certificate verification by default when `sslmode` is omitted or set to `verify-full`; use `sslmode=require` only when your provider requires encrypted TLS without certificate verification.

## API Access

Macro Tracker API v1 is available under `/api/v1/*`. Create personal access tokens from `/settings/api`, then send them as `Authorization: Bearer <token>`. Tokens start with `mtk_v1_`, are shown only once, store only a hash in the database, and can be scoped to read or write daily logs, foods, templates, recipes, weight, goals, and stats.

OpenAPI JSON is available at `/api/v1/openapi.json`, and the readable docs page is `/docs/api`. API responses use `{ "ok": true, "data": ... }` for success and `{ "ok": false, "error": { "code": "...", "message": "..." } }` for failures. Public API dates use `YYYY-MM-DD`.

Self-hosted instances need the latest database migrations so the `api_tokens` table exists before users create tokens.

Useful optional environment variables:

| Variable | Use |
| --- | --- |
| `APP_TRUSTED_ORIGINS` | Extra comma-separated origins that are allowed during auth flows. |
| `SHOO_BASE_URL` | Alternate Shoo base URL. Defaults to `https://shoo.dev`. |
| `ADMIN_OWNER_EMAILS` | Comma-separated emails that should get owner-level admin access. |
| `OPENROUTER_API_KEY` | Enables food-photo estimates. |
| `OPENROUTER_MODEL` | Optional primary OpenRouter model. Must be free, for example `google/gemma-4-26b-a4b-it:free`. |
| `OPENROUTER_FALLBACK_MODELS` | Optional comma-separated free fallback models. |
| `OPENROUTER_MODEL_TIMEOUT_MS` | Optional request timeout for food-photo estimates. |
| `ENABLE_TEST_ROUTES` | Enables controlled test-only routes. Leave off in production unless you are doing a controlled test run. |
| `TEST_ROUTES_SECRET` | Required whenever `ENABLE_TEST_ROUTES=true`; send it in the `x-test-route-secret` header. |

## Contributing

This is a pnpm workspace:

- `apps/web` - the Next.js app and PWA
- `packages/db` - database schema, migrations, query layer, and database tests

Local development:

```bash
pnpm install
pnpm dev
```

Useful checks:

```bash
pnpm --filter @macro-tracker/db test
pnpm --filter @macro-tracker/web test
pnpm --filter @macro-tracker/web lint
pnpm typecheck
pnpm --filter @macro-tracker/web exec tsc --noEmit
pnpm --filter @macro-tracker/db exec tsc --noEmit
pnpm test:e2e
```

Database helpers:

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:studio
```

## License

Macro Tracker is MIT licensed. See [LICENSE](LICENSE).
