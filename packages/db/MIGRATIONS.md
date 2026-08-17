# Migrations

`packages/db/drizzle/` holds every migration this project has ever shipped. Migrations
`0000`–`0004` were produced by `drizzle-kit generate`, which also wrote a matching
`meta/NNNN_snapshot.json` for each of them. Migrations `0005` and later are **hand-authored**:
they were written directly as SQL, appended to `meta/_journal.json` by hand, and no
corresponding snapshot was ever generated for them.

## Why `db:generate` is not usable

`drizzle-kit generate` diffs `schema.ts` against the **last snapshot in `meta/`**, not against
the journal and not against a live database. Because `meta/` only goes up to
`0004_snapshot.json` while `_journal.json` has 15 entries (`0000`–`0014`), the last snapshot
drizzle-kit would diff against describes the schema as of migration `0004` — six tables that
existed at that point (`food_presets`, `meal_entries`, `recipe_ingredients`, `recipes`, `users`,
`weight_entries`), missing every table and column added since (`food_products`, `meal_groups`,
`meal_templates`, `meal_template_items`, `api_tokens`, `admin_audit_events`,
`food_product_revisions`, and more).

Running `drizzle-kit generate` today would therefore diff the *current* `schema.ts` against that
stale `0004` state and emit a migration that tries to recreate everything added in `0005`–`0014`
from scratch — including `DROP`/`CREATE` pairs for tables drizzle-kit would (incorrectly) treat as
renames. Applying it would fail immediately (`relation already exists`) or, worse, silently
destroy data if a rename prompt is answered wrong.

Backfilling the missing snapshots is possible in principle (introspect a fully-migrated database
and re-chain `prevId` for each one) but is not worth the effort relative to just declaring the
migration set hand-authored from `0005` onward, which is what actually happened. There is
therefore no `db:generate` script in `package.json`, and there won't be one until someone
does that backfill.

## Adding a new migration by hand

1. Write the migration SQL directly in `packages/db/drizzle/`, named `NNNN_description.sql`
   where `NNNN` is the next zero-padded index (e.g. `0015_add_thing.sql`). Use
   `--> statement-breakpoint` to separate statements the way existing hand-authored migrations do
   (see `0013_deduplicate_default_meal_groups.sql` for an example).
2. Append a new entry to `meta/_journal.json`:
   ```json
   {
     "idx": 15,
     "version": "7",
     "when": 1785283200000,
     "tag": "0015_add_thing",
     "breakpoints": true
   }
   ```
   - `idx` is the next sequential index.
   - `tag` must exactly match the SQL file name (without `.sql`).
   - `when` **must be strictly greater than every previous entry's `when`**. Drizzle selects
     pending migrations by comparing `when` to the applied set — not by hash — so a `when` that is
     less than or equal to the last applied value is a **silent no-op forever**: `db:migrate`
     prints nothing, exits 0, and the migration never runs, in every environment, including
     production. Use a real `Date.now()` value (milliseconds since epoch) rather than
     hand-typing a round number, and confirm it is larger than the last entry's `when` before
     committing. This invariant (strictly increasing `when` values) is asserted by
     `packages/db/tests/migration.test.ts`.
3. Update `packages/db/src/schema.ts` to match the new SQL (Drizzle's schema is not derived from
   migrations automatically when they're hand-authored — keep the two in sync by hand).
4. Run `pnpm --filter @macro-tracker/db db:migrate` against a local/test database to verify the
   migration applies cleanly, and add or update tests in `packages/db/tests/migration.test.ts`
   covering any data transformation the migration performs.

## knip and the `packages/db` workspace

`packages/db/src/index.ts` re-exports most of the package's public surface with `export *`. Knip
treats every symbol reachable through an `export *` entry point as "used" by default, which would
make dead code in this package invisible to `pnpm audit:unused`. `knip.json` sets
`"includeEntryExports": true` for the `packages/db` workspace specifically to defeat that and
let knip flag genuinely-unreferenced exports again.

One exception: knip flags the type-only exports in `src/postgres-config.d.ts`
(`isPgliteConnectionString`, `isLocalDatabaseHost`, `getSslConfig`, `getPostgresConnectionConfig`,
`PostgresConnectionConfigOverrides`) as unused. This is a false positive — knip does not follow
the `.js`/`.d.ts` pairing used here, but those exports are genuinely consumed by `src/client.ts`,
`src/test-database-safety.ts`, `apps/web/scripts/start-with-migrations.mjs`, and the package's own
tests. Do not delete them based on a knip report alone.

A second class of false positive: knip's "unused export" / "unused exported type" reports mean
"no other file imports this by name" — they do **not** account for a type that is only referenced
*within its own module* by another type that genuinely is used elsewhere (for example
`QUANTITY_UNIT_VALUES` backs `QuantityUnit`, which is embedded in several live types even though
nothing imports `QUANTITY_UNIT_VALUES` itself). Before deleting anything knip flags in
`src/types.ts`, trace whether it is structurally embedded in another type that has real callers —
grep the whole repo, not just for direct importers of the flagged symbol.
