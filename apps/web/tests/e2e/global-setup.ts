import { Pool } from "pg";

export default async function globalSetup() {
  const connectionString =
    process.env.DATABASE_URL ??
    "postgres://postgres:postgres@127.0.0.1:55432/macro_tracker";

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
