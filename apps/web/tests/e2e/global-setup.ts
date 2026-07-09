import { Pool } from "pg";
import {
  assertSafeDestructiveTestDatabaseUrl,
  resolveDestructiveTestDatabaseUrl,
} from "@macro-tracker/db/testing";

const DEFAULT_E2E_DATABASE_URL =
  "postgres://postgres:postgres@127.0.0.1:55432/macro_tracker";

export function resolveE2eDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
) {
  return (
    resolveDestructiveTestDatabaseUrl(env, {
      explicitEnvNames: ["E2E_DATABASE_URL", "TEST_DATABASE_URL"],
      purpose: "Playwright global setup",
    }) ??
    assertSafeDestructiveTestDatabaseUrl(
      DEFAULT_E2E_DATABASE_URL,
      "default local Playwright database",
    )
  );
}

export default async function globalSetup() {
  const connectionString = resolveE2eDatabaseUrl();

  const pool = new Pool({ connectionString });
  try {
    await pool.query(`
      TRUNCATE TABLE
        admin_audit_events,
        api_tokens,
        meal_template_items,
        meal_templates,
        recipe_ingredients,
        recipes,
        weight_entries,
        meal_entries,
        meal_groups,
        food_product_revisions,
        food_products,
        users
      RESTART IDENTITY CASCADE
    `);
  } finally {
    await pool.end();
  }
}
