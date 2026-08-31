# Godfiles audit and refactoring plan

Status: analysis and plan only; no production code has been refactored.

Audit snapshot: `dev` at `b40658ef5343a49ce952a595489f934b59c1aaab` on 2026-08-31.

## Executive conclusion

Yes, this repository has a real godfile problem, and it is concentrated rather than universal.
The most urgent case is [`apps/backend/src/db.rs`](../../apps/backend/src/db.rs): 9,724 physical
lines, 74 string-dispatched RPC operations, 186 top-level declarations, and 52 inline tests. It
contains database-startup checks, user and token management, every major product domain, admin
queries, validation, JSON mapping, a 714-line dispatcher, a test schema, and a 2,700-line test
module. Splitting it would materially reduce review risk, merge conflicts, accidental cross-domain
coupling, and the amount of code an engineer must understand for a local change.

The backend problem is not limited to that file. [`legacy_api.rs`](../../apps/backend/src/legacy_api.rs)
and [`api.rs`](../../apps/backend/src/api.rs) are also multi-domain modules with large inline test
suites. On the frontend, [`dashboard-shell.tsx`](../../apps/web/components/dashboard-shell.tsx) is
the clearest component godfile: its main component spans roughly 1,250 lines and coordinates most
dashboard workflows and modal state. The repository also has several lower-risk facade, type,
style, and test godfiles that should be split with their owning production boundary rather than in
one repository-wide rewrite.

This is primarily a maintainability and correctness recommendation. File splitting by itself is
not expected to improve runtime speed, memory use, or bundle size. Poorly chosen modules could make
the code harder to follow through indirection, introduce Rust visibility/cycle problems, or break
Next.js server-action boundaries. The recommended approach therefore keeps existing public facades,
moves one cohesive responsibility at a time, and proves behavior after every move.

## Audit method and decision rule

The audit counted physical lines in every tracked source-like file, then inspected all production
files at or above 500 lines, all test files at or above 500 lines, generated/lock artifacts above
1,000 lines, and the 400-499 line files with substantial churn or unusually broad responsibility.
Line count is only a review trigger. A file is classified as a godfile or near-godfile when several
of these are true:

- unrelated product domains or architectural layers change for independent reasons;
- one function or component owns several state machines, I/O boundaries, or UI workflows;
- the file is a high-fan-in public surface or a high-churn merge-conflict hotspot;
- tests cannot be selected by domain without running or reading a broad monolith;
- clear extraction seams already exist and can preserve the current public contract.

A long but cohesive security module, schema, lockfile, generated document, or test matrix is not
automatically a godfile. Churn figures below are all-time totals in this young repository, so they
show relative hotspots rather than long-term defect rates. The production duplicate scan
(`jscpd`, with tests/generated/migrations excluded by the repository configuration) found 15 Rust
clone blocks: 14 in `db.rs` and one in `legacy_api.rs`. It found no CSS, TypeScript, or TSX clones;
the repository-wide duplicated-line rate was 0.77%, below the configured 0.88% limit. That supports
splitting by responsibility, not creating generic helpers merely to reduce repeated syntax.

The prescribed development branch and the currently deployed branches are divergent at this
snapshot. `dev` and `origin/main` had 25 and 6 unique commits respectively. The current merged
HealthKit work adds more operations to `api.rs` and `db.rs` on the main-side history, but does not
change any verdict in this report. Future work should recount from the branch actually being
refactored and must not assume these exact line numbers are current.

## Inventory and verdicts

| File | Lines | Structural evidence | Verdict | Priority |
| --- | ---: | --- | --- | --- |
| `apps/backend/src/db.rs` | 9,724 | 74 RPC operations; 186 declarations; 2,700-line test module | Split incrementally | Critical |
| `pnpm-lock.yaml` | 6,501 | Package-manager resolution state | Never split manually | Generated |
| `apps/backend/src/generated/api-v1-openapi.json` | 5,155 | One served OpenAPI document; no checked-in generator found | Keep one artifact; generate deterministically if needed | Generated |
| `apps/backend/src/legacy_api.rs` | 3,499 | Barcode providers, AI photo analysis, benchmark engine, limits, fixtures, 31 tests | Split by external capability | High |
| `Cargo.lock` | 3,128 | Cargo workspace resolution state | Never split manually | Generated |
| `apps/backend/src/api.rs` | 2,521 | 40 resource branches, auth/scopes, routing contract, mapping, response/CORS, 39 tests | Split by API resource | High |
| `packages/db/tests/queries.test.ts` | 2,300 | 41 integration tests across tokens, meals, products, templates, recipes, stats, weight, onboarding | Split with database domains | High |
| `apps/web/tests/unit/api-v1.test.ts` | 2,199 | 45 integration-style tests across transport, scopes, every resource, OpenAPI | Split by contract/resource | High |
| `apps/web/components/dashboard-shell.tsx` | 1,562 | Main component about 1,250 lines; about 30 state cells and six effects; drafts, groups, lazy collections, quick-add and six modal flows | Split while preserving one state owner | High |
| `packages/db/tests/migration.test.ts` | 1,239 | Migration semantics, runner locking/timeouts, destructive-test safety, and tooling invariants | Split into four suites | High |
| `apps/backend/src/auth.rs` | 1,060 | Only 456 non-test lines; cohesive session, Shoo/JWKS, and owner reconciliation boundary | Keep; optionally move tests | Keep |
| `apps/backend/src/config.rs` | 997 | Only 502 non-test lines; one environment parsing and security-validation boundary | Keep; optionally move tests | Keep |
| `apps/web/components/progress-shell.tsx` | 851 | Goals form, weight form/history, SVG geometry/chart, tab shell | Split along existing components | Medium |
| `packages/db/tests/admin.test.ts` | 814 | Users/roles, health segments, barcode moderation, uniqueness, audit behavior | Split by admin subdomain | Low |
| `apps/web/tests/unit/quick-add.test.ts` | 767 | Six describes but all cover one 349-line pure ranking module | Keep | Keep |
| `apps/web/components/barcode-result.tsx` | 704 | 294-line not-found/manual form plus a separate found-product editor | Split into two workflows | Medium |
| `apps/web/app/globals.css` | 700 | Twelve theme blocks, Tailwind mapping, global utilities, navigation motion and scanner animation | Split by cascade layer | Low |
| `apps/backend/src/main.rs` | 685 | Only 269 non-test lines; cohesive process composition, router, limits, shutdown | Keep; optionally move tests | Keep |
| `packages/db/drizzle/meta/0004_snapshot.json` | 673 | Historical generated Drizzle schema snapshot | Never split or rewrite | Generated |
| `apps/web/components/admin-ai-benchmark-client.tsx` | 600 | Cohesive workflow; cache policy is the only clearly independent seam | Tactical cache extraction only | Low |
| `apps/web/lib/actions.ts` | 586 | 24 server actions across nine product domains | Split by domain, respecting `use server` | Medium |
| `apps/web/components/stats-shell.tsx` | 567 | Large but cohesive stats view with two reusable chart primitives | Optional presentational split | Low |
| `apps/web/components/meal-card.tsx` | 567 | One roughly 510-line component owns editing, status/group controls, menu positioning and destructive confirmation | Split view/editor/menu | Medium |
| `packages/db/src/backend-queries.ts` | 550 | 67 thin RPC wrappers across all application and admin domains | Split implementation, retain facade | Medium |
| `packages/db/src/types.ts` | 534 | 69 declarations spanning every user and admin domain | Split with query facade, retain exports | Medium |
| `apps/web/tests/e2e/app.spec.ts` | 530 | 12 unrelated journeys across auth, dashboard, planning, stats and weight | Split by user journey | Low |
| `apps/web/tests/unit/actions.test.ts` | 525 | Seven tests across search, recipes, templates and onboarding, with one broad mock registry | Co-split with actions | Medium |
| `.github/workflows/ci.yml` | 502 | Six related jobs plus a single required aggregate job | Keep centralized | Keep |
| `packages/db/src/schema.ts` | 476 | One relational schema with useful table adjacency | Keep | Keep |
| `apps/web/components/planner-shell.tsx` | 468 | Day-template and shopping-list modes share one stateful shell | Split panels, preserve mounted state | Low |
| `apps/web/tests/e2e/app-shell.spec.ts` | 349 | Navigation/layout mixed with meals, templates, progress/calculator and photo journeys | Keep shell cases; move domain cases | Low |
| `apps/web/components/app-shell.tsx` | 336 | Hidden high-fan-out hub for date navigation, compose events, motion and layout | Extract navigation/event boundaries | Low |
| `apps/web/components/recipe-builder-shell.tsx` | 469 | One delegated recipe-editor workflow | Watch, do not split now | Keep |
| `apps/web/components/preset-modal.tsx` | 422 | One modal with list/create/edit states and extracted state logic | Watch, do not split now | Keep |
| `apps/web/components/ai-food-photo-modal.tsx` | 401 | One analysis workflow nearing state-machine complexity | Keep; use a reducer before adding states | Keep |

## Recommended sequence across the repository

Do not make one “split all godfiles” pull request. The safest order is:

1. Record a green baseline using the existing backend, DB, web, typecheck, lint, build, and relevant
   browser tests. Add characterization tests for any behavior that is not currently pinned.
2. Move inline Rust test modules and benchmark/test fixtures into child-module files without moving
   production logic, and extract narrow shared setup for the large TypeScript test suites. This
   makes subsequent diffs reviewable while retaining private-parent access.
3. For each `db.rs` domain, first carve its tests from `queries.test.ts`, then move that production
   domain behind the unchanged `db` compatibility facade in the same focused PR (or consecutive
   commits). API tokens and weight are better first extractions than meals/templates, which share
   more helpers.
4. Split `legacy_api.rs` by outbound capability and `api.rs` by resource, independently of the DB
   work. Do not change HTTP, JSON, scope, error, or RPC contracts during these moves.
5. Mirror stable backend domains in `packages/db/src/backend-queries/` and `types/`, retaining the
   package-root export surface. Avoid changing Rust and TypeScript contracts in the same PR.
6. Refactor the dashboard and other frontend components in small component/pure-helper moves.
   Keep coupled draft state in one owner until behavior tests prove a narrower custom hook boundary.
7. Split remaining standalone test monoliths—migration, admin and E2E—after their shared setup and
   concurrency assumptions are explicit. Production-coupled tests move in steps 3-6, not later.
   Do not replace readable setup with a generic “test framework.”
8. Split CSS last and verify the real app visually. CSS import order is behavior.

Each step should be a focused Conventional Commit and a separately reviewable PR where practical.
No app version bump is appropriate for a behavior-preserving refactor; the repository versioning
rule calls for bumps when features or major revisions are implemented.

## Detailed findings and instructions

### 1. `apps/backend/src/db.rs` — critical godfile

Why it qualifies:

- Lines 87-299 embed a test-only copy of the SQL schema; startup/schema readiness begins around
  line 363; user identity and goals start around line 474.
- `rpc_json` spans lines 1,193-1,906 and dispatches 74 operations by string. A change in any domain
  therefore edits the same match and module.
- Lines 1,929-6,351 mix daily summaries, templates, recipes, foods/barcodes, admin moderation, API
  tokens, weight, quick-add, stats and leaderboard queries.
- Lines 6,352-7,024 are cross-domain parsing, pagination and validation helpers.
- The inline test module occupies lines 7,025-9,724. The duplicate scan found 14 clone blocks in
  the production portion of this file.

Best target shape:

```text
apps/backend/src/db.rs                 # stable compatibility facade and domain dispatch only
apps/backend/src/db/schema_ready.rs
apps/backend/src/db/users.rs           # identity, goals, onboarding
apps/backend/src/db/api_tokens.rs
apps/backend/src/db/meals.rs           # meal groups, entries, daily summaries
apps/backend/src/db/foods.rs            # products, search, barcode storage
apps/backend/src/db/templates.rs
apps/backend/src/db/recipes.rs
apps/backend/src/db/weight.rs
apps/backend/src/db/stats.rs            # recent data, aggregates, leaderboard
apps/backend/src/db/admin.rs
apps/backend/src/db/input.rs            # only genuinely shared input primitives
apps/backend/src/db/tests/...           # contract/integration tests by domain
```

Instructions:

1. First move `mod tests` to child test modules and move `SCHEMA_SQL` to a `#[cfg(test)]` fixture.
   Keep the existing migration-parity assertion; the comment explicitly states that this copy is
   executable test infrastructure, not dead reference text.
2. Add table-driven Rust contract coverage that calls `rpc_json` by operation name and pins success,
   error, and serialized shapes. Pair it with TypeScript characterization that calls every wrapper
   and asserts its exact operation string and argument object; operation-name parity alone cannot
   catch `{ userId }` drifting to `{ id }` or an admin `actorUserId` disappearing.
3. Keep `db.rs` as a true compatibility facade. Preserve or re-export `verify_schema_ready`,
   `get_user_by_id`, `ensure_user_role`, `upsert_user_from_shoo_profile`,
   `authenticate_api_token`, `ensure_date_string`, `rpc_json`, and every operation string with the
   same visibility/signature. These are called directly from `main.rs`, `routes.rs`, `auth.rs`, and
   `api.rs`; `rpc_json` is not the only external contract. Replace a small group of match arms with
   calls into one child module. Move the called query, private structs, domain-specific parsing and
   tests together.
4. Start with API tokens or weight. Extract meals, foods, templates and recipes later because their
   access checks and transaction helpers overlap. Move admin last because it consumes food/user
   concepts and audit helpers.
5. Keep child visibility at `pub(super)` where possible; do not widen private helpers to broad
   `pub(crate)` merely to make an extraction compile. Move the dispatcher itself only after all
   destination functions exist so operation routing stays easy to compare.
6. Resist a generic repository or query-builder abstraction. The present duplication is mostly
   domain-shaped SQL/JSON mapping; remove a duplicate only when the shared invariant is identical.
7. After every domain move, inspect the diff for query text, bind order, transaction boundaries,
   row limits, error strings and JSON keys. A move should not alter any of them.

Primary risks: Rust child-module visibility, accidental helper cycles, changed SQL bind ordering,
changed JSON/null behavior, and transaction helpers being made overly generic.

Verification: `cargo fmt --all --check`, `cargo check -p macro-tracker-backend`,
`cargo test -p macro-tracker-backend`, `pnpm --filter @macro-tracker/db test`, the web API v1 tests,
and `pnpm audit:duplicates`. The cross-language gate must be set up completely rather than running
the DB command in isolation:

1. Point `DATABASE_URL` and `TEST_DATABASE_URL` at the same dedicated, explicitly test-named local
   PostgreSQL database; configure the same `BACKEND_INTERNAL_SECRET` for backend and clients.
2. Apply migrations, then start the backend locally with `--features test-faults`; enable local-only
   backend test routes only for suites that require them and wait for `/health`.
3. Run Rust, DB and affected web tests while that backend is alive, then stop it. The rollback fault
   tests are not equivalent against an ordinary backend build, and the DB preflight intentionally
   refuses a missing or mismatched backend.

### 2. `apps/backend/src/legacy_api.rs` — high-priority capability godfile

Why it qualifies: one router exposes barcode lookup, food-photo estimation, and an admin benchmark
(lines 250-258), while the module also owns global/per-user concurrency limits, capped upstream
responses, Open Food Facts, Albert Heijn and Jumbo adapters, AI-gateway request/response parsing,
benchmark locking/scoring, public error translation, 31 tests, and a 348-line benchmark-fixture
table. These areas change for unrelated provider, security, product, and benchmark reasons.

Best target shape:

```text
legacy_api.rs                           # three routes and shared response glue
legacy_api/barcode/mod.rs
legacy_api/barcode/open_food_facts.rs
legacy_api/barcode/albert_heijn.rs
legacy_api/barcode/jumbo.rs
legacy_api/food_photo/mod.rs
legacy_api/food_photo/gateway.rs
legacy_api/food_photo/limits.rs         # global semaphore, per-user map and RAII guard
legacy_api/benchmark.rs
legacy_api/benchmark_fixtures.rs
legacy_api/benchmark_lock.rs            # lock state, generation and guard together
legacy_api/http_limits.rs               # only shared capped-read/timeout primitives
```

Move the inline tests into the module that owns the behavior. Extract provider parsing first, then
benchmark fixtures/scoring, then food-photo transport. Keep the food-photo global semaphore,
per-user slot map and RAII guard with food-photo routing; keep the barcode semaphore with barcode
orchestration; and keep benchmark lock state, generation counter and guard with benchmark execution.
Concurrency permits/guards must remain alive over the same await ranges. Preserve timeouts, body
caps, retry classifications, redacted public errors and provider precedence. Do not combine this
move with adding/removing a provider or model. Require a concurrency/security-focused critical
review of these moves before merge, including the existing global-state serialization tests.

Before moving the guards, add controlled-stub handler tests that block one request during upload and
upstream phases, prove a competing request remains limited, release the first request, and prove
capacity recovers. Add equivalent in-flight coverage for barcode provider fan-out and the benchmark
route lock. Direct semaphore/guard unit tests do not prove that handler refactoring preserves guard
lifetime across the full await range.

Verification: focused `cargo test -p macro-tracker-backend legacy_api::`, then the full backend
tests and the web barcode/photo/benchmark route tests.

### 3. `apps/backend/src/api.rs` — high-priority public-contract godfile

Why it qualifies: the file combines request extraction and timeout handling, API-token auth and
scope enforcement, a roughly 560-line resource dispatcher (lines 297-856), a central endpoint table,
input merging/sanitization, recipe-log construction, error mapping, CORS/response construction, and
an 889-line test module. There are 40 resource match branches covering account, goals, days, meal
entries/groups, foods, barcodes, templates, recipes, weight, stats, summary and leaderboard.

Best target shape:

```text
api.rs                                  # router, timeout, top-level dispatch
api/contract.rs                         # Endpoint table and method/scope lookup
api/auth.rs
api/response.rs                         # envelopes, errors and CORS
api/input.rs                            # shared body/path/query primitives
api/resources/account.rs
api/resources/meals.rs
api/resources/foods.rs
api/resources/templates.rs
api/resources/recipes.rs
api/resources/weight.rs
api/resources/stats.rs
api/tests/...
```

Keep `API_V1_ENDPOINTS` as the single route/method/scope source of truth; do not recreate route
metadata inside each handler. First move tests, then response/input helpers, then one resource group
at a time. Preserve endpoint paths, allowed methods, required-scope unioning, error code/message,
status, `Allow` and CORS headers, private-field stripping and OpenAPI coverage. Treat a changed test
expectation as a behavior change, not refactor fallout.

Verification: backend `api::` tests, the web `api-v1` suites, OpenAPI parity, full backend tests,
and a direct request spot-check for success, auth failure, invalid input, method-not-allowed,
preflight, timeout and OpenAPI responses.

### 4. `apps/web/components/dashboard-shell.tsx` — high-priority UI godfile

Why it qualifies: the main `DashboardShell` starts at line 308 and owns draft reconciliation,
optimistic save/delete/status/group mutations, lazy template and recipe collections, quick-add,
copy-to-today timers, meal-group management, compose actions, barcode scanning, food search, presets,
recipes and photo estimation. Lines 320-431 alone declare several refs and more than two dozen state
values across independent workflows. Existing tests cover selected group-change, timer-cleanup and
lazy-modal behavior, but not the entire state machine.

Best target shape:

```text
components/dashboard-shell.tsx         # page composition and authoritative draft collection
components/dashboard/draft-model.ts    # pure conversions/reconciliation/sort helpers
components/dashboard/meal-mutations.ts # pure result reducers first; hook only after coverage
components/dashboard/meal-groups.tsx
components/dashboard/collection-loader.ts
components/dashboard/dashboard-modals.tsx
components/dashboard/dashboard-meals.tsx
```

Extract pure draft helpers first and add direct unit tests. Next extract render-only meal sections
and the meal-group UI. Keep the draft array, saved-meal array, mutation IDs, optimistic rollback,
and date-change reconciliation in one owner until characterization tests cover rapid saves, stale
responses, date changes and failed mutations. Extract modal orchestration by passing narrow commands,
not the whole dashboard state object. Avoid one custom hook per state variable; that only relocates
the godfile into a web of implicit dependencies.

Verification: dashboard, copied-flash and lazy-modal unit tests; web typecheck/lint/build; dashboard
and planner E2E journeys; browser checks at phone and desktop widths including loading, failure,
empty, modal-dismissal, keyboard focus and rapid-interaction cases.

### 5. `packages/db/tests/queries.test.ts` — high-priority test godfile

Why it qualifies: 41 integration tests share one describe and one broad import/setup block while
covering API tokens, daily/stat aggregates, meal/group transactions, product access, templates,
recipes, quick-add, onboarding, leaderboard and weight. A local domain change requires navigating
and running a 2,300-line suite.

Split into `queries/api-tokens.test.ts`, `meals.test.ts`, `foods.test.ts`, `templates.test.ts`,
`recipes.test.ts`, `stats.test.ts`, `weight.test.ts`, and `onboarding.test.ts`. Put database/user
creation and failure-injection factories in a small `tests/support/runtime.ts` only when two or more
suites truly share them. Preserve per-test database isolation and rollback assertions. Split this
alongside or immediately before the corresponding `db.rs` domain move so test selection mirrors
production ownership.

Verification: run every new file separately once, then the package's canonical
`pnpm --filter @macro-tracker/db test` command to catch setup/order assumptions. Preserve the
package's `--fileParallelism=false` behavior; a split is for selection and ownership, not permission
to make the shared-database tests concurrent.

### 6. `apps/web/tests/unit/api-v1.test.ts` — high-priority API test godfile

Why it qualifies: 45 tests cover proxy failures, CORS, authentication/scope combinations, meals,
foods, weight conflicts, validation, templates/recipes, generic method/path behavior and OpenAPI.
It is an integration contract suite rather than one unit.

Create `api-v1/transport.test.ts`, `auth-scopes.test.ts`, domain resource test files, and
`openapi.test.ts`. Share `apiRequest`, token/user setup, and internal-field assertions through a
narrow fixture module. Keep one explicit endpoint-table/OpenAPI completeness suite. Do not duplicate
the full-token setup into every file without measuring the runtime cost; use suite-local setup where
it improves isolation.

Verification: run each new Vitest file directly, then the canonical web test suite and backend API
tests. Confirm no suite relied on another file's database state or environment restoration, and
preserve the web suite's serial file execution until isolated parallel databases are proven.

### 7. `apps/web/lib/actions.ts` — medium-priority server-action godfile

Why it qualifies: 24 exported actions cover meals, meal groups, goals/onboarding, templates, weight,
recipes, search and barcode persistence. The common session/revalidation wrapper is legitimate; the
domain implementations are not one responsibility.

Create domain files under `lib/actions/`, each with its own explicit `"use server"` directive, and
keep the existing shared action result/session/revalidation logic in a small internal module. Move
one domain and its callers/tests at a time. Preserve exported function names and types. A compatibility
barrel in `lib/actions.ts` is acceptable only if the installed Next.js build proves that re-exported
server actions are recognized correctly; otherwise update callers to direct domain imports.

Verification: domain action tests, `next typegen`, TypeScript, lint and production build. Exercise
at least one real form/action mutation because typechecking alone does not prove server-action
registration.

### 8. `packages/db/src/backend-queries.ts` — medium-priority RPC facade godfile

Why it qualifies: roughly 67 exported wrappers expose every user and admin domain through one file.
They are individually simple, but the file is a package-wide change/merge surface and mirrors the
74-operation Rust dispatcher.

Split implementations into `backend-queries/{users,tokens,meals,foods,templates,recipes,weight,stats,admin}.ts`.
Retain `backend-queries.ts` and the package-root exports as stable facades so current imports do not
churn. Keep RPC operation strings and payload/return types exactly aligned with Rust. Do this only
after the matching Rust boundaries are stable, in a separate PR.

Verification: DB package tests and typecheck, web typecheck/build, plus table-driven wrapper tests
that assert every exact operation string and argument object. Compare operation names against the
union of `routes::config_scoped_rpc` and `db::rpc_json`, not the DB dispatcher alone:
`reconcileConfiguredOwner` and `ensureUserRoleForTesting` must terminate at the route-level gate,
while `setUserOnboardingForTesting` may fall through to `db::rpc_json` only after the route-level
test-mode check. Add negative assertions so no future refactor exposes these configuration-sensitive
operations through the ungated DB dispatcher.

### 9. `packages/db/src/types.ts` — medium-priority contract catalog

Why it qualifies: 69 exported constants, guards and types cover authentication, users, meals,
foods, templates, recipes, weight, admin, stats and quick-add. It has high fan-in across the web app,
so unrelated domain edits collide in one contract file.

Split into `types/` files matching stable product domains and make `types.ts` re-export the same
names. Move types only after query domains are chosen; otherwise the two refactors will fight. Keep
foundational macro/unit enums in a small shared file and reject import cycles in which shared types
depend back on a domain. Do not update all consumer imports merely for style—the stable barrel is a
useful compatibility boundary.

Verification: DB and web typechecks, package tests, web build, and an export-surface comparison.

### 10. `apps/web/components/progress-shell.tsx` — medium-priority component collection

Why it qualifies: the file already contains natural but independent components: goals editing
(lines 65-190), pure weight formatting/geometry and SVG charting (191-369), a roughly 400-line weight
editor/history panel (370-771), and a tab shell (772 onward).

Move these existing boundaries into `progress/goals-panel.tsx`, `weight-trend-chart.tsx`,
`weight-panel.tsx`, and pure `weight-format.ts`. Do not redesign state or props during the move.
Add direct geometry/format tests before extraction and preserve selected-date synchronization,
validation visibility, focus and transition behavior.

Verification: weight-trend unit tests, progress/weight E2E cases, typecheck/lint/build, and narrow
and wide browser checks for both tabs.

### 11. `apps/web/components/barcode-result.tsx` — medium-priority two-workflow godfile

Why it qualifies: `NotFoundForm` spans about 294 lines and implements manual product creation;
`BarcodeResult` separately handles found-product serving scaling, editing and preset saving. They
share a result boundary but not most state or validation.

Extract `barcode/not-found-form.tsx`, `found-product-result.tsx`, and pure nutrition scaling/parsing
helpers. Keep the current exported `BarcodeResult` as the composition boundary. Preserve overlay
dismissal, save-in-flight guards, gram scaling, edited-vs-provider values and callback ordering.

Verification: barcode-result unit tests plus barcode scan/manual-entry browser journeys.

### 12. `apps/web/components/meal-card.tsx` — medium-priority single-component godfile

Why it qualifies: nearly the entire 567-line file is one component. It owns expansion/editing,
controlled nutrition inputs, status and meal-group controls, viewport-aware floating-menu layout,
copy/duplicate/delete actions and delete confirmation. These are cohesive to a meal card but too
many UI mechanisms for one render function.

Keep `MealCard` as the memoized state owner and extract render-only `MealCardSummary`,
`MealCardEditor`, and `MealCardMenu` children. Extract menu positioning only after its DOM behavior
has tests. Pass narrow callbacks and primitives so memoization still prevents unrelated cards from
rerendering; do not introduce a context for one card.

Verification: meal-card unit tests, dashboard render/mutation tests, profiler or render-count checks
for the memoization contract, and phone viewport checks for menu placement and keyboard focus.

### 13. `packages/db/tests/migration.test.ts` — high-priority test/infrastructure godfile

Why it qualifies: three concerns are already visible as separate describes: individual migration
semantics, destructive-test database safety, and migration tooling/journal invariants. The first
suite also tests runner concurrency, advisory locks and timeouts, which is infrastructure behavior
rather than a specific data migration.

Split into `migrations/data-migrations.test.ts`, `migration-runner.test.ts`,
`test-database-safety.test.ts`, and `migration-manifest.test.ts`. Keep temporary-directory cleanup
local or in one narrowly scoped helper. Preserve serial execution where database locks require it;
do not add parallelism merely because files are separate.

Verification: run each file, then the DB package suite against an explicitly test-named database.

### 14. `apps/web/tests/unit/actions.test.ts` — co-split with its production owner

Why it qualifies conditionally: only seven tests exist, but they cover search, recipe idempotency,
templates and onboarding and require a 70-plus-line cross-domain mock registry. Splitting it before
`actions.ts` would duplicate mocks and make it worse.

When each production action domain moves, move its tests into a matching file and define only that
domain's mocks. Retain a shared authenticated-action fixture only for session/revalidation behavior.
Until then, leave this file intact.

### 15. `apps/web/components/admin-ai-benchmark-client.tsx` — tactical extraction, not a godfile

This 600-line file stays within one admin benchmark workflow and already has internal summary/result
component boundaries. It should not be restructured merely to reduce line count. The one clearly
independent seam is local-storage cache policy (roughly lines 57-185), which can move to a pure
`ai-benchmark-cache.ts` module when next touched; existing cache and client tests already cover this
logic. Keep network orchestration, user controls, results and verdict rendering together unless a
second consumer appears. Preserve cache version/prefix, TTL, model/fixture keys, candidate-only
behavior, error details and call-count math.

### 16. `apps/web/app/globals.css` — low-priority stylesheet godfile

Why it qualifies: lines 3-411 define twelve themes and a dark-theme variant; lines 415-483 map
tokens into Tailwind; the rest combines global typography, screen transitions, link pending state,
scanner animation, reduced motion and accessibility utilities.

Split by cascade-sensitive purpose, for example `styles/themes.css`, `styles/tokens.css`, and
`styles/motion.css`, imported in one documented order from `globals.css`. Every `@import` must stay
before `@custom-variant`, `@theme`, selectors, or other ordinary rules; placing an extracted import
where the old theme rules began can cause the browser/PostCSS pipeline to ignore it. The entry file
should begin with an explicit prelude like:

```css
@import "tailwindcss";
@import "../styles/themes.css";
@import "../styles/tokens.css";
@import "../styles/motion.css";
```

Keep the current cascade order inside/between those files and keep `@custom-variant`/`@theme` after
the import prelude. Do not convert these rules to CSS modules as part of the split.

Verification: web build plus visual comparison of all themes, reduced-motion mode, navigation/day
transitions, scanner animation and mobile input sizing. A green build is insufficient for CSS.

### 17. `packages/db/tests/admin.test.ts` — low-priority admin test godfile

Why it qualifies: its ten tests cover role invariants/audit events, user health/list filtering,
barcode CRUD/review reasons, application-level uniqueness, database-level uniqueness, restore
conflicts and user-detail macros.

Split into `admin/users.test.ts`, `admin/barcodes.test.ts`, and `admin/audit.test.ts` when `db.rs`
admin code is extracted. Share only runtime/admin-actor construction. Keep database-constraint and
service-validation tests together for each barcode invariant so one layer is not forgotten.

### 18. `apps/web/tests/e2e/app.spec.ts` — low-priority journey godfile

Why it qualifies: a generic file contains unrelated auth, onboarding, dashboard, quick-add,
templates, planner, stats and weight journeys. Failure ownership and focused local runs are harder
than necessary.

Split into journey files such as `auth-onboarding.spec.ts`, `dashboard.spec.ts`, `planner.spec.ts`,
`stats.spec.ts`, and `weight.spec.ts`. Move only genuinely shared seeding helpers to E2E support.
Preserve test independence and do not rely on file order. Re-evaluate Playwright worker/database
isolation before allowing more parallel execution: first run the new files with `--workers=1`, then
individually, then with the normal Playwright worker setting, and repeat once to expose shared-state
flakes.

### 19. `apps/web/tests/e2e/app-shell.spec.ts` — low-priority mixed E2E suite

This 349-line file is below the size threshold but violates the same domain-selection rule as
`app.spec.ts`. Its seven tests mix canonical navigation and viewport anchoring with meal-card menu
placement, template tabs, merged progress/add flows, the macro calculator and photo analysis.

Keep only navigation/layout/viewport cases in `app-shell.spec.ts`. Move meal-card, template,
progress/calculator and photo cases into the matching domain journey suites created from
`app.spec.ts`. Apply the same worker-safety sequence as section 18; moving tests between files can
enable concurrency that did not exist before.

The current Playwright configuration supplies only the `Pixel 7` device, so the automated suite
does not prove desktop behavior. Before a frontend split is accepted, either add an isolated desktop
project/fixture and run the affected journeys under both projects, or perform and record a manual
desktop validation at a concrete viewport such as 1440x900, including keyboard focus and console
errors. Do not describe the existing E2E command as desktop coverage.

### 20. `apps/web/components/planner-shell.tsx` — low-priority two-mode shell

Why it qualifies as a near-godfile despite only 468 lines: day-template creation/search/application
and shopping-date filtering/aggregation/copying are independent modes. They share tab selection and
state whose persistence currently depends on the shell.

Extract `DayTemplatesPanel` and `ShoppingListPanel`, but keep tab selection and any state that must
survive a conditional unmount in `PlannerShell`. Do not move state into a panel until tests prove
that switching tabs preserves form/filter values. Reuse the already extracted shopping-list logic
rather than moving it back into a component. Add shell tests for date-range clamping, clipboard
failure, application/creation errors and cross-tab persistence.

Verification: shopping-list unit tests, planner E2E coverage, typecheck/lint/build, and browser checks
for both tabs with successful and failed clipboard/mutation paths.

### 21. `apps/web/components/app-shell.tsx` — hidden high-fan-out near-godfile

Why it qualifies despite only 336 lines: seven route shells consume it, and it owns startup
timezone/date correction, global keyboard date navigation, route-dependent base paths, a global
compose-event bridge, motion keys, date-picker/header rendering, the Today overlay and profile/menu
composition. These global behaviors have unrelated reasons to change and broad blast radius.

Extract a tested date-navigation hook and `DateNavigator`, then isolate the compose-event bridge.
Keep layout/profile composition in `AppShell`. Preserve input/contenteditable keyboard exclusions,
summary-vs-dashboard paths, hydration-day correction, animation keys, listener cleanup and the
current callback dependencies. The existing Today-date test is not enough; add keyboard exclusion,
base-path, event cleanup and hydration-boundary coverage first.

Verification: app-shell tests, all seven route shells in typecheck/build, and keyboard/navigation
browser checks at phone and desktop widths.

### 22. `apps/web/components/stats-shell.tsx` — optional presentational split

This is a near-godfile, not an urgent design problem. It stays within one stats-page purpose, has
only four imports and one state value, but contains substantial SVG trend-chart and split-bar
implementations alongside the page panels. Extract `macro-trend-chart.tsx`, `macro-split-bar.tsx`,
and small formatting metadata if those pieces are about to change or need focused tests. Otherwise
leave it alone; splitting solely to lower 567 lines would add navigation without reducing coupling.

## Large files that should not be split now

### `apps/backend/src/auth.rs`

The file is 1,060 lines, but only 456 are production code; its 16 inline tests account for 604
lines. Session JWTs, Shoo/JWKS verification/cache, internal-secret authentication and configured
owner reconciliation are one security boundary. Splitting them now would scatter invariants that
benefit from joint review. Keep the production module centralized. Moving `mod tests` to a child
file is a reasonable mechanical cleanup; split production only if another authentication mechanism
or independent ownership appears, and require security-focused review.

### `apps/backend/src/config.rs`

The file is 997 lines, split almost evenly between 502 production and 495 test lines. It builds one
validated `Config` and centralizes database TLS/URL, secret, local-mode, gateway URL, origin and
numeric-bound rules. That concentration is useful: callers should not assemble partial security
policy. Keep it intact, with an optional child test file only. Extract PostgreSQL URL parsing later
only if it gains another consumer or independent maintenance burden.

### `apps/backend/src/main.rs`

The file is 685 lines but only 269 are production code; 416 lines are 13 inline tests. State
construction, HTTP client policy, routing/rate limiting, startup/schema readiness and shutdown are
appropriate composition-root responsibilities. Keep the production module together so process
policy remains auditable. Moving tests out is optional and should not become a router redesign.

### `apps/web/tests/unit/quick-add.test.ts`

The file is 767 lines but its six describes all exercise one pure ranking/aggregation module and
its edge cases. The length reflects useful behavioral coverage. Keep it together unless test
runtime or ownership becomes a problem; do not trade a searchable matrix for fragmented fixtures.

### `.github/workflows/ci.yml`

The 502-line workflow centrally defines six jobs and one aggregate `checks` job. Splitting it into
separate workflows would complicate branch protection, cross-workflow aggregation and cancellation.
There is repeated setup, but a local composite action should be considered only after demonstrating
actual setup drift; service containers and job-specific sequencing will still remain in the workflow.

### `packages/db/src/schema.ts`

At 476 lines, the Drizzle schema is a readable relational catalog. Table adjacency and exported row
types are useful during migration review. Split only if it grows far beyond the current set of
closely related tables or develops independent schema ownership; a line-count refactor would make
foreign-key review harder.

### `apps/backend/src/generated/api-v1-openapi.json`

The 5,155-line JSON is one served OpenAPI document, not a godfile. It is compiled into the Rust
backend as a static byte artifact and checked against endpoint metadata; no checked-in generator
command was found. Do not hand-split it into independently edited fragments. If manual maintenance
is the problem, introduce a deterministic canonical source/generator, keep committing one bundled
artifact, and make CI fail on regeneration diff while preserving `$ref` resolution and the current
`include_bytes!` runtime contract.

### `pnpm-lock.yaml`

The 6,501-line file is pnpm workspace resolution state, not design code. Never split or edit it by
hand. Keep one workspace lockfile, use the configured pnpm version, and verify future dependency
changes with `pnpm install --frozen-lockfile` plus semantic review of the changed packages.

### `Cargo.lock`

The 3,128-line file is Cargo workspace resolution state. Never split or edit it by hand. Keep it at
the workspace root and verify future dependency changes with `cargo check --locked`, advisories and
semantic lockfile review.

### `packages/db/drizzle/meta/0004_snapshot.json`

The 673-line file is a generated historical Drizzle schema snapshot, not a godfile. It and the
smaller snapshots are migration history; applied migrations and snapshots must not be split or
rewritten for readability. Future migration work must respect the repository's documented switch
to hand-authored migrations after `0004`.

### `apps/web/components/recipe-builder-shell.tsx`

At 469 lines this is large but still one delegated recipe-editor workflow: ingredient cards,
totals, modal components and template mutations already have separate owners. Keep it together.
Before adding more orchestration, extract only pure recipe serialization/totals logic that can be
tested independently; do not split markup just to cross a line-count threshold.

### `apps/web/components/preset-modal.tsx`

The 422-line modal owns list/create/edit states for one template workflow, and its state decisions
already live in `preset-modal-state.ts`. Keep it intact until another template kind or genuinely
independent editing workflow appears. Additional states should extend the tested state model rather
than trigger presentational file shuffling.

### `apps/web/components/ai-food-photo-modal.tsx`

The 401-line component owns one photo-analysis workflow. Its growing set of boolean/value states is
approaching state-machine complexity, but splitting markup alone would not reduce it. Keep the file
for now; before adding more states, introduce a tested reducer/controller boundary while preserving
upload size/type checks, in-flight dismissal, clarification and result/error transitions.

## Incidental maintenance observations (not part of the godfile plan)

The audit found two small migration-maintenance inconsistencies. They should be fixed separately,
not folded into a structural refactor:

- `packages/db/MIGRATIONS.md` says the journal ends at `0014` and has 15 entries, but the tracked
  journal now includes `0015` and `0016`.
- The root `package.json` exposes `db:generate`, but `packages/db/package.json` deliberately has no
  `db:generate` script and its migration invariant test documents why generation is unsafe with the
  current snapshot history.

## Refactoring guardrails and acceptance criteria

Every future split should meet all of these conditions:

- The baseline branch/SHA and pre-existing test status are recorded before moves.
- Public Rust functions, TypeScript exports, server-action names, RPC operation strings, endpoint
  paths/methods/scopes, JSON shapes, errors, headers, SQL and transaction boundaries remain stable.
- Characterization tests are added before moving under-tested behavior; existing tests are not
  rewritten to bless a changed result.
- One responsibility moves per commit. Diff review shows relocation/import/visibility changes, not
  opportunistic logic cleanup or reformatting.
- Focused tests pass after each move; the broader affected-package suite passes before the PR.
- Backend/data changes are checked against a dedicated test PostgreSQL database. The Rust backend
  and TypeScript test client point at the same database when the test crosses that boundary.
- Frontend changes are exercised in the real browser at narrow and wide viewports, including
  loading, empty, error and success states, keyboard focus, console errors and reduced motion where
  relevant.
- `pnpm audit:duplicates` stays below its configured threshold. A lower line count is not accepted
  if it creates generic abstractions, cycles, duplicated contracts or unselectable tests.
- The final PR contains no behavior, dependency, migration, schema or app-version change unless
  explicitly separated and approved.

## Definition of done for the overall cleanup

The cleanup is complete when the three backend facades are small enough to explain by boundary,
domain work usually touches one backend module and its matching tests, the dashboard has one clear
owner for draft/mutation state with independently testable subviews, TypeScript query/type/action
facades preserve current imports while their implementations are domain-owned, and test failures
can be run and assigned by domain. No numeric maximum line count is required. A cohesive 600-line
module is preferable to six 100-line modules connected by cycles or prop plumbing.
