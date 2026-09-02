# Complexity and line-count reduction plan

Status: plan only. Nothing in this document has been implemented.

Snapshot: `origin/dev` at `b14980e4` on 2026-09-02. Every line number below refers to that
commit. Recount before editing; do not trust these numbers on any other commit.

This document is written to be handed to an orchestrating agent. It contains the ground rules,
the baseline measurement procedure, an ordered list of self-contained work items, the
verification gate for each, and the sequencing constraints. Read the whole document before
dispatching any work.

## 1. Goal and non-goals

Goal: reduce the amount of code a maintainer must read and the number of places one concept is
spelled out, while keeping every user-visible feature, HTTP/JSON/RPC contract, error code,
error message, UI copy, CSS, SQL result shape and test guarantee exactly as it is today.

Non-goals:

- Code golf. Do not collapse readable multi-line expressions or replace clear names with
  short ones. Line count drops because concepts are stated once, not because lines are packed.
- Feature or behavior changes of any kind, including "obvious" bug fixes found along the way.
  Record those in the PR body under "Observed, not changed" and stop.
- Dependency changes, version bumps, migrations, or touching generated artifacts.
- The file-splitting programme in `godfiles-audit.md`. That programme is complementary and
  still in progress (see section 3). This plan reduces code; that plan relocates it.

Expected outcome, stated honestly: roughly 3,500 to 5,500 fewer lines out of about 62,000
tracked source lines (6 to 9 percent). About 1,200 to 1,700 of that is comment text (see C1);
the rest is duplicated code. Do not chase a bigger number by widening scope.

## 1a. Comment policy

The repository currently explains itself in prose: about 2,000 comment lines in production
code and 500 in tests, with files such as `apps/web/proxy.ts` (34 percent comment lines),
`apps/web/lib/numbers.ts` (39 percent), `apps/backend/src/main.rs` (23 percent) and
`apps/backend/src/auth.rs` (16 percent) reading as essays. The target is code that explains
itself, with a comment only where the code cannot.

Rules, applied to every file any work item touches and in the dedicated pass C1:

1. A comment that restates what the code does is deleted. If the code was unclear without it,
   fix the code: rename the function or variable, extract a named helper, or split a
   condition into named booleans. Prefer the rename over the comment every time.
2. A comment that explains why is kept only if the why is not recoverable from the code, and
   it is cut to one line. "Why" includes: a security invariant, a protocol or RFC constraint,
   a third-party quirk, a deliberate deviation from the obvious implementation. Example:
   `// Pool connections outlive the request; never hold one across the upstream call.`
3. Historical narrative goes. "This used to be X, which broke Y, so now Z" becomes either a
   regression test (if none exists) plus at most one line naming the invariant, or nothing.
   Git history keeps the story.
4. Doc comments (`///`, `/** */`) on internal functions are cut to one line or removed. Public
   package exports in `packages/db/src` may keep a one-line doc comment.
5. Reference links (RFC sections, vendor docs) survive only as a bare pointer on the same line
   as the rule they justify.
6. Section-banner comments, commented-out code and TODOs without an owner are deleted.
7. Never delete a comment that carries a value the code needs, such as a magic number's
   origin, without first moving that value into a named constant.

The reviewer's check for every PR: for each removed comment longer than one line, either the
code now says it, a test now pins it, or a one-line comment remains. Anything else is a
finding.

## 2. Ground rules for every work item

1. Branch from `origin/dev`, never from `main`, `staging` or a release branch. Name the branch
   `refactor/<kebab-slug>` and validate it with `git check-ref-format --branch`. Open one
   non-draft PR per work item into `dev` as GitHub user `lnieuwenhuis`. Never commit to `dev`.
2. CI only runs on PRs whose base is `dev`, `staging` or `main`. Retargeting a PR does not
   trigger CI; merge `origin/dev` into the branch to fire a run.
3. One work item per PR. If an item is listed as "mechanical", it may be done by a fast
   implementation agent; everything else needs a fresh-context reviewer before merge.
   `critical-review` is mandatory for anything under `apps/backend/src/{api,auth,config}.rs`,
   `apps/backend/src/legacy_api.rs`, `apps/web/proxy.ts`, `apps/web/lib/{auth,session}.ts`
   and `packages/db/src/backend-client.ts`.
4. No app version bump. Repository policy bumps versions for features, not refactors.
5. Conventional Commits, no AI or co-author attribution, no `--no-verify`, no force pushes.
6. Do not edit: `apps/backend/src/generated/**`, `packages/db/drizzle/**`, lockfiles,
   `apps/web/app/globals.css`, `apps/web/public/sw.js`, `.github/workflows/**`.
7. Do not change the `SCHEMA_SQL` test fixture or its parity assertion in the backend tests.
8. Rust test child files must be `tests/mod.rs` directories, not `tests.rs` files. The
   duplicate scanner ignores `**/tests/**` only; a `tests.rs` file enters the scan and can
   trip the 0.88 percent threshold.
9. `db::tests` glob-imports its parent module. Pruning an import from a `db` module can break
   only the test build; grep the test modules before removing anything.
10. Any new Playwright `goto` that then interacts with a shell page must call
    `waitForAppReady` from `tests/e2e/test-users.ts`. Admin pages render no `AppShell`, so
    never wait there.
11. Number parsing semantics are frozen. `apps/web/lib/numbers.ts` accepts a decimal comma and
    rejects grouped shapes on purpose. Never swap a raw `Number(...)` call for the shared
    parser, or the reverse, because that changes accepted input. Only rounding and formatting
    helpers may be consolidated, and only when the replacement is arithmetically identical.
12. `formatMinutesAsTime` in `apps/web/lib/formatting.ts` owns the "minute 1440 renders as
    00:00" rule. Every gym time render must keep going through it.
13. On Windows, `pnpm build` fails in `prepare-standalone.mjs` for a pre-existing reason and
    `cargo build` cannot overwrite a running backend exe. Neither is a regression.
14. Every PR applies the comment policy in section 1a to the files it touches. Do not leave a
    file with a long comment because "that is a different item".

## 3. Relationship to the godfiles audit

`docs/architecture/godfiles-audit.md` is being executed. PRs #129 to #136 are merged to `dev`:
inline Rust tests moved to child modules, and `api_tokens`, `weight`, `gym` and `healthkit`
extracted from `db.rs` into `apps/backend/src/db/<domain>.rs`. Still pending from that audit:
`db.rs` users/meals/foods/templates/recipes/stats/admin extraction, `legacy_api.rs` split,
`api.rs` split by resource, TypeScript facade splits, frontend shell splits, standalone test
splits, and CSS last.

Sequencing rule: items in this plan that touch `db.rs` (B1, B2) run **before** the next domain
extraction, because they shrink what has to be moved. Items that touch `api.rs` (B3) and
`legacy_api.rs` (B4) may run before or after their splits but never in the same PR. Frontend
items (F1, F2) run before the dashboard and gym shell splits for the same reason. Never run a
reduction item and a split item on the same file concurrently.

## 4. Baseline and measurement

Record these numbers in the first PR and in every PR body as before/after.

```bash
# Tracked source lines, excluding generated and vendored artifacts
git ls-files | grep -E '\.(rs|ts|tsx|css|mjs)$' | grep -Ev 'generated/|drizzle/meta|public/sw.js' | xargs wc -l | tail -1

# Per-area breakdown
for p in apps/backend/src apps/web/components apps/web/lib apps/web/app apps/web/tests packages/db/src packages/db/tests; do
  printf "%-24s " $p; git ls-files $p | grep -E '\.(rs|ts|tsx|css|mjs)$' | grep -v generated | xargs cat | wc -l
done

# Duplicate and dead-code scans (both are CI gates)
pnpm audit:duplicates   # 13 clones on origin/dev, all in apps/backend/src/db.rs; must not increase
pnpm audit:unused       # clean on origin/dev; must stay clean

# Rust lints
cargo clippy -p macro-tracker-backend --all-targets   # 1 warning on origin/dev (collapsible if)

# Comment lines per area (line comments plus block comments, approximate)
for p in apps/backend/src apps/web/components apps/web/lib apps/web/app packages/db/src apps/web/tests packages/db/tests; do
  git ls-files $p | grep -E '\.(rs|ts|tsx|mjs)$' | grep -v generated | xargs cat | awk -v p="$p" '
    /^[[:space:]]*\/\*/ {inb=1} inb || /^[[:space:]]*(\/\/|\*)/ {c++} inb && /\*\// {inb=0} {t++}
    END {printf "%-24s comment %5d of %6d (%.0f%%)\n", p, c, t, 100*c/t}'
done
```

Baseline on `origin/dev` at `b14980e4`:

| Area | Lines |
| --- | ---: |
| `apps/backend/src` (incl. ~6,500 test lines) | 20,538 |
| `apps/web/components` | 13,732 |
| `apps/web/lib` | 4,525 |
| `apps/web/app` | 3,300 |
| `apps/web/tests` | 11,828 |
| `packages/db/src` | 2,696 |
| `packages/db/tests` | 5,299 |

Comment lines on the same commit:

| Area | Comment lines | Share |
| --- | ---: | ---: |
| `apps/backend/src` | 1,113 | 5% |
| `apps/web/lib` | 391 | 9% |
| `apps/web/components` | 264 | 2% |
| `packages/db/src` | 161 | 6% |
| `apps/web/app` | 59 | 2% |
| `apps/web/tests` | 411 | 3% |
| `packages/db/tests` | 89 | 2% |

Files with the most comment text, and the number of comment blocks of six lines or more:
`db.rs` (222 lines, 9 blocks), `legacy_api.rs` (165, 7), `db/gym.rs` (87), `api.rs` (84, 5),
`auth.rs` (74, 3), `proxy.ts` (69, 4), `schema.ts` (66), `main.rs` (63, 5), `quick-add.ts`
(50), `config.rs` (49), `dashboard-shell.tsx` (47), `app-shell.tsx` (39, 5), `numbers.ts`
(34, 3), `openfoodfacts.ts` (33), `env.ts` (28), `next.config.ts` (26), `migration.ts` (26, 3).

## 5. Verification gate (every PR)

Run the smallest scope first, then the full gate before requesting review. Environment
details for local runs are in the CI workflow `env:` block; unit tests do not read `.env.local`.

```bash
cargo fmt --all --check
cargo check -p macro-tracker-backend
cargo test -p macro-tracker-backend            # with TEST_DATABASE_URL set for DB-backed tests
pnpm typecheck
pnpm lint
pnpm --filter @macro-tracker/db test           # needs the Rust backend on the same TEST_DATABASE_URL, built with --features test-faults
pnpm --filter @macro-tracker/web test          # api-v1, api-token-actions, meal-entry-copy need the backend on :4000
pnpm audit:code
pnpm test:e2e                                   # required for any PR touching apps/web/components or apps/web/app
```

Equivalence evidence required in the PR body, per item type:

- SQL changes: count of distinct SQL string literals before and after, and a diff of the
  rendered SQL for each touched query (print it in a test or with `cargo test -- --nocapture`).
- Rust dispatch changes: `rpc_json` operation-name list before and after must be identical.
- API changes: the OpenAPI JSON is untouched and the `api-v1.test.ts` suite passes unmodified.
- Frontend hook extraction: every touched component's unit test passes unmodified, and the
  E2E suite passes.
- Test consolidation: test count (`it`/`test` invocations plus `it.each` rows) is equal or
  higher, and every assertion that existed still exists somewhere.
- Comment removal: the PR body lists each removed multi-line comment with what replaced it
  (rename, extracted helper, test, one-liner, or "restated the code"). The comment-line
  count for the touched area goes down; the test count does not go down.

## 6. Work items

Effort: S under 100 changed lines, M up to 400, L above. "Mechanical" means the design is
settled and the change is a transformation, suitable for a fast implementation agent.

### Backend (Rust)

**B1. Share the duplicated `jsonb_build_object` projections in `db.rs`** — L, highest value.

All 13 remaining clones live here. The same projection is spelled out repeatedly:

- Food product projection: `search_food_products_json` (1987), `food_product_json_by_id_with_executor`
  (2139), `recent_barcode_submissions_json` (3896), `admin_food_product_by_id_json_with_executor`
  (4365), plus the pair at 3320/3562 and 3344/4824.
- Meal entry projection: `meal_entry_json` (2622) and `meal_entries_json_by_ids` (2672).
- Admin audit event projection: `list_admin_audit_events_json` (4710) and
  `get_admin_audit_event_json` (4762).
- `INSERT INTO meal_entries` column list and values: `create_meal_entry_json` (2462) and
  `apply_template_json` (3188), with the 2480/2592 pair in the same family.
- Bulk-insert bind chains: `insert_template_items` (2841) and `insert_recipe_ingredients` (4990).

Approach: introduce `apps/backend/src/db/sql.rs` holding `const` string fragments (one per
projection, parameterised on the table alias with `concat!`/`format!` at the call site) and
build each query with `format!` into a `String` passed to `sqlx::query`. Non-literal query
strings are already the norm in this file, so nothing changes in how sqlx is used. Keep the
`_with_executor` functions where a transaction caller exists. Expected: about 250 to 350 lines
removed and the clone count reduced to near zero.

Verification: the rendered SQL for each touched function must be byte-identical modulo
whitespace to the current literal. Add a test in `db/tests/mod.rs` that renders each fragment
and snapshots it, so the next domain extraction cannot silently drift it.

**B2. Remove pool-only wrappers around `_with_executor` twins in `db.rs`** — S, mechanical.

Eight functions exist in `name` / `name_with_executor` pairs (lines 271, 604, 2137, 3395,
3549, 4364, 4643, 4671). `&PgPool` already implements `Executor`, so callers can pass the pool
to the executor variant directly. Rename the executor variant to the plain name, delete the
wrapper, update call sites. Keep `pub(super)` visibility for any that the extracted domain
modules or tests reference. Expected: about 40 lines and 8 names removed.

**B3. Add response and failure helpers to `api.rs`** — M, needs `critical-review`.

Within `dispatch_api_request` (297 to 886): `ApiFailure::new(StatusCode::NOT_FOUND, "not_found", ...)`
is spelled out 14 times, `Ok((StatusCode::OK, ...))` 14 times, the inline scope check
`auth.scopes.iter().any(|scope| scope == "read:foods")` 3 times, and the
`json!({ "userId": auth.user_id, ... })` envelope in most of the 54 `rpc(` calls. Add
`not_found(message)` next to the existing `bad_request`, `require_scope(&auth, scope)`,
`ok(value)`, and `user_rpc(state, &auth, op, extra_fields)`. Do not change any status code,
error code, or message text. Expected: about 80 to 120 lines removed and every arm reads as
intent rather than plumbing.

Verification: `api-v1.test.ts` and `apps/backend/src/api/tests/mod.rs` unchanged and green.
The reviewer must diff every arm for status and code parity.

**B4. Share the provider HTTP path in `legacy_api.rs`** — M, needs `critical-review`.

`lookup_open_food_facts` (578), `lookup_albert_heijn` (687) and `lookup_jumbo` (799) each
repeat: build URL, 5-second `tokio::time::timeout`, `send`, status check, `read_capped_json`.
Extract `fetch_provider_json(state, request_builder) -> Option<Value>` and keep each
provider's headers, URL and parsing where they are. `parse_albert_heijn_nutrients` (919) and
`parse_jumbo_nutrients` (964) share the name-match-and-assign loop through `assign_nutrient`;
unify only the loop, not the key lists, because the key lists are provider behavior.
Expected: about 60 to 90 lines removed.

Verification: `legacy_api/tests/mod.rs` unchanged and green. Timeouts and size caps must be
the same numbers as before, asserted by a test if one does not exist.

**B5. Fix the single clippy warning** — S, mechanical. Collapse the flagged `if`. Fold into B2.

### Database package (TypeScript)

**D1. Remove the Drizzle-era `..._ignored: unknown[]` parameter from `backend-queries.ts`** — L, mechanical but wide.

75 of the 80 exported wrappers carry a trailing `..._ignored: unknown[]` so that callers from
the Drizzle era could keep passing `runtime.db`. `backend-queries.ts` also declares
`DatabaseClient = any` and its own `DatabaseRuntime` for the same reason. Tests still pass
`runtime.db` as a trailing argument at roughly 350 sites (`queries.test.ts` 135,
`admin.test.ts` 70, `migration.test.ts` 49, `api-v1.test.ts` 48, and smaller). Production code
in `apps/web` never passes it.

Approach: remove the varargs and the `any` alias from `backend-queries.ts`; keep exporting
`DatabaseRuntime` from `client.ts` for tests that still open a migration runtime; strip the
trailing `runtime.db` argument from every call site (typecheck will list all of them). Do this
in one PR because the package must typecheck at every commit. Do not change any wrapper's
positional signature, operation string, or argument object. Expected: about 75 lines from the
wrappers and 300 or more from tests.

Verification: `pnpm typecheck` green; the operation-string and argument-object contract test
requested by the godfiles audit (if it exists by then) unchanged; `knip` still clean.

### Web app (TypeScript / React)

**F1. `useActionRunner` hook for server-action result handling** — M.

Across `apps/web/components` there are 21 `useTransition` calls, 29 `if (!result.ok)` branches,
73 `setError(` calls and 18 `router.refresh()` calls following the same shape visible in
`gym-shell.tsx` lines 109 to 118 and 380 to 390: start a transition, await an action, on
failure set an error string with a fallback, on success optionally refresh the router. Add
`apps/web/lib/use-action-runner.ts` exposing `{ run, isPending, error, clearError }` where
`run(actionCall, { onSuccess?, refresh? })` performs exactly those steps. Migrate components
that match the pattern one at a time, keeping each component's error placement and fallback
copy identical. Do not migrate `dashboard-shell.tsx` in this item; it multiplexes errors by
draft id and belongs to F2.

Verification: unit tests for the touched components unchanged; full E2E; a small unit test
for the hook covering success, failure with message, failure without message, and refresh.

**F2. `useLazyCollection` hook and draft-error consolidation in `dashboard-shell.tsx`** — M.

Templates and recipes each own four state cells plus an `ensure…Loaded` function that are
line-for-line the same (lines 343 to 346 and 377 to 380; 1099 to 1116 and 1123 to 1140), on
top of the existing `createLazyCollectionLoader`. Add
`apps/web/lib/use-lazy-collection.ts` returning `{ items, setItems, loaded, loading, error, ensureLoaded }`
and use it for both. Then apply F1's runner to the remaining single-error flows in the file.
Expected: about 60 to 90 lines and 8 state cells removed. Stop there; the audit's dashboard
split does the rest.

**F3. Move the `admin-actions.ts` FormData helpers to `apps/web/lib/form-data.ts`** — S, mechanical, optional.

`getRequiredText`, `getOptionalText`, `getNumber`, `getNullableNumber` (lines 17 to 55) are
generic. Do this only if a second consumer appears during the audit's `actions.ts` split;
otherwise skip. Recorded here so nobody re-implements them.

**F4. Split `gym-shell.tsx` by component** — S, mechanical, complexity only.

`GymShell`, `BuddiesPanel` (499) and `GymSlotFormModal` (755) are already separate components
in one 974-line file that the godfiles audit predates. Move the two inner components to
`gym-buddies-panel.tsx` and `gym-slot-form-modal.tsx` verbatim. No line reduction; large
readability gain. Coordinate with the audit's frontend phase so it is not done twice.

### Comments and self-explanatory code

**C1. Comment reduction pass** — L in total, S to M per file, one PR per file group.

Apply section 1a to every production file, grouped so each PR stays reviewable and never
overlaps a file another in-flight item is editing. Files already touched by B1 to F4 get the
pass inside those PRs; C1 covers the rest. Suggested groups, in order of comment density:

1. `apps/web/proxy.ts`, `apps/web/lib/{numbers,env,session,gym-time,openfoodfacts}.ts`,
   `apps/web/next.config.ts` — about 240 comment lines, mostly multi-paragraph rationale.
   Expect several renames and two or three new named constants. Needs `critical-review` for
   `proxy.ts` and `session.ts`.
2. `apps/backend/src/{main,routes,auth,config}.rs` — about 210 lines. Security rationale is
   dense here; keep one line per invariant and move anything that guards against a past bug
   into `*/tests/mod.rs` if not already pinned. Needs `critical-review`.
3. `packages/db/src/{schema,migration,backend-client,client}.ts` — about 140 lines.
4. `apps/web/components/{app-shell,confirm-delete-button,dashboard-shell,progress-shell}.tsx`,
   `apps/web/lib/quick-add.ts` — about 180 lines. Component comments that describe layout
   decisions become nothing; the JSX shows the layout.
5. `apps/backend/src/db/gym.rs` and `legacy_api/benchmark_fixtures.rs` — about 110 lines.
6. Test files: only banner and narrative comments; a one-line "why" above a
   non-obvious assertion stays. About 500 lines exist, expect roughly a third to go.

Working method per file: read the file once, list every comment, classify it against the
seven rules, make the code change that lets the comment go, then delete it. Do not start by
deleting. Expected: 1,200 to 1,700 comment lines removed overall, and a noticeable number of
better-named functions as the side effect.

Verification: full gate for the area; the reviewer applies the check in section 1a.

### Tests

**T1. Table-drive the scope-gating cases in `apps/web/tests/unit/api-v1.test.ts`** — M.

Tests from line 252 to 602 (ten cases) all read "requires scope X before endpoint Y returns
data": create a token with a restricted scope set, call an endpoint, assert 403 with
`insufficient_scope`. Convert to a single `it.each` table of
`{ scopes, method, path, body, setup }` rows. Also hoist the repeated
`createPersonalFoodProduct` and `createApiToken` fixtures into local helpers. Keep the
remaining behavioral cases as they are. Expected: 400 to 600 lines removed with equal or
higher case count.

**T2. Shared `@macro-tracker/db` mock factory for web unit tests** — S.

Nine test files under `apps/web/tests/unit` each spell out a `vi.mock("@macro-tracker/db", ...)`
registry (39 `vi.mock` calls in total). Add `apps/web/tests/unit/helpers/mock-db.ts` exporting
`mockDbModule(overrides)` and use it where the registry is the default shape. Files with
bespoke registries stay as they are. Expected: about 100 lines removed.

**T3. Table-drive `rpc_json` contract tests in `apps/backend/src/db/tests/mod.rs`** — L.

This 2,865-line module is the audit's designated place for operation-name contract coverage.
Where consecutive tests differ only by operation name, arguments and expected error, convert
them to a `[(op, args, expectation)]` table with one loop. This is the largest test-side
reduction available and directly serves the pending domain extractions. Expected: 500 or more
lines removed. Do it before extracting the next domain so the extraction only moves the table
rows.

**T4. Co-split and dedupe `packages/db/tests/queries.test.ts`** — deferred.

Owned by the godfiles audit's per-domain steps. Do not do it here; noted for completeness.

## 7. Recommended order and parallelism

Run at most four agents at once, on non-overlapping files:

1. Wave 1 (parallel): B1 (`db.rs` only), D1 (`packages/db` and test call sites only), T2
   (web unit test helpers only), F4 (gym shell files only). C1 group 1 may run alongside
   because it touches none of those files.
2. Wave 2 (parallel, after B1 merges): B2+B5 (`db.rs`), B3 (`api.rs`), T1 (`api-v1.test.ts`),
   F1 (components other than dashboard/gym shells). C1 group 2 runs here only if B3 is not
   in flight, since both touch backend security files that need the same reviewer.
3. Wave 3: B4 (`legacy_api.rs`), F2 (`dashboard-shell.tsx`), T3 (`db/tests/mod.rs`), C1
   groups 3 and 5.
4. Wave 4: C1 groups 4 and 6, then hand back to the godfiles audit for the next `db.rs`
   domain extraction.

Merge order inside a wave does not matter, but rebase-by-merge (`git merge origin/dev`)
after each merge to trigger CI and to surface conflicts early. Do not stack branches on each
other.

## 8. Definition of done

- All items above are merged to `dev` or explicitly recorded as skipped with a reason.
- The baseline table in section 4 is reproduced with after numbers in the final PR.
- `pnpm audit:duplicates` reports fewer clones than 13 and `pnpm audit:unused` is clean.
- `cargo clippy --all-targets` reports zero warnings.
- No production file has a comment longer than one line, except where the PR body records a
  reviewer-accepted exception. Comment lines in production code are below 800 (from about
  2,000).
- The full gate in section 5 is green on `dev`, including E2E.
- No file under the "do not edit" list in section 2 changed.
- `dev` is promoted to `staging` through the usual PR only when the user asks.
