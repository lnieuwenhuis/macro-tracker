# Macro Tracker — Agent / LLM Guide

## Monorepo structure

```
apps/web/          Next.js app (see apps/web/AGENTS.md for Next.js-specific rules)
packages/db/       Drizzle ORM + PostgreSQL / PGlite shared database layer
```

---

## ⚠️ Drizzle migrations — READ THIS BEFORE TOUCHING THE SCHEMA

### Why `drizzle-kit generate` is broken

Migration `0005_community_barcode_products.sql` was written by hand without
generating a Drizzle snapshot file. Drizzle Kit uses the snapshot from the
previous migration to compute the diff for the next one. Because the 0005
snapshot is missing, running `drizzle-kit generate` will fail. **Do not try
to run it** — it will produce an error or corrupt the migration history.

### The manual migration workflow (required for every schema change)

Whenever you change `packages/db/src/schema.ts` you must do **all four** of
the following steps. Missing any one of them will either break production or
break local development.

#### Step 1 — Write the SQL file

Create `packages/db/drizzle/00NN_<slug>.sql` where `NN` is the next sequential
index. Write the DDL by hand (ALTER TABLE, CREATE TABLE, CREATE INDEX, etc.).

```sql
-- example: 0007_add_foo_to_bars.sql
ALTER TABLE "bars" ADD COLUMN "foo" text;
```

#### Step 2 — Add an entry to `_journal.json` ← THE STEP THAT GETS FORGOTTEN

Open `packages/db/drizzle/meta/_journal.json` and append a new entry inside
the `"entries"` array. **If this step is skipped, Drizzle's `migrate()` runner
will never see the SQL file and the column/table will not exist in production.**

```json
{
  "idx": 7,
  "version": "7",
  "when": 1776297800000,
  "tag": "0007_add_foo_to_bars",
  "breakpoints": true
}
```

Rules:
- `idx` must be the next integer after the current last entry.
- `tag` must exactly match the filename without `.sql`.
- `when` is a Unix timestamp in milliseconds — use `Date.now()` or any
  reasonable value; it is only metadata and does not affect execution order.
- `version` and `breakpoints` are always `"7"` and `true`.

#### Step 3 — Update `bootstrapLocalSchema` in `packages/db/src/client.ts`

The local development database uses PGlite (in-memory). It is bootstrapped by
`bootstrapLocalSchema()` in `client.ts`, which runs raw SQL to create each
table. You must keep this in sync with the schema **and** handle the case where
an existing local DB already has the table but is missing the new column:

```ts
// In the CREATE TABLE block — add the new column:
"foo" text

// After the CREATE TABLE block — add a migration guard for existing local DBs:
await db.execute(
  sql.raw(
    `ALTER TABLE "bars" ADD COLUMN IF NOT EXISTS "foo" text`,
  ),
);
```

#### Step 4 — Export any new query functions from `packages/db/src/index.ts`

If you added new exported functions to `queries.ts`, make sure they are
re-exported from `index.ts` so the web app can import them from
`@macro-tracker/db`.

---

### How production migrations run

On each deployment, the startup script `packages/db/src/migrate.ts` calls
`migrateCurrentDatabase()`, which calls Drizzle's `migrate()`. That function:

1. Reads `packages/db/drizzle/meta/_journal.json` to get the ordered list of
   migrations.
2. Queries the `__drizzle_migrations` table in the live database to see which
   tags have already been applied.
3. Runs any missing ones in `idx` order.

**A `.sql` file that exists on disk but has no entry in `_journal.json` will
never be applied.** This is exactly what caused the production outage after
migration 0006 was added: the file existed but the journal entry did not, so
the `food_presets.last_used_at` column was never created, causing every
`getPresets()` call to crash with a PostgreSQL column-not-found error.

### Verification checklist before committing a schema change

- [ ] `packages/db/drizzle/00NN_<slug>.sql` created with correct DDL
- [ ] `packages/db/drizzle/meta/_journal.json` has a new entry with matching `tag` and next sequential `idx`
- [ ] `packages/db/src/client.ts` → `bootstrapLocalSchema()` updated (new column in CREATE TABLE + ADD COLUMN IF NOT EXISTS guard)
- [ ] `packages/db/src/schema.ts` change matches the SQL exactly
- [ ] New query functions exported from `packages/db/src/index.ts` if applicable
