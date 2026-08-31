// CLEAN-03: this is NOT dead, and it is not merely a reference. `test_db()` runs
// `sqlx::raw_sql(SCHEMA_SQL)` to build the schema for EVERY backend integration
// test, so if it drifts from `packages/db/drizzle/*.sql` the whole suite silently
// stops testing the schema production actually runs. Startup still relies on the
// Drizzle migrations, never on this. `schema_sql_matches_the_drizzle_migrations`
// below pins the two together - update both, or that test fails.
const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY NOT NULL,
  shoo_pairwise_sub text NOT NULL,
  email text NOT NULL,
  display_name text,
  picture_url text,
  role text DEFAULT 'user' NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  last_login_at timestamptz DEFAULT now() NOT NULL,
  goal_calories_kcal integer,
  goal_protein_g numeric(6, 1),
  goal_carbs_g numeric(6, 1),
  goal_fat_g numeric(6, 1),
  goal_weight_kg numeric(5, 2),
  onboarding_completed_at timestamptz,
  preferred_weight_unit text DEFAULT 'kg' NOT NULL,
  friend_code text
);
CREATE UNIQUE INDEX IF NOT EXISTS users_shoo_pairwise_sub_key ON users USING btree (shoo_pairwise_sub);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users USING btree (email);
CREATE UNIQUE INDEX IF NOT EXISTS users_friend_code_key ON users USING btree (friend_code) WHERE friend_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS api_tokens (
  id uuid PRIMARY KEY NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE cascade,
  token_hash text NOT NULL,
  token_prefix text NOT NULL,
  name text NOT NULL,
  scopes jsonb DEFAULT '[]'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_token_hash_key ON api_tokens USING btree (token_hash);
CREATE INDEX IF NOT EXISTS api_tokens_user_created_idx ON api_tokens USING btree (user_id, created_at);
CREATE INDEX IF NOT EXISTS api_tokens_user_revoked_idx ON api_tokens USING btree (user_id, revoked_at);

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id uuid PRIMARY KEY NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  details_json jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_events_created_at_idx ON admin_audit_events USING btree (created_at);
CREATE INDEX IF NOT EXISTS admin_audit_events_target_idx ON admin_audit_events USING btree (target_type, target_id);

CREATE TABLE IF NOT EXISTS food_products (
  id uuid PRIMARY KEY NOT NULL,
  owner_user_id uuid REFERENCES users(id) ON DELETE cascade,
  scope text DEFAULT 'personal' NOT NULL,
  source text DEFAULT 'manual' NOT NULL,
  barcode text,
  name text NOT NULL,
  brand text DEFAULT '' NOT NULL,
  default_serving_quantity numeric(8, 2) DEFAULT '1' NOT NULL,
  default_serving_unit text DEFAULT 'serving' NOT NULL,
  protein_per_100 numeric(7, 2) NOT NULL,
  carbs_per_100 numeric(7, 2) NOT NULL,
  fat_per_100 numeric(7, 2) NOT NULL,
  calories_per_100 integer NOT NULL,
  serving_weight_g numeric(8, 2),
  serving_volume_ml numeric(8, 2),
  submitted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  deleted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  source_provider text,
  source_confidence numeric(4, 2),
  source_metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  corrected_from_product_id uuid REFERENCES food_products(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS food_products_owner_name_idx ON food_products USING btree (owner_user_id, name);
CREATE INDEX IF NOT EXISTS food_products_barcode_idx ON food_products USING btree (barcode);
CREATE UNIQUE INDEX IF NOT EXISTS food_products_active_global_barcode_key
  ON food_products USING btree (barcode)
  WHERE owner_user_id IS NULL AND source = 'barcode' AND deleted_at IS NULL AND barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS food_products_scope_source_idx ON food_products USING btree (scope, source);
CREATE INDEX IF NOT EXISTS food_products_deleted_at_idx ON food_products USING btree (deleted_at);
CREATE INDEX IF NOT EXISTS food_products_submitted_by_idx ON food_products USING btree (submitted_by_user_id);
CREATE INDEX IF NOT EXISTS food_products_corrected_from_idx ON food_products USING btree (corrected_from_product_id);

CREATE TABLE IF NOT EXISTS food_product_revisions (
  id uuid PRIMARY KEY NOT NULL,
  product_id uuid NOT NULL REFERENCES food_products(id) ON DELETE cascade,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  snapshot_json jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS food_product_revisions_product_idx ON food_product_revisions USING btree (product_id);
CREATE INDEX IF NOT EXISTS food_product_revisions_actor_idx ON food_product_revisions USING btree (actor_user_id);
CREATE INDEX IF NOT EXISTS food_product_revisions_created_at_idx ON food_product_revisions USING btree (created_at);

CREATE TABLE IF NOT EXISTS meal_groups (
  id uuid PRIMARY KEY NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE cascade,
  label text NOT NULL,
  sort_order integer NOT NULL,
  is_default boolean DEFAULT false NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS meal_groups_user_sort_idx ON meal_groups USING btree (user_id, sort_order);
CREATE INDEX IF NOT EXISTS meal_groups_deleted_at_idx ON meal_groups USING btree (deleted_at);

CREATE TABLE IF NOT EXISTS meal_entries (
  id uuid PRIMARY KEY NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE cascade,
  entry_date date NOT NULL,
  meal_group_id uuid REFERENCES meal_groups(id) ON DELETE SET NULL,
  status text DEFAULT 'eaten' NOT NULL,
  product_id uuid REFERENCES food_products(id) ON DELETE SET NULL,
  label text NOT NULL,
  sort_order integer NOT NULL,
  quantity numeric(8, 2) DEFAULT '1' NOT NULL,
  unit text DEFAULT 'serving' NOT NULL,
  serving_multiplier numeric(8, 2) DEFAULT '1' NOT NULL,
  protein_g numeric(6, 1) NOT NULL,
  carbs_g numeric(6, 1) NOT NULL,
  fat_g numeric(6, 1) NOT NULL,
  calories_kcal integer NOT NULL,
  client_mutation_id text,
  healthkit_synced_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS meal_entries_user_date_idx ON meal_entries USING btree (user_id, entry_date);
CREATE INDEX IF NOT EXISTS meal_entries_user_date_status_idx ON meal_entries USING btree (user_id, entry_date, status);
CREATE INDEX IF NOT EXISTS meal_entries_meal_group_idx ON meal_entries USING btree (meal_group_id);
CREATE INDEX IF NOT EXISTS meal_entries_product_idx ON meal_entries USING btree (product_id);
CREATE UNIQUE INDEX IF NOT EXISTS meal_entries_user_client_mutation_key ON meal_entries USING btree (user_id, client_mutation_id);
CREATE INDEX IF NOT EXISTS meal_entries_user_date_sort_idx ON meal_entries USING btree (user_id, entry_date, sort_order);
CREATE INDEX IF NOT EXISTS meal_entries_healthkit_unsynced_idx ON meal_entries USING btree (user_id, entry_date) WHERE healthkit_synced_at IS NULL AND status = 'eaten';
CREATE UNIQUE INDEX IF NOT EXISTS meal_groups_active_default_label_key ON meal_groups USING btree (user_id, label) WHERE deleted_at IS NULL AND is_default = true;

CREATE TABLE IF NOT EXISTS weight_entries (
  id uuid PRIMARY KEY NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE cascade,
  entry_date date NOT NULL,
  weight_kg numeric(5, 2) NOT NULL,
  body_fat_pct numeric(4, 1),
  notes text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS weight_entries_user_date_key ON weight_entries USING btree (user_id, entry_date);
CREATE INDEX IF NOT EXISTS weight_entries_user_date_idx ON weight_entries USING btree (user_id, entry_date);

CREATE TABLE IF NOT EXISTS recipes (
  id uuid PRIMARY KEY NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE cascade,
  label text NOT NULL,
  portions integer DEFAULT 1 NOT NULL,
  total_cooked_weight_g numeric(8, 2),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS recipes_user_idx ON recipes USING btree (user_id);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id uuid PRIMARY KEY NOT NULL,
  recipe_id uuid NOT NULL REFERENCES recipes(id) ON DELETE cascade,
  product_id uuid REFERENCES food_products(id) ON DELETE SET NULL,
  sort_order integer NOT NULL,
  label text NOT NULL,
  quantity numeric(8, 2) DEFAULT '1' NOT NULL,
  unit text DEFAULT 'serving' NOT NULL,
  serving_multiplier numeric(8, 2) DEFAULT '1' NOT NULL,
  protein_g numeric(6, 1) NOT NULL,
  carbs_g numeric(6, 1) NOT NULL,
  fat_g numeric(6, 1) NOT NULL,
  calories_kcal integer NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS recipe_ingredients_recipe_idx ON recipe_ingredients USING btree (recipe_id);
CREATE INDEX IF NOT EXISTS recipe_ingredients_product_idx ON recipe_ingredients USING btree (product_id);

CREATE TABLE IF NOT EXISTS meal_templates (
  id uuid PRIMARY KEY NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE cascade,
  type text DEFAULT 'meal' NOT NULL,
  label text NOT NULL,
  notes text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS meal_templates_user_type_idx ON meal_templates USING btree (user_id, type);
CREATE INDEX IF NOT EXISTS meal_templates_deleted_at_idx ON meal_templates USING btree (deleted_at);

CREATE TABLE IF NOT EXISTS meal_template_items (
  id uuid PRIMARY KEY NOT NULL,
  template_id uuid NOT NULL REFERENCES meal_templates(id) ON DELETE cascade,
  product_id uuid REFERENCES food_products(id) ON DELETE SET NULL,
  meal_group_label text,
  sort_order integer NOT NULL,
  label text NOT NULL,
  quantity numeric(8, 2) DEFAULT '1' NOT NULL,
  unit text DEFAULT 'serving' NOT NULL,
  serving_multiplier numeric(8, 2) DEFAULT '1' NOT NULL,
  protein_g numeric(6, 1) NOT NULL,
  carbs_g numeric(6, 1) NOT NULL,
  fat_g numeric(6, 1) NOT NULL,
  calories_kcal integer NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS meal_template_items_template_idx ON meal_template_items USING btree (template_id);
CREATE INDEX IF NOT EXISTS meal_template_items_product_idx ON meal_template_items USING btree (product_id);

CREATE TABLE IF NOT EXISTS gym_slots (
  id uuid PRIMARY KEY NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE cascade,
  title text NOT NULL,
  description text,
  recurrence text NOT NULL,
  slot_date date,
  weekday integer,
  start_minute integer NOT NULL,
  end_minute integer NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT gym_slots_recurrence_check
    CHECK (recurrence IN ('once', 'weekly')),
  CONSTRAINT gym_slots_recurrence_shape_check
    CHECK (
      (recurrence = 'once' AND slot_date IS NOT NULL AND weekday IS NULL)
      OR (recurrence = 'weekly' AND weekday BETWEEN 1 AND 7 AND slot_date IS NULL)
    ),
  CONSTRAINT gym_slots_minutes_check
    CHECK (start_minute >= 0 AND end_minute <= 1440 AND start_minute < end_minute)
);
CREATE INDEX IF NOT EXISTS gym_slots_user_date_idx ON gym_slots USING btree (user_id, slot_date);
CREATE INDEX IF NOT EXISTS gym_slots_user_weekday_idx ON gym_slots USING btree (user_id, weekday);

CREATE TABLE IF NOT EXISTS gym_slot_statuses (
  id uuid PRIMARY KEY NOT NULL,
  slot_id uuid NOT NULL REFERENCES gym_slots(id) ON DELETE cascade,
  status_date date NOT NULL,
  status text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT gym_slot_statuses_status_check
    CHECK (status IN ('going', 'maybe', 'skipped', 'done'))
);
CREATE UNIQUE INDEX IF NOT EXISTS gym_slot_statuses_slot_date_key ON gym_slot_statuses USING btree (slot_id, status_date);

CREATE TABLE IF NOT EXISTS gym_buddies (
  id uuid PRIMARY KEY NOT NULL,
  requester_user_id uuid NOT NULL REFERENCES users(id) ON DELETE cascade,
  addressee_user_id uuid NOT NULL REFERENCES users(id) ON DELETE cascade,
  status text DEFAULT 'pending' NOT NULL,
  invite_identifier text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT gym_buddies_not_self_check
    CHECK (requester_user_id <> addressee_user_id),
  CONSTRAINT gym_buddies_status_check
    CHECK (status IN ('pending', 'accepted', 'declined'))
);
CREATE UNIQUE INDEX IF NOT EXISTS gym_buddies_pair_key ON gym_buddies USING btree (LEAST(requester_user_id, addressee_user_id), GREATEST(requester_user_id, addressee_user_id));
CREATE INDEX IF NOT EXISTS gym_buddies_addressee_idx ON gym_buddies USING btree (addressee_user_id, status);
CREATE INDEX IF NOT EXISTS gym_buddies_requester_idx ON gym_buddies USING btree (requester_user_id, status);
"#;

use super::*;
use chrono::Duration;
use sqlx::postgres::PgPoolOptions;
use std::{collections::HashSet, env, fs, path::PathBuf};

fn bad_request_message(result: AppResult<impl Sized>) -> String {
    match result {
        Err(AppError::BadRequest(message)) => message,
        Err(error) => panic!("expected bad request, got {error:?}"),
        Ok(_) => panic!("expected bad request, got ok"),
    }
}

fn meal_payload(overrides: &[(&str, Value)]) -> serde_json::Map<String, Value> {
    let mut payload = serde_json::Map::from_iter([
        ("label".to_string(), json!("Oats")),
        ("quantity".to_string(), json!(1.0)),
        ("unit".to_string(), json!("serving")),
        ("servingMultiplier".to_string(), json!(1.0)),
        ("proteinG".to_string(), json!(10.0)),
        ("carbsG".to_string(), json!(20.0)),
        ("fatG".to_string(), json!(5.0)),
        ("caloriesKcal".to_string(), json!(165)),
    ]);
    for (key, value) in overrides {
        payload.insert((*key).to_string(), value.clone());
    }
    payload
}

fn food_payload(overrides: &[(&str, Value)]) -> serde_json::Map<String, Value> {
    let mut payload = serde_json::Map::from_iter([
        ("scope".to_string(), json!("personal")),
        ("source".to_string(), json!("manual")),
        ("name".to_string(), json!("Oats")),
        ("defaultServingQuantity".to_string(), json!(1.0)),
        ("defaultServingUnit".to_string(), json!("serving")),
        ("proteinPer100".to_string(), json!(10.0)),
        ("carbsPer100".to_string(), json!(20.0)),
        ("fatPer100".to_string(), json!(5.0)),
        ("caloriesPer100".to_string(), json!(165)),
    ]);
    for (key, value) in overrides {
        payload.insert((*key).to_string(), value.clone());
    }
    payload
}

fn barcode_payload(barcode: &str) -> serde_json::Map<String, Value> {
    serde_json::Map::from_iter([
        ("barcode".to_string(), json!(barcode)),
        ("name".to_string(), json!("Community Bar")),
        ("brands".to_string(), json!("Macro Test")),
        ("servingSizeG".to_string(), json!(42.0)),
        ("proteinG".to_string(), json!(10.0)),
        ("carbsG".to_string(), json!(20.0)),
        ("fatG".to_string(), json!(5.0)),
        ("caloriesKcal".to_string(), json!(165)),
    ])
}

struct TestDb {
    pool: PgPool,
    schema: String,
}

impl TestDb {
    async fn cleanup(&self) {
        let _ = sqlx::query(&format!(
            r#"DROP SCHEMA IF EXISTS "{}" CASCADE"#,
            self.schema
        ))
        .execute(&self.pool)
        .await;
    }
}

async fn test_db() -> TestDb {
    test_db_with_connections(1).await
}

/// Builds a throwaway schema for one integration test.
///
/// Every failure here panics rather than being swallowed. Callers are gated
/// by `#[cfg_attr(not(has_test_database), ignore = ...)]`, so reaching this
/// function at all means a database URL was configured at build time — a
/// missing or unreachable database is then a real failure, not a reason to
/// report a test as passed (TEST-01).
async fn test_db_with_connections(max_connections: u32) -> TestDb {
    let database_url = env::var("TEST_DATABASE_URL")
        .or_else(|_| env::var("DATABASE_URL"))
        .expect("TEST_DATABASE_URL or DATABASE_URL must be set for PostgreSQL integration tests");
    let schema = format!("backend_test_{}", Uuid::new_v4().simple());
    let setup_pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("test database should accept a connection");
    sqlx::query(&format!(r#"CREATE SCHEMA "{}""#, schema))
        .execute(&setup_pool)
        .await
        .expect("test schema should be created");
    setup_pool.close().await;

    let search_path_sql = format!(r#"SET search_path TO "{}""#, schema);
    let pool = PgPoolOptions::new()
        .max_connections(max_connections)
        .after_connect(move |connection, _metadata| {
            let search_path_sql = search_path_sql.clone();
            Box::pin(async move {
                sqlx::query(&search_path_sql).execute(connection).await?;
                Ok(())
            })
        })
        .connect(&database_url)
        .await
        .expect("test database pool should connect");
    sqlx::raw_sql(SCHEMA_SQL)
        .execute(&pool)
        .await
        .expect("test schema should be created from SCHEMA_SQL");
    TestDb { pool, schema }
}

/// Rollback-injection tests (`save_barcode_food_product_rolls_back_*`)
/// assert that a forced mid-transaction failure left neither the
/// product row nor any revision row behind. Both fault points check the
/// same postcondition, so it lives here once.
async fn assert_no_barcode_product_or_revision_rows(pool: &PgPool, barcode: &str) {
    let product_count: i64 =
        sqlx::query("SELECT count(*)::bigint AS count FROM food_products WHERE barcode = $1")
            .bind(barcode)
            .fetch_one(pool)
            .await
            .expect("product count should query")
            .try_get("count")
            .unwrap();
    let revision_count: i64 =
        sqlx::query("SELECT count(*)::bigint AS count FROM food_product_revisions")
            .fetch_one(pool)
            .await
            .expect("revision count should query")
            .try_get("count")
            .unwrap();
    assert_eq!(product_count, 0);
    assert_eq!(revision_count, 0);
}

/// Pulls the `id` field out of every element of a `*_json` search
/// result array, in order. Several search tests assert on nothing but
/// this ordered id list.
fn search_result_ids(results: &Value) -> Vec<&str> {
    results
        .as_array()
        .expect("result should be array")
        .iter()
        .map(|item| item.get("id").and_then(Value::as_str).unwrap())
        .collect::<Vec<_>>()
}

async fn insert_test_user(pool: &PgPool) -> Uuid {
    let user_id = Uuid::new_v4();
    sqlx::query(
        r#"
            INSERT INTO users (id, shoo_pairwise_sub, email, display_name)
            VALUES ($1, $2, $3, 'Test User')
            "#,
    )
    .bind(user_id)
    .bind(format!("test-sub-{user_id}"))
    .bind(format!("{user_id}@example.test"))
    .execute(pool)
    .await
    .expect("test user should insert");
    user_id
}

async fn insert_test_user_with_email(pool: &PgPool, email: &str) -> Uuid {
    let user_id = Uuid::new_v4();
    sqlx::query(
        r#"
            INSERT INTO users (id, shoo_pairwise_sub, email, display_name)
            VALUES ($1, $2, $3, 'Test User')
            "#,
    )
    .bind(user_id)
    .bind(format!("test-sub-{user_id}"))
    .bind(email)
    .execute(pool)
    .await
    .expect("test user should insert");
    user_id
}

async fn insert_test_admin_barcode_product(
    pool: &PgPool,
    barcode: &str,
    name: &str,
    brand: &str,
    submitted_by_user_id: Option<Uuid>,
    deleted: bool,
) -> Uuid {
    let product_id = Uuid::new_v4();
    sqlx::query(
        r#"
            INSERT INTO food_products (
              id, owner_user_id, scope, source, barcode, name, brand,
              default_serving_quantity, default_serving_unit,
              protein_per_100, carbs_per_100, fat_per_100, calories_per_100,
              submitted_by_user_id, deleted_at
            )
            VALUES (
              $1, NULL, 'global', 'barcode', $2, $3, $4,
              100, 'g', 10, 20, 5, 165,
              $5, CASE WHEN $6 THEN now() ELSE NULL END
            )
            "#,
    )
    .bind(product_id)
    .bind(barcode)
    .bind(name)
    .bind(brand)
    .bind(submitted_by_user_id)
    .bind(deleted)
    .execute(pool)
    .await
    .expect("test barcode product should insert");
    product_id
}

async fn insert_test_food_product(
    pool: &PgPool,
    user_id: Option<Uuid>,
    name: &str,
    brand: &str,
    corrected_from_product_id: Option<Uuid>,
) -> Uuid {
    let product_id = Uuid::new_v4();
    sqlx::query(
            r#"
            INSERT INTO food_products (
              id, owner_user_id, scope, source, name, brand,
              default_serving_quantity, default_serving_unit,
              protein_per_100, carbs_per_100, fat_per_100, calories_per_100,
              corrected_from_product_id
            )
            VALUES (
              $1, $2, CASE WHEN $2::uuid IS NULL THEN 'global' ELSE 'personal' END, 'manual', $3, $4,
              100, 'g', 10, 20, 5, 165, $5
            )
            "#,
        )
        .bind(product_id)
        .bind(user_id)
        .bind(name)
        .bind(brand)
        .bind(corrected_from_product_id)
        .execute(pool)
        .await
        .expect("test food product should insert");
    product_id
}

async fn insert_test_meal_entry(
    pool: &PgPool,
    user_id: Uuid,
    entry_date: &str,
    status: &str,
    label: &str,
    sort_order: i32,
    macros: (f64, f64, f64, i32),
) -> Uuid {
    let entry_id = Uuid::new_v4();
    sqlx::query(
        r#"
            INSERT INTO meal_entries (
              id, user_id, entry_date, status, label, sort_order,
              quantity, unit, serving_multiplier,
              protein_g, carbs_g, fat_g, calories_kcal
            )
            VALUES ($1, $2, $3::date, $4, $5, $6, 1, 'serving', 1, $7, $8, $9, $10)
            "#,
    )
    .bind(entry_id)
    .bind(user_id)
    .bind(entry_date)
    .bind(status)
    .bind(label)
    .bind(sort_order)
    .bind(macros.0)
    .bind(macros.1)
    .bind(macros.2)
    .bind(macros.3)
    .execute(pool)
    .await
    .expect("test meal entry should insert");
    entry_id
}

/// API-07: `completeOnboardingSetup` is the third write path into
/// `meal_templates.type` and the one that skipped `normalize_template_type`.
/// Migration 0016 adds a CHECK on that column, so an unvalidated value would
/// come back as a raw 23514 -> 500 rather than a 400, and nothing else
/// covered this path.
#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn onboarding_starter_template_rejects_an_out_of_union_type() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;

    let error = rpc_json(
        &test_db.pool,
        "completeOnboardingSetup",
        serde_json::json!({
            "userId": user_id,
            "input": {
                "goals": {
                    "proteinG": 150,
                    "carbsG": 200,
                    "fatG": 70,
                    "caloriesKcal": 2030
                },
                "starterTemplate": {
                    "type": "not-a-real-type",
                    "label": "Starter",
                    "items": [{
                        "label": "Oats",
                        "quantity": 100,
                        "unit": "g",
                        "proteinG": 10,
                        "carbsG": 60,
                        "fatG": 7,
                        "caloriesKcal": 380
                    }]
                }
            }
        }),
    )
    .await
    .expect_err("an out-of-union template type must be rejected");

    assert!(
        matches!(error, AppError::BadRequest(_)),
        "expected a 400-shaped BadRequest, got {error:?}"
    );

    let templates: i64 =
        sqlx::query_scalar("SELECT count(*) FROM meal_templates WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&test_db.pool)
            .await
            .expect("template count should query");
    assert_eq!(templates, 0, "the rejected template must not be persisted");
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn ensure_default_meal_groups_creates_all_groups_idempotently() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let legacy_breakfast_id = Uuid::new_v4();
    sqlx::query(
            "INSERT INTO meal_groups (id, user_id, label, sort_order, is_default) VALUES ($1, $2, 'Breakfast', 0, true)",
        )
        .bind(legacy_breakfast_id)
        .bind(user_id)
        .execute(&test_db.pool)
        .await
        .expect("legacy default meal group should insert");

    ensure_default_meal_groups(&test_db.pool, user_id)
        .await
        .expect("default meal groups should be created");
    ensure_default_meal_groups(&test_db.pool, user_id)
        .await
        .expect("default meal group creation should be idempotent");

    let groups = sqlx::query(
        r#"
            SELECT label, sort_order, is_default
            FROM meal_groups
            WHERE user_id = $1
            ORDER BY sort_order
            "#,
    )
    .bind(user_id)
    .fetch_all(&test_db.pool)
    .await
    .expect("default meal groups should load");
    let actual = groups
        .iter()
        .map(|row| {
            (
                row.try_get::<String, _>("label").unwrap(),
                row.try_get::<i32, _>("sort_order").unwrap(),
                row.try_get::<bool, _>("is_default").unwrap(),
            )
        })
        .collect::<Vec<_>>();

    assert_eq!(
        actual,
        vec![
            ("Breakfast".to_string(), 0, true),
            ("Lunch".to_string(), 1, true),
            ("Dinner".to_string(), 2, true),
            ("Snack".to_string(), 3, true),
        ]
    );
    let breakfast_id: Uuid = sqlx::query_scalar(
            "SELECT id FROM meal_groups WHERE user_id = $1 AND label = 'Breakfast' AND deleted_at IS NULL",
        )
        .bind(user_id)
        .fetch_one(&test_db.pool)
        .await
        .expect("breakfast group should load");
    assert_eq!(breakfast_id, legacy_breakfast_id);

    let deterministic_breakfast_id = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("macro-tracker:meal-group:{user_id}:Breakfast").as_bytes(),
    );
    sqlx::query(
            "INSERT INTO meal_groups (id, user_id, label, sort_order, is_default, deleted_at) VALUES ($1, $2, 'Breakfast', 0, true, now())",
        )
        .bind(deterministic_breakfast_id)
        .bind(user_id)
        .execute(&test_db.pool)
        .await
        .expect("soft-deleted deterministic breakfast should insert");
    ensure_default_meal_groups(&test_db.pool, user_id)
        .await
        .expect("the active legacy default should remain preferred");
    let active_breakfast_id: Uuid = sqlx::query_scalar(
            "SELECT id FROM meal_groups WHERE user_id = $1 AND label = 'Breakfast' AND deleted_at IS NULL AND is_default = true",
        )
        .bind(user_id)
        .fetch_one(&test_db.pool)
        .await
        .expect("active breakfast group should load");
    assert_eq!(active_breakfast_id, legacy_breakfast_id);
    let deterministic_deleted_at: Option<DateTime<Utc>> =
        sqlx::query_scalar("SELECT deleted_at FROM meal_groups WHERE id = $1")
            .bind(deterministic_breakfast_id)
            .fetch_one(&test_db.pool)
            .await
            .expect("deterministic breakfast group should load");
    assert!(deterministic_deleted_at.is_some());
    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn ensure_default_meal_groups_reactivates_a_soft_deleted_default() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    ensure_default_meal_groups(&test_db.pool, user_id)
        .await
        .expect("default meal groups should be created");
    let lunch_id = Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("macro-tracker:meal-group:{user_id}:Lunch").as_bytes(),
    );
    sqlx::query("UPDATE meal_groups SET deleted_at = now() WHERE id = $1")
        .bind(lunch_id)
        .execute(&test_db.pool)
        .await
        .expect("default meal group should be soft-deleted");

    ensure_default_meal_groups(&test_db.pool, user_id)
        .await
        .expect("soft-deleted default meal group should be restored");

    let active_groups: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM meal_groups WHERE user_id = $1 AND deleted_at IS NULL AND is_default = true",
        )
        .bind(user_id)
        .fetch_one(&test_db.pool)
        .await
        .expect("active default meal groups should be counted");
    assert_eq!(active_groups, 4);
    let restored_lunch_id: Uuid = sqlx::query_scalar(
            "SELECT id FROM meal_groups WHERE user_id = $1 AND label = 'Lunch' AND deleted_at IS NULL AND is_default = true",
        )
        .bind(user_id)
        .fetch_one(&test_db.pool)
        .await
        .expect("restored lunch group should load");
    assert_eq!(restored_lunch_id, lunch_id);
    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn apply_day_template_resolves_exact_and_unambiguous_meal_group_labels() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    ensure_default_meal_groups(&test_db.pool, user_id)
        .await
        .expect("default meal groups should exist");
    let lowercase_dinner_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO meal_groups (id, user_id, label, sort_order) VALUES ($1, $2, 'dinner', 4)",
    )
    .bind(lowercase_dinner_id)
    .bind(user_id)
    .execute(&test_db.pool)
    .await
    .expect("case-colliding meal group should insert");
    let group_rows = sqlx::query(
        "SELECT id, label FROM meal_groups WHERE user_id = $1 AND label IN ('Breakfast', 'Dinner')",
    )
    .bind(user_id)
    .fetch_all(&test_db.pool)
    .await
    .expect("meal groups should load");
    let group_ids = group_rows
        .into_iter()
        .map(|row| {
            (
                row.try_get::<String, _>("label").unwrap(),
                row.try_get::<Uuid, _>("id").unwrap(),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();

    let mut breakfast = meal_payload(&[("label", json!("Oats"))]);
    breakfast.insert("mealGroupLabel".to_string(), json!("breakfast"));
    let mut dinner = meal_payload(&[("label", json!("Pasta"))]);
    dinner.insert("mealGroupLabel".to_string(), json!("Dinner"));
    let mut lowercase_dinner = meal_payload(&[("label", json!("Soup"))]);
    lowercase_dinner.insert("mealGroupLabel".to_string(), json!("dinner"));
    let mut ambiguous_dinner = meal_payload(&[("label", json!("Salad"))]);
    ambiguous_dinner.insert("mealGroupLabel".to_string(), json!("DINNER"));
    let template = create_template_json(
        &test_db.pool,
        user_id,
        &serde_json::Map::from_iter([
            ("type".to_string(), json!("day")),
            ("label".to_string(), json!("Grouped day")),
            (
                "items".to_string(),
                Value::Array(vec![
                    Value::Object(breakfast),
                    Value::Object(dinner),
                    Value::Object(lowercase_dinner),
                    Value::Object(ambiguous_dinner),
                ]),
            ),
        ]),
    )
    .await
    .expect("day template should be created");
    let template_id = Uuid::parse_str(template["id"].as_str().unwrap()).unwrap();

    let created = apply_template_json(
        &test_db.pool,
        user_id,
        &serde_json::Map::from_iter([
            ("templateId".to_string(), json!(template_id)),
            ("date".to_string(), json!("2026-07-12")),
        ]),
        None,
    )
    .await
    .expect("day template should apply");
    let entries = created
        .as_array()
        .expect("created entries should be an array");

    assert_eq!(entries.len(), 4);
    assert_eq!(entries[0]["mealGroupId"], json!(group_ids["Breakfast"]));
    assert_eq!(entries[1]["mealGroupId"], json!(group_ids["Dinner"]));
    assert_eq!(entries[2]["mealGroupId"], json!(lowercase_dinner_id));
    assert_eq!(entries[3]["mealGroupId"], Value::Null);
    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn list_admin_barcode_products_applies_catalogue_filters_to_items_and_totals() {
    let test_db = test_db().await;
    let alice_id = insert_test_user_with_email(&test_db.pool, "alice.submitter@example.test").await;
    let bob_id = insert_test_user_with_email(&test_db.pool, "bob.submitter@example.test").await;
    let barcode_match_id = insert_test_admin_barcode_product(
        &test_db.pool,
        "991-filter-barcode",
        "Barcode Match",
        "Macro Labs",
        Some(alice_id),
        false,
    )
    .await;
    let name_match_id = insert_test_admin_barcode_product(
        &test_db.pool,
        "992-filter-name",
        "Needle Crunch",
        "Other Brand",
        Some(alice_id),
        true,
    )
    .await;
    let brand_match_id = insert_test_admin_barcode_product(
        &test_db.pool,
        "993-filter-brand",
        "Plain Bar",
        "Needle Brand",
        Some(bob_id),
        false,
    )
    .await;
    insert_test_admin_barcode_product(
        &test_db.pool,
        "994-filter-other",
        "Plain Cereal",
        "Other Brand",
        None,
        false,
    )
    .await;

    let barcode_result = list_admin_barcode_products_json(
        &test_db.pool,
        &serde_json::Map::from_iter([
            ("q".to_string(), json!("991-filter-barcode")),
            ("pageSize".to_string(), json!(1)),
        ]),
        false,
    )
    .await
    .expect("barcode query should filter");
    assert_eq!(barcode_result["pagination"]["totalItems"], json!(1));
    assert_eq!(barcode_result["items"][0]["id"], json!(barcode_match_id));

    let name_result = list_admin_barcode_products_json(
        &test_db.pool,
        &serde_json::Map::from_iter([("q".to_string(), json!("Needle Crunch"))]),
        false,
    )
    .await
    .expect("name query should filter");
    assert_eq!(name_result["pagination"]["totalItems"], json!(1));
    assert_eq!(name_result["items"][0]["id"], json!(name_match_id));

    let brand_result = list_admin_barcode_products_json(
        &test_db.pool,
        &serde_json::Map::from_iter([("q".to_string(), json!("Needle Brand"))]),
        false,
    )
    .await
    .expect("brand query should filter");
    assert_eq!(brand_result["pagination"]["totalItems"], json!(1));
    assert_eq!(brand_result["items"][0]["id"], json!(brand_match_id));

    let active_result = list_admin_barcode_products_json(
        &test_db.pool,
        &serde_json::Map::from_iter([
            ("status".to_string(), json!("active")),
            ("pageSize".to_string(), json!(1)),
        ]),
        false,
    )
    .await
    .expect("active status should filter");
    assert_eq!(active_result["pagination"]["totalItems"], json!(3));
    assert_eq!(active_result["pagination"]["totalPages"], json!(3));

    let deleted_result = list_admin_barcode_products_json(
        &test_db.pool,
        &serde_json::Map::from_iter([("status".to_string(), json!("deleted"))]),
        false,
    )
    .await
    .expect("deleted status should filter");
    assert_eq!(deleted_result["pagination"]["totalItems"], json!(1));
    assert_eq!(deleted_result["items"][0]["id"], json!(name_match_id));

    let submitter_result = list_admin_barcode_products_json(
        &test_db.pool,
        &serde_json::Map::from_iter([
            ("submitter".to_string(), json!("alice.submitter")),
            ("pageSize".to_string(), json!(1)),
        ]),
        false,
    )
    .await
    .expect("submitter should filter");
    assert_eq!(submitter_result["pagination"]["totalItems"], json!(2));
    assert_eq!(submitter_result["pagination"]["totalPages"], json!(2));

    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn search_food_products_blank_query_returns_empty_array() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    insert_test_food_product(
        &test_db.pool,
        Some(user_id),
        "Blank Match",
        "Macro Test",
        None,
    )
    .await;

    let results = search_food_products_json(&test_db.pool, user_id, "   ")
        .await
        .expect("product search should succeed");

    assert!(
        results
            .as_array()
            .expect("search result should be array")
            .is_empty()
    );
    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn search_food_products_matches_each_word_independently() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let product_id = insert_test_food_product(
        &test_db.pool,
        Some(user_id),
        "Plain Yogurt",
        "Greek House",
        None,
    )
    .await;
    let unrelated_id =
        insert_test_food_product(&test_db.pool, Some(user_id), "Apple", "", None).await;

    let results = search_food_products_json(&test_db.pool, user_id, "greek yogurt")
        .await
        .expect("product search should succeed");
    let product_id_value = product_id.to_string();
    let ids = results
        .as_array()
        .expect("search result should be array")
        .iter()
        .filter_map(|item| item.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();

    assert!(ids.contains(&product_id_value.as_str()));
    assert!(!ids.contains(&unrelated_id.to_string().as_str()));
    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn search_food_products_prioritizes_corrected_and_personal_products() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let global_id =
        insert_test_food_product(&test_db.pool, None, "Alpha Yogurt", "Macro", None).await;
    let personal_id =
        insert_test_food_product(&test_db.pool, Some(user_id), "Beta Yogurt", "Macro", None).await;
    let corrected_id = insert_test_food_product(
        &test_db.pool,
        Some(user_id),
        "Gamma Yogurt",
        "Macro",
        Some(global_id),
    )
    .await;

    let results = search_food_products_json(&test_db.pool, user_id, "yogurt")
        .await
        .expect("product search should succeed");
    let ids = results
        .as_array()
        .expect("search result should be array")
        .iter()
        .map(|item| {
            Uuid::parse_str(item.get("id").and_then(Value::as_str).unwrap())
                .expect("result id should be uuid")
        })
        .collect::<Vec<_>>();

    assert_eq!(&ids[..3], &[corrected_id, personal_id, global_id]);
    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn admin_user_detail_preserves_recent_activity_contracts() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let last_meal_id = insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-07-10",
        "planned",
        "Tomorrow's lunch",
        2,
        (20.0, 30.0, 10.0, 290),
    )
    .await;
    let first_meal_id = insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-07-10",
        "eaten",
        "Breakfast",
        0,
        (25.0, 40.0, 12.0, 368),
    )
    .await;
    let second_meal_id = insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-07-10",
        "eaten",
        "Lunch",
        1,
        (30.0, 45.0, 15.0, 435),
    )
    .await;
    sqlx::query(
        r#"
            UPDATE meal_entries
            SET created_at = CASE id
              WHEN $1 THEN '2026-07-10 08:00:00+00'::timestamptz
              WHEN $2 THEN '2026-07-10 09:00:00+00'::timestamptz
              WHEN $3 THEN '2026-07-10 10:00:00+00'::timestamptz
            END
            WHERE id IN ($1, $2, $3)
            "#,
    )
    .bind(last_meal_id)
    .bind(first_meal_id)
    .bind(second_meal_id)
    .execute(&test_db.pool)
    .await
    .expect("test meal creation order should update");
    for day in 1..=11 {
        sqlx::query(
            r#"
                INSERT INTO weight_entries (id, user_id, entry_date, weight_kg)
                VALUES ($1, $2, $3::date, $4)
                "#,
        )
        .bind(Uuid::new_v4())
        .bind(user_id)
        .bind(format!("2026-06-{day:02}"))
        .bind(80.0 + f64::from(day) / 10.0)
        .execute(&test_db.pool)
        .await
        .expect("test weight should insert");
    }
    let manual_id =
        insert_test_food_product(&test_db.pool, Some(user_id), "Manual food", "", None).await;
    let barcode_id = insert_test_food_product(
        &test_db.pool,
        None,
        "Submitted barcode food",
        "Test brand",
        None,
    )
    .await;
    sqlx::query(
            "UPDATE food_products SET source = 'barcode', barcode = $2, submitted_by_user_id = $1 WHERE id = $3",
        )
        .bind(user_id)
        .bind("8712345678901")
        .bind(barcode_id)
        .execute(&test_db.pool)
        .await
        .expect("test barcode product should update");

    let detail = get_admin_user_detail_json(&test_db.pool, user_id)
        .await
        .expect("admin user detail should load");
    let recent_meal_ids = detail["recentMeals"]
        .as_array()
        .expect("recent meals should be an array")
        .iter()
        .filter_map(|item| item["id"].as_str())
        .collect::<Vec<_>>();
    let recent_barcode_ids = detail["recentBarcodeSubmissions"]
        .as_array()
        .expect("recent barcode submissions should be an array")
        .iter()
        .filter_map(|item| item["id"].as_str())
        .collect::<Vec<_>>();
    let recent_weight_dates = detail["recentWeights"]
        .as_array()
        .expect("recent weights should be an array")
        .iter()
        .filter_map(|item| item["date"].as_str())
        .collect::<Vec<_>>();

    assert_eq!(
        recent_meal_ids,
        vec![
            first_meal_id.to_string(),
            second_meal_id.to_string(),
            last_meal_id.to_string(),
        ]
    );
    assert_eq!(recent_weight_dates.len(), 10);
    assert_eq!(recent_weight_dates.first(), Some(&"2026-06-11"));
    assert_eq!(recent_weight_dates.last(), Some(&"2026-06-02"));
    assert!(!recent_weight_dates.contains(&"2026-06-01"));
    assert_eq!(recent_barcode_ids, vec![barcode_id.to_string()]);
    assert!(!recent_barcode_ids.contains(&manual_id.to_string().as_str()));
    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn search_meal_entries_excludes_planned_and_skipped_entries() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let eaten_id = insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-07-03",
        "eaten",
        "Protein Bowl",
        1,
        (30.0, 40.0, 10.0, 370),
    )
    .await;
    insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-07-04",
        "planned",
        "Protein Bowl Planned",
        0,
        (30.0, 40.0, 10.0, 370),
    )
    .await;
    insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-07-05",
        "skipped",
        "Protein Bowl Skipped",
        0,
        (30.0, 40.0, 10.0, 370),
    )
    .await;

    let results = search_meal_entries_json(&test_db.pool, user_id, "protein bowl")
        .await
        .expect("meal search should succeed");
    let ids = search_result_ids(&results);

    assert_eq!(ids, vec![eaten_id.to_string()]);
    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn search_meal_entries_deduplicates_equivalent_historical_foods() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let newest_id = insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-07-06",
        "eaten",
        "Turkey Chili",
        2,
        (35.0, 45.0, 12.0, 428),
    )
    .await;
    insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-07-01",
        "eaten",
        "turkey chili",
        0,
        (35.0, 45.0, 12.0, 428),
    )
    .await;
    let distinct_id = insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-07-02",
        "eaten",
        "Turkey Chili",
        1,
        (36.0, 45.0, 12.0, 432),
    )
    .await;

    let results = search_meal_entries_json(&test_db.pool, user_id, "turkey chili")
        .await
        .expect("meal search should succeed");
    let ids = search_result_ids(&results);

    assert_eq!(ids, vec![newest_id.to_string(), distinct_id.to_string()]);
    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn search_meal_entries_hides_soft_deleted_product_id_but_keeps_macro_snapshot() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let product_id =
        insert_test_food_product(&test_db.pool, Some(user_id), "Deleted Protein", "", None).await;
    let entry_id = insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-07-07",
        "eaten",
        "Deleted Protein Bowl",
        0,
        (44.0, 22.0, 11.0, 363),
    )
    .await;
    sqlx::query("UPDATE meal_entries SET product_id = $1 WHERE id = $2")
        .bind(product_id)
        .bind(entry_id)
        .execute(&test_db.pool)
        .await
        .expect("meal product link should update");

    let visible_results = search_meal_entries_json(&test_db.pool, user_id, "deleted protein")
        .await
        .expect("meal search should succeed");
    assert_eq!(visible_results[0]["productId"], json!(product_id));
    assert_eq!(visible_results[0]["sourceLabel"], json!("Deleted Protein"));

    sqlx::query("UPDATE food_products SET deleted_at = now() WHERE id = $1")
        .bind(product_id)
        .execute(&test_db.pool)
        .await
        .expect("product should soft-delete");

    let deleted_results = search_meal_entries_json(&test_db.pool, user_id, "deleted protein")
        .await
        .expect("meal search should still succeed");
    assert_eq!(deleted_results[0]["id"], json!(entry_id));
    assert_eq!(deleted_results[0]["productId"], Value::Null);
    assert_eq!(deleted_results[0]["sourceLabel"], Value::Null);
    assert_eq!(deleted_results[0]["proteinG"].as_f64(), Some(44.0));
    assert_eq!(deleted_results[0]["carbsG"].as_f64(), Some(22.0));
    assert_eq!(deleted_results[0]["fatG"].as_f64(), Some(11.0));
    assert_eq!(deleted_results[0]["caloriesKcal"], json!(363));
    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn get_recent_quick_add_candidates_defaults_to_thirty_when_limit_is_omitted() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    for index in 0..31 {
        insert_test_meal_entry(
            &test_db.pool,
            user_id,
            &format!("2026-07-{:02}", index + 1),
            "eaten",
            &format!("Quick Add Candidate {index}"),
            index,
            (10.0 + f64::from(index), 20.0, 5.0, 165 + index),
        )
        .await;
    }

    let results = rpc_json(
        &test_db.pool,
        "getRecentQuickAddCandidates",
        json!({ "userId": user_id }),
    )
    .await
    .expect("quick-add candidates should load");

    assert_eq!(
        results
            .as_array()
            .expect("quick-add result should be array")
            .len(),
        30
    );

    sqlx::query(
        r#"
            WITH inserted_templates AS (
              INSERT INTO meal_templates (id, user_id, type, label, updated_at)
              SELECT
                md5('quick-template-' || gs::text || $1::text)::uuid,
                $1,
                'meal',
                'Quick template ' || gs,
                now() - (gs || ' seconds')::interval
              FROM generate_series(1, 31) AS gs
              RETURNING id, label
            )
            INSERT INTO meal_template_items (
              id, template_id, sort_order, label, quantity, unit, serving_multiplier,
              protein_g, carbs_g, fat_g, calories_kcal
            )
            SELECT
              md5('quick-item-' || id::text)::uuid,
              id,
              0,
              label,
              1,
              'serving',
              1,
              10,
              20,
              5,
              165
            FROM inserted_templates
            "#,
    )
    .bind(user_id)
    .execute(&test_db.pool)
    .await
    .expect("quick-add templates should insert");

    let dashboard_results = rpc_json(
        &test_db.pool,
        "getDashboardQuickAddCandidates",
        json!({ "userId": user_id }),
    )
    .await
    .expect("dashboard quick-add candidates should load");
    let dashboard_results = dashboard_results
        .as_array()
        .expect("dashboard quick-add result should be array");
    assert_eq!(dashboard_results.len(), 60);
    assert_eq!(
        dashboard_results
            .iter()
            .filter(|candidate| candidate["source"] == "preset")
            .count(),
        30
    );
    assert_eq!(
        dashboard_results
            .iter()
            .filter(|candidate| candidate["source"] == "recent")
            .count(),
        30
    );
    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn leaderboard_handles_empty_grace_gaps_ties_and_large_history() {
    let test_db = test_db().await;

    let empty_user = insert_test_user(&test_db.pool).await;
    let empty = leaderboard_json(&test_db.pool, empty_user, "2026-07-06")
        .await
        .expect("empty leaderboard should load");
    assert_eq!(empty["currentStreak"], 0);
    assert_eq!(empty["longestStreak"], 0);
    assert_eq!(empty["totalDaysTracked"], 0);
    assert_eq!(empty["bestCalorieDay"], Value::Null);

    let streak_user = insert_test_user(&test_db.pool).await;
    for (index, date) in ["2026-07-01", "2026-07-02", "2026-07-04", "2026-07-05"]
        .iter()
        .enumerate()
    {
        insert_test_meal_entry(
            &test_db.pool,
            streak_user,
            date,
            "eaten",
            "Tied day",
            index as i32,
            (10.0, 20.0, 5.0, 165),
        )
        .await;
    }
    let yesterday = leaderboard_json(&test_db.pool, streak_user, "2026-07-06")
        .await
        .expect("yesterday grace leaderboard should load");
    assert_eq!(yesterday["currentStreak"], 2);
    assert_eq!(yesterday["longestStreak"], 2);
    assert_eq!(yesterday["totalDaysTracked"], 4);
    assert_eq!(yesterday["bestCalorieDay"]["date"], "2026-07-01");
    assert_eq!(yesterday["bestProteinDay"]["date"], "2026-07-01");

    insert_test_meal_entry(
        &test_db.pool,
        streak_user,
        "2026-07-06",
        "eaten",
        "Today",
        0,
        (10.0, 20.0, 5.0, 165),
    )
    .await;
    let today = leaderboard_json(&test_db.pool, streak_user, "2026-07-06")
        .await
        .expect("today leaderboard should load");
    assert_eq!(today["currentStreak"], 3);
    assert_eq!(today["longestStreak"], 3);

    insert_test_meal_entry(
        &test_db.pool,
        streak_user,
        "2026-07-07",
        "eaten",
        "Future",
        0,
        (10.0, 20.0, 5.0, 165),
    )
    .await;
    let future = leaderboard_json(&test_db.pool, streak_user, "2026-07-06")
        .await
        .expect("leaderboard with a future consecutive entry should load");
    assert_eq!(future["currentStreak"], 3);
    assert_eq!(future["longestStreak"], 4);

    let large_user = insert_test_user(&test_db.pool).await;
    sqlx::query(
        r#"
            INSERT INTO meal_entries (
              id, user_id, entry_date, status, label, sort_order,
              quantity, unit, serving_multiplier,
              protein_g, carbs_g, fat_g, calories_kcal
            )
            SELECT
              md5(gs::text || $1::text)::uuid,
              $1,
              DATE '2000-01-01' + gs,
              'eaten',
              'Synthetic history',
              0,
              1,
              'serving',
              1,
              10,
              20,
              5,
              165
            FROM generate_series(0, 4999) AS gs
            "#,
    )
    .bind(large_user)
    .execute(&test_db.pool)
    .await
    .expect("large synthetic history should insert");
    let last_date =
        (NaiveDate::from_ymd_opt(2000, 1, 1).unwrap() + Duration::days(4999)).to_string();
    let large = leaderboard_json(&test_db.pool, large_user, &last_date)
        .await
        .expect("large leaderboard should load");
    assert_eq!(large["currentStreak"], 5000);
    assert_eq!(large["longestStreak"], 5000);
    assert_eq!(large["totalDaysTracked"], 5000);

    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn list_recent_meal_entries_excludes_planned_and_skipped_entries() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let eaten_id = insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-07-03",
        "eaten",
        "Recent Eaten",
        0,
        (20.0, 30.0, 8.0, 272),
    )
    .await;
    insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-07-04",
        "planned",
        "Recent Planned",
        0,
        (20.0, 30.0, 8.0, 272),
    )
    .await;
    insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-07-05",
        "skipped",
        "Recent Skipped",
        0,
        (20.0, 30.0, 8.0, 272),
    )
    .await;

    let results = list_recent_meal_entries_json(&test_db.pool, user_id, 10, true)
        .await
        .expect("recent meals should list");
    let ids = search_result_ids(&results);

    assert_eq!(ids, vec![eaten_id.to_string()]);
    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn concurrent_owner_demotions_cannot_remove_last_owner() {
    let test_db = test_db_with_connections(4).await;
    let actor_id = insert_test_user_with_email(&test_db.pool, "owner-a@example.test").await;
    let other_owner_id = insert_test_user_with_email(&test_db.pool, "owner-b@example.test").await;
    ensure_user_role(&test_db.pool, actor_id, "owner")
        .await
        .expect("actor should become owner");
    ensure_user_role(&test_db.pool, other_owner_id, "owner")
        .await
        .expect("other user should become owner");

    let demote_actor = rpc_json(
        &test_db.pool,
        "setUserRole",
        json!({
            "actorUserId": actor_id,
            "targetUserId": actor_id,
            "nextRole": "user"
        }),
    );
    let demote_other_owner = rpc_json(
        &test_db.pool,
        "setUserRole",
        json!({
            "actorUserId": actor_id,
            "targetUserId": other_owner_id,
            "nextRole": "user"
        }),
    );
    let (actor_result, other_owner_result) = tokio::join!(demote_actor, demote_other_owner);

    let successful_demotions = [actor_result.as_ref(), other_owner_result.as_ref()]
        .into_iter()
        .filter(|result| result.is_ok())
        .count();
    assert_eq!(successful_demotions, 1);
    let owner_count: i64 =
        sqlx::query("SELECT count(*)::bigint AS count FROM users WHERE role = 'owner'")
            .fetch_one(&test_db.pool)
            .await
            .expect("owner count should query")
            .try_get("count")
            .unwrap();
    assert_eq!(owner_count, 1);

    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn set_user_role_rolls_back_role_when_audit_insert_fails() {
    let test_db = test_db().await;
    let actor_id = insert_test_user_with_email(&test_db.pool, "owner@example.test").await;
    let target_id = insert_test_user_with_email(&test_db.pool, "target@example.test").await;
    ensure_user_role(&test_db.pool, actor_id, "owner")
        .await
        .expect("actor should become owner");

    let result = rpc_json(
        &test_db.pool,
        "setUserRole",
        json!({
            "actorUserId": actor_id,
            "targetUserId": target_id,
            "nextRole": "admin",
            "testFault": {
                "kind": "admin_audit_event",
                "message": "forced audit failure"
            }
        }),
    )
    .await;

    assert_eq!(bad_request_message(result), "forced audit failure");
    let role: String = sqlx::query("SELECT role FROM users WHERE id = $1")
        .bind(target_id)
        .fetch_one(&test_db.pool)
        .await
        .expect("target role should query")
        .try_get("role")
        .unwrap();
    let audit_count: i64 = sqlx::query("SELECT count(*)::bigint AS count FROM admin_audit_events")
        .fetch_one(&test_db.pool)
        .await
        .expect("audit count should query")
        .try_get("count")
        .unwrap();
    assert_eq!(role, "user");
    assert_eq!(audit_count, 0);

    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn create_admin_barcode_product_rolls_back_product_and_revision_when_audit_fails() {
    let test_db = test_db().await;
    let actor_id = insert_test_user_with_email(&test_db.pool, "admin@example.test").await;
    ensure_user_role(&test_db.pool, actor_id, "admin")
        .await
        .expect("actor should become admin");
    let barcode = format!("admin-create-{}", Uuid::new_v4());

    let result = rpc_json(
        &test_db.pool,
        "createAdminBarcodeProduct",
        json!({
            "actorUserId": actor_id,
            "input": barcode_payload(&barcode),
            "testFault": {
                "kind": "admin_audit_event",
                "message": "forced audit failure"
            }
        }),
    )
    .await;

    assert_eq!(bad_request_message(result), "forced audit failure");
    assert_no_barcode_product_or_revision_rows(&test_db.pool, &barcode).await;

    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn update_admin_barcode_product_rolls_back_product_when_revision_fails() {
    let test_db = test_db().await;
    let actor_id = insert_test_user_with_email(&test_db.pool, "admin-update@example.test").await;
    ensure_user_role(&test_db.pool, actor_id, "admin")
        .await
        .expect("actor should become admin");
    let product_id = insert_test_admin_barcode_product(
        &test_db.pool,
        "admin-update-original",
        "Original Bar",
        "Original Brand",
        Some(actor_id),
        false,
    )
    .await;

    let result = rpc_json(
        &test_db.pool,
        "updateAdminBarcodeProduct",
        json!({
            "actorUserId": actor_id,
            "barcodeProductId": product_id,
            "input": barcode_payload("admin-update-next"),
            "testFault": {
                "kind": "food_product_revision",
                "message": "forced revision failure"
            }
        }),
    )
    .await;

    assert_eq!(bad_request_message(result), "forced revision failure");
    let row = sqlx::query("SELECT barcode, name FROM food_products WHERE id = $1")
        .bind(product_id)
        .fetch_one(&test_db.pool)
        .await
        .expect("product should query");
    assert_eq!(
        row.try_get::<String, _>("barcode").unwrap(),
        "admin-update-original"
    );
    assert_eq!(row.try_get::<String, _>("name").unwrap(), "Original Bar");

    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn delete_admin_barcode_product_rolls_back_product_when_audit_fails() {
    let test_db = test_db().await;
    let actor_id = insert_test_user_with_email(&test_db.pool, "admin-delete@example.test").await;
    ensure_user_role(&test_db.pool, actor_id, "admin")
        .await
        .expect("actor should become admin");
    let product_id = insert_test_admin_barcode_product(
        &test_db.pool,
        "admin-delete-original",
        "Delete Bar",
        "Delete Brand",
        Some(actor_id),
        false,
    )
    .await;

    let result = rpc_json(
        &test_db.pool,
        "softDeleteAdminBarcodeProduct",
        json!({
            "actorUserId": actor_id,
            "barcodeProductId": product_id,
            "testFault": {
                "kind": "admin_audit_event",
                "message": "forced audit failure"
            }
        }),
    )
    .await;

    assert_eq!(bad_request_message(result), "forced audit failure");
    let deleted_at: Option<DateTime<Utc>> =
        sqlx::query("SELECT deleted_at FROM food_products WHERE id = $1")
            .bind(product_id)
            .fetch_one(&test_db.pool)
            .await
            .expect("product should query")
            .try_get("deleted_at")
            .unwrap();
    let revision_count: i64 =
        sqlx::query("SELECT count(*)::bigint AS count FROM food_product_revisions")
            .fetch_one(&test_db.pool)
            .await
            .expect("revision count should query")
            .try_get("count")
            .unwrap();
    assert!(deleted_at.is_none());
    assert_eq!(revision_count, 0);

    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn save_barcode_food_product_rpc_creates_created_revision() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let barcode = format!("test-{}", Uuid::new_v4());

    let product = rpc_json(
        &test_db.pool,
        "saveBarcodeFoodProduct",
        json!({
            "userId": user_id,
            "input": barcode_payload(&barcode)
        }),
    )
    .await
    .expect("barcode product should save");
    let product_id = Uuid::parse_str(product.get("id").and_then(Value::as_str).unwrap())
        .expect("product id should be a uuid");

    let revision = sqlx::query(
        r#"
            SELECT actor_user_id, action, snapshot_json
            FROM food_product_revisions
            WHERE product_id = $1
            "#,
    )
    .bind(product_id)
    .fetch_one(&test_db.pool)
    .await
    .expect("created revision should exist");

    assert_eq!(
        revision.try_get::<Uuid, _>("actor_user_id").unwrap(),
        user_id
    );
    assert_eq!(revision.try_get::<String, _>("action").unwrap(), "created");
    let snapshot: Value = revision.try_get("snapshot_json").unwrap();
    assert_eq!(snapshot.get("id"), product.get("id"));
    assert_eq!(snapshot.get("barcode"), product.get("barcode"));

    test_db.cleanup().await;
}

#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn save_barcode_food_product_rolls_back_product_when_created_revision_fails() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let barcode = format!("test-{}", Uuid::new_v4());

    let result = rpc_json(
        &test_db.pool,
        "saveBarcodeFoodProduct",
        json!({
            "userId": user_id,
            "input": barcode_payload(&barcode),
            "testFault": {
                "kind": "barcode_food_product_revision",
                "message": "forced revision failure"
            }
        }),
    )
    .await;

    assert_eq!(bad_request_message(result), "forced revision failure");
    assert_no_barcode_product_or_revision_rows(&test_db.pool, &barcode).await;

    test_db.cleanup().await;
}

#[test]
fn macro_goals_are_bounded_to_the_column_domain() {
    assert!(
        validate_macro_goals(&MacroGoals {
            protein_g: Some(150.0),
            carbs_g: Some(250.0),
            fat_g: Some(70.0),
            calories_kcal: Some(2200),
        })
        .is_ok()
    );

    // numeric(6, 1) overflows past 99_999.9. Onboarding writes these
    // columns directly, so the check has to reject before the UPDATE.
    assert!(
        validate_macro_goals(&MacroGoals {
            protein_g: Some(1e30),
            carbs_g: None,
            fat_g: None,
            calories_kcal: None,
        })
        .is_err()
    );
    assert!(
        validate_macro_goals(&MacroGoals {
            protein_g: Some(-1.0),
            carbs_g: None,
            fat_g: None,
            calories_kcal: None,
        })
        .is_err()
    );
    assert!(
        validate_macro_goals(&MacroGoals {
            protein_g: None,
            carbs_g: None,
            fat_g: None,
            calories_kcal: Some(-5),
        })
        .is_err()
    );
}

#[test]
fn ensure_date_string_rejects_postgres_special_dates() {
    assert!(ensure_date_string("2026-01-15").is_ok());
    assert!(ensure_date_string("2024-02-29").is_ok());

    for invalid in [
        "",
        "2026-1-5",
        "26-01-15",
        "2026-13-01",
        "2026-02-30",
        "2026-01-15T00:00:00Z",
        // Postgres accepts all of these as `date` input, stores them, and
        // then fails to re-parse on read — permanently breaking the page.
        "infinity",
        "-infinity",
        "today",
        "yesterday",
        "epoch",
        "now",
    ] {
        assert!(
            ensure_date_string(invalid).is_err(),
            "expected {invalid:?} to be rejected"
        );
    }
}

fn gym_input(pairs: &[(&str, Value)]) -> serde_json::Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect()
}

#[test]
fn gym_slot_values_validates_shape_and_minutes() {
    // Weekly slot, title defaulted, midnight end (1440) allowed.
    let values = gym_slot_values(&gym_input(&[
        ("recurrence", json!("weekly")),
        ("weekday", json!(1)),
        ("startMinute", json!(1380)),
        ("endMinute", json!(1440)),
    ]))
    .expect("weekly slot ending at midnight should validate");
    assert_eq!(values.title, "Gym");
    assert_eq!(values.weekday, Some(1));
    assert_eq!(values.slot_date, None);
    assert_eq!(values.end_minute, 1440);

    // One-off slot needs a well-formed date.
    let values = gym_slot_values(&gym_input(&[
        ("title", json!("  Push day  ")),
        ("recurrence", json!("once")),
        ("slotDate", json!("2026-09-01")),
        ("startMinute", json!(1020)),
        ("endMinute", json!(1110)),
    ]))
    .expect("one-off slot should validate");
    assert_eq!(values.title, "Push day");
    assert_eq!(values.slot_date.as_deref(), Some("2026-09-01"));
    assert_eq!(values.weekday, None);

    // Overnight (start >= end) is rejected.
    assert!(
        gym_slot_values(&gym_input(&[
            ("recurrence", json!("weekly")),
            ("weekday", json!(2)),
            ("startMinute", json!(1320)),
            ("endMinute", json!(120)),
        ]))
        .is_err()
    );
    // Weekday outside ISO 1-7 is rejected.
    assert!(
        gym_slot_values(&gym_input(&[
            ("recurrence", json!("weekly")),
            ("weekday", json!(0)),
            ("startMinute", json!(600)),
            ("endMinute", json!(660)),
        ]))
        .is_err()
    );
    // A one-off slot without a date is rejected, as is a special date.
    assert!(
        gym_slot_values(&gym_input(&[
            ("recurrence", json!("once")),
            ("startMinute", json!(600)),
            ("endMinute", json!(660)),
        ]))
        .is_err()
    );
    assert!(
        gym_slot_values(&gym_input(&[
            ("recurrence", json!("once")),
            ("slotDate", json!("today")),
            ("startMinute", json!(600)),
            ("endMinute", json!(660)),
        ]))
        .is_err()
    );
    // Unknown recurrence is rejected.
    assert!(
        gym_slot_values(&gym_input(&[
            ("recurrence", json!("biweekly")),
            ("weekday", json!(3)),
            ("startMinute", json!(600)),
            ("endMinute", json!(660)),
        ]))
        .is_err()
    );
}

#[test]
fn gym_friend_codes_use_the_unambiguous_alphabet() {
    for _ in 0..50 {
        let code = generate_gym_friend_code();
        assert_eq!(code.len(), GYM_FRIEND_CODE_LENGTH);
        for character in code.bytes() {
            assert!(
                GYM_FRIEND_CODE_ALPHABET.contains(&character),
                "unexpected friend-code character {character:?}"
            );
        }
    }
}

#[test]
fn gym_invite_identifiers_classify_and_normalize() {
    // '@' anywhere → email, lowercased.
    match classify_gym_invite_identifier("  BOB@Example.com ").unwrap() {
        GymInviteIdentifier::Email(email) => assert_eq!(email, "bob@example.com"),
        GymInviteIdentifier::FriendCode(_) => panic!("expected email"),
    }
    // No '@' → friend code, uppercased with separators stripped so
    // "ab23-cd45", "AB23 CD45" and "ab23cd45" all resolve identically.
    for raw in ["ab23-cd45", "AB23 CD45", "ab23cd45"] {
        match classify_gym_invite_identifier(raw).unwrap() {
            GymInviteIdentifier::FriendCode(code) => assert_eq!(code, "AB23CD45"),
            GymInviteIdentifier::Email(_) => panic!("expected friend code for {raw:?}"),
        }
    }
    // Empty and separator-only inputs are rejected.
    assert!(classify_gym_invite_identifier("   ").is_err());
    assert!(classify_gym_invite_identifier("---").is_err());
}

#[test]
fn gym_status_vocabulary_is_closed() {
    for status in ["going", "maybe", "skipped", "done"] {
        assert!(ensure_gym_status(status).is_ok());
    }
    for status in ["", "planned", "eaten", "Going", "skipping"] {
        assert!(
            ensure_gym_status(status).is_err(),
            "expected {status:?} to be rejected"
        );
    }
}

#[test]
fn gym_merge_overlaps_merges_per_style_and_classifies_tentative() {
    let buddy = "11111111-1111-4111-8111-111111111111";
    let other = "22222222-2222-4222-8222-222222222222";
    let rows = vec![
        // Two touching confirmed windows for the same buddy merge into one.
        json!({ "buddyId": buddy, "buddyName": "Alex", "startMinute": 600, "endMinute": 660, "tentative": false }),
        json!({ "buddyId": buddy, "buddyName": "Alex", "startMinute": 630, "endMinute": 700, "tentative": false }),
        // A tentative window never merges into a confirmed one.
        json!({ "buddyId": buddy, "buddyName": "Alex", "startMinute": 650, "endMinute": 720, "tentative": true }),
        // A buddy with only tentative windows is tentative overall.
        json!({ "buddyId": other, "buddyName": "Sam", "startMinute": 800, "endMinute": 860, "tentative": true }),
    ];
    let merged = gym_merge_overlaps(&rows);
    let entries = merged.as_array().expect("merged overlaps are an array");
    assert_eq!(entries.len(), 2);

    let alex = &entries[0];
    assert_eq!(alex["buddy"]["name"], json!("Alex"));
    assert_eq!(alex["tentative"], json!(false));
    let windows = alex["windows"].as_array().unwrap();
    assert_eq!(windows.len(), 2);
    assert_eq!(windows[0]["startMinute"], json!(600));
    assert_eq!(windows[0]["endMinute"], json!(700));
    assert_eq!(windows[0]["tentative"], json!(false));
    assert_eq!(windows[1]["tentative"], json!(true));

    let sam = &entries[1];
    assert_eq!(sam["tentative"], json!(true));

    assert_eq!(gym_merge_overlaps(&[]), json!([]));
}

#[test]
fn required_date_rejects_special_dates_on_the_rpc_path() {
    let payload = serde_json::Map::from_iter([("date".to_string(), json!("infinity"))]);
    assert!(required_date(&payload, "date").is_err());

    let payload = serde_json::Map::from_iter([("date".to_string(), json!("2026-01-15"))]);
    assert_eq!(
        required_date(&payload, "date").expect("valid date"),
        "2026-01-15"
    );
}

#[test]
fn optional_f64_rejects_non_finite_strings() {
    for raw in ["inf", "-inf", "NaN", "infinity"] {
        let payload = serde_json::Map::from_iter([("weightKg".to_string(), json!(raw))]);
        assert_eq!(
            optional_f64(&payload, "weightKg"),
            None,
            "expected {raw:?} to be rejected"
        );
    }

    let payload = serde_json::Map::from_iter([("weightKg".to_string(), json!("72.5"))]);
    assert_eq!(optional_f64(&payload, "weightKg"), Some(72.5));
}

#[test]
fn macros_are_bounded_to_the_column_domain() {
    // numeric(6, 1) overflows past 99_999.9; without this bound the INSERT
    // raises numeric-field-overflow and the caller gets a 500.
    let payload = meal_payload(&[("proteinG", json!(1e30))]);
    assert!(normalize_meal_food_values(&payload, 0, "Meal name is required.").is_err());

    let payload = meal_payload(&[("proteinG", json!(MAX_MACRO_GRAMS))]);
    assert!(normalize_meal_food_values(&payload, 0, "Meal name is required.").is_ok());
}

#[test]
fn quantities_are_bounded_to_the_column_domain() {
    let payload = meal_payload(&[("quantity", json!(1e12))]);
    assert!(normalize_meal_food_values(&payload, 0, "Meal name is required.").is_err());
}

#[test]
fn goal_weight_is_bounded_after_rounding() {
    assert_eq!(
        validate_goal_weight_kg(None).expect("none is allowed"),
        None
    );
    assert_eq!(
        validate_goal_weight_kg(Some(72.456)).expect("valid"),
        Some(72.46)
    );
    assert!(validate_goal_weight_kg(Some(-1.0)).is_err());
    assert!(validate_goal_weight_kg(Some(1e30)).is_err());
    // Rounds up into overflow for numeric(5, 2), so it must be rejected.
    assert!(validate_goal_weight_kg(Some(999.995)).is_err());
}

#[test]
fn search_queries_are_capped() {
    assert!(validate_search_query("chicken breast").is_ok());
    assert!(validate_search_query(&"a".repeat(MAX_SEARCH_QUERY_LENGTH)).is_ok());
    assert!(validate_search_query(&"a".repeat(MAX_SEARCH_QUERY_LENGTH + 1)).is_err());

    let too_many_terms = ["term"; MAX_SEARCH_TERMS + 1].join(" ");
    assert!(validate_search_query(&too_many_terms).is_err());
}

#[test]
fn search_like_patterns_never_exceed_the_term_cap() {
    let query = vec!["term"; 100].join(" ");
    assert_eq!(search_like_patterns(&query).len(), MAX_SEARCH_TERMS);
}

#[test]
fn meal_template_and_recipe_item_validation_rejects_invalid_payloads() {
    assert_eq!(
        bad_request_message(normalize_meal_food_values(
            &meal_payload(&[("label", json!("   "))]),
            0,
            "Meal name is required.",
        )),
        "Meal name is required."
    );
    assert_eq!(
        bad_request_message(normalize_meal_food_values(
            &meal_payload(&[("quantity", json!(0))]),
            0,
            "Meal name is required.",
        )),
        "Quantity must be a positive number."
    );
    assert_eq!(
        bad_request_message(normalize_meal_food_values(
            &meal_payload(&[("unit", json!("oz"))]),
            0,
            "Meal name is required.",
        )),
        "Quantity unit is invalid."
    );
    assert_eq!(
        bad_request_message(normalize_meal_food_values(
            &meal_payload(&[("servingMultiplier", json!(0))]),
            0,
            "Meal name is required.",
        )),
        "Serving multiplier must be a positive number."
    );
    assert_eq!(
        bad_request_message(normalize_meal_food_values(
            &meal_payload(&[
                ("proteinG", json!(0)),
                ("carbsG", json!(0)),
                ("fatG", json!(0)),
                ("caloriesKcal", json!(0)),
            ]),
            0,
            "Meal name is required.",
        )),
        "At least one macro or calorie value must be greater than zero."
    );
}

#[test]
fn meal_validation_rejects_overflowing_integer_fields() {
    assert_eq!(
        bad_request_message(normalize_meal_food_values(
            &meal_payload(&[("caloriesKcal", json!(4_294_967_296_u64))]),
            0,
            "Meal name is required.",
        )),
        "caloriesKcal must be a non-negative integer."
    );
}

#[test]
fn food_and_barcode_validation_rejects_invalid_payloads() {
    assert_eq!(
        bad_request_message(normalize_food_product_input(
            &food_payload(&[("name", json!(" "))]),
            "personal",
        )),
        "Product name is required."
    );
    assert_eq!(
        bad_request_message(normalize_food_product_input(
            &food_payload(&[("defaultServingQuantity", json!(0))]),
            "personal",
        )),
        "Default serving quantity must be a positive number."
    );
    assert_eq!(
        bad_request_message(normalize_food_product_input(
            &food_payload(&[("sourceConfidence", json!(1.1))]),
            "personal",
        )),
        "Source confidence must be between 0 and 1."
    );
    assert_eq!(
        bad_request_message(normalize_barcode_food_product_input(
            &serde_json::Map::from_iter([
                ("barcode".to_string(), json!("123")),
                ("name".to_string(), json!("Bar")),
                ("servingSizeG".to_string(), json!(0)),
                ("proteinG".to_string(), json!(1)),
                ("carbsG".to_string(), json!(1)),
                ("fatG".to_string(), json!(1)),
                ("caloriesKcal".to_string(), json!(10)),
            ])
        )),
        "Serving weight must be a positive number."
    );
}

#[test]
fn only_admin_and_owner_roles_are_admin_actors() {
    assert!(is_admin_actor_role("admin"));
    assert!(is_admin_actor_role("owner"));
    assert!(!is_admin_actor_role("user"));
    assert!(!is_admin_actor_role(""));
}

/// Applies every Drizzle migration into one scratch schema and `SCHEMA_SQL`
/// into another, then compares the resulting catalogs. This is what stops
/// the integration-test schema from drifting away from the migrations that
/// production actually runs - the CLEAN-03 hazard.
///
/// Migrations schema-qualify some references as `"public"."x"`, which would
/// escape the scratch schema, so that qualifier is stripped before applying.
/// That is the only rewrite performed.
#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
#[tokio::test]
async fn schema_sql_matches_the_drizzle_migrations() {
    async fn columns_of(
        conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
        schema: &str,
    ) -> Vec<(String, String, String, String)> {
        sqlx::query_as::<_, (String, String, String, String)>(
            r#"
                SELECT table_name::text, column_name::text, data_type::text, is_nullable::text
                FROM information_schema.columns
                WHERE table_schema = $1
                ORDER BY table_name, column_name
                "#,
        )
        .bind(schema)
        .fetch_all(&mut **conn)
        .await
        .expect("catalog query should succeed")
    }

    let database_url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .expect("TEST_DATABASE_URL or DATABASE_URL must be set");
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("parity pool should connect");

    let migrated = format!("parity_migrated_{}", Uuid::new_v4().simple());
    let declared = format!("parity_declared_{}", Uuid::new_v4().simple());

    let mut conn = pool
        .acquire()
        .await
        .expect("parity connection should acquire");
    for schema in [&migrated, &declared] {
        sqlx::query(&format!(r#"CREATE SCHEMA "{schema}""#))
            .execute(&mut *conn)
            .await
            .expect("scratch schema should be created");
    }

    // 0014 creates pg_trgm opportunistically. Two things bite here: left to
    // itself the extension lands in whatever schema is first on search_path
    // (a scratch one), and if a previous run already installed it elsewhere
    // then `IF NOT EXISTS` silently no-ops rather than relocating it - so
    // `gin_trgm_ops` fails to resolve either way. Install it if missing, then
    // resolve wherever it actually lives and put that on the search_path.
    sqlx::query("CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public")
        .execute(&mut *conn)
        .await
        .expect("pg_trgm should be installable for the parity check");
    let trgm_schema: String = sqlx::query_scalar(
        "SELECT n.nspname::text FROM pg_extension e
             JOIN pg_namespace n ON n.oid = e.extnamespace
             WHERE e.extname = 'pg_trgm'",
    )
    .fetch_one(&mut *conn)
    .await
    .expect("pg_trgm should be present after creation");

    // Apply the migrations, in journal order, into the first scratch schema.
    let drizzle_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/db/drizzle");
    sqlx::query(&format!(
        r#"SET search_path TO "{migrated}", "{trgm_schema}", public"#
    ))
    .execute(&mut *conn)
    .await
    .expect("search_path should be set");
    for (tag, _) in expected_drizzle_migrations().expect("journal should parse") {
        let sql = fs::read_to_string(drizzle_dir.join(format!("{tag}.sql")))
            .unwrap_or_else(|error| panic!("migration {tag} should be readable: {error}"));
        let sql = sql.replace("\"public\".", "");
        for statement in sql.split("--> statement-breakpoint") {
            if statement.trim().is_empty() {
                continue;
            }
            sqlx::raw_sql(statement)
                .execute(&mut *conn)
                .await
                .unwrap_or_else(|error| panic!("migration {tag} should apply: {error}"));
        }
    }

    // Apply SCHEMA_SQL into the second.
    sqlx::query(&format!(
        r#"SET search_path TO "{declared}", "{trgm_schema}", public"#
    ))
    .execute(&mut *conn)
    .await
    .expect("search_path should be set");
    sqlx::raw_sql(SCHEMA_SQL)
        .execute(&mut *conn)
        .await
        .expect("SCHEMA_SQL should apply");

    let migrated_columns = columns_of(&mut conn, &migrated).await;
    let declared_columns = columns_of(&mut conn, &declared).await;

    for schema in [&migrated, &declared] {
        sqlx::query(&format!(r#"DROP SCHEMA "{schema}" CASCADE"#))
            .execute(&mut *conn)
            .await
            .expect("scratch schema should drop");
    }

    let only_in_migrations = migrated_columns
        .iter()
        .filter(|column| !declared_columns.contains(column))
        .collect::<Vec<_>>();
    let only_in_schema_sql = declared_columns
        .iter()
        .filter(|column| !migrated_columns.contains(column))
        .collect::<Vec<_>>();

    assert!(
        only_in_migrations.is_empty() && only_in_schema_sql.is_empty(),
        "SCHEMA_SQL has drifted from the Drizzle migrations.\n\
             Present in the migrations but missing/different in SCHEMA_SQL: {only_in_migrations:#?}\n\
             Present in SCHEMA_SQL but missing/different in the migrations: {only_in_schema_sql:#?}"
    );
}

#[test]
fn expected_drizzle_migrations_match_repo_sql_files() {
    let expected = expected_drizzle_migrations().expect("journal should parse");
    let expected_tags = expected
        .iter()
        .map(|(tag, _)| tag.as_str())
        .collect::<HashSet<_>>();
    let drizzle_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/db/drizzle");
    let sql_tags = fs::read_dir(&drizzle_dir)
        .expect("drizzle migrations dir should exist")
        .filter_map(|entry| {
            let entry = entry.expect("migration dir entry should be readable");
            let path = entry.path();
            (path.extension().and_then(|ext| ext.to_str()) == Some("sql"))
                .then(|| path.file_stem().unwrap().to_string_lossy().into_owned())
        })
        .collect::<HashSet<_>>();

    assert_eq!(expected_tags.len(), sql_tags.len());
    for tag in &sql_tags {
        assert!(
            expected_tags.contains(tag.as_str()),
            "migration journal is missing SQL migration {tag}"
        );
    }
    let latest = expected.last().expect("at least one migration is expected");
    assert!(
        sql_tags.contains(latest.0.as_str()),
        "latest expected migration must have a SQL file"
    );
}

fn shoo_profile(sub: &str, email: &str) -> ShooProfile {
    ShooProfile {
        pairwise_sub: sub.to_string(),
        email: email.to_string(),
        display_name: Some("Test User".to_string()),
        picture_url: None,
    }
}

#[tokio::test]
#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
async fn shoo_login_refuses_to_rebind_an_existing_email_to_a_new_subject() {
    let test_db = test_db().await;
    let victim_id = insert_test_user_with_email(&test_db.pool, "victim@example.test").await;
    let original_sub: String = sqlx::query("SELECT shoo_pairwise_sub FROM users WHERE id = $1")
        .bind(victim_id)
        .fetch_one(&test_db.pool)
        .await
        .expect("victim should exist")
        .try_get("shoo_pairwise_sub")
        .expect("sub should read");

    let result = upsert_user_from_shoo_profile(
        &test_db.pool,
        &shoo_profile("attacker-sub", "victim@example.test"),
    )
    .await;

    match result {
        Err(AppError::Conflict(message)) => {
            assert!(
                !message.contains("victim@example.test"),
                "conflict message must not echo the address back: {message}"
            );
        }
        Err(error) => panic!("expected a conflict, got {error:?}"),
        Ok(_) => panic!("expected a conflict, got a successful login"),
    }

    let stored_sub: String = sqlx::query("SELECT shoo_pairwise_sub FROM users WHERE id = $1")
        .bind(victim_id)
        .fetch_one(&test_db.pool)
        .await
        .expect("victim should still exist")
        .try_get("shoo_pairwise_sub")
        .expect("sub should read");
    assert_eq!(
        stored_sub, original_sub,
        "the victim row must keep its original subject"
    );
    let user_count: i64 = sqlx::query("SELECT count(*) AS total FROM users")
        .fetch_one(&test_db.pool)
        .await
        .expect("count should run")
        .try_get("total")
        .expect("count should read");
    assert_eq!(user_count, 1, "no shadow account may be created either");

    test_db.cleanup().await;
}

#[tokio::test]
#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
async fn shoo_login_updates_the_email_of_a_known_subject() {
    let test_db = test_db().await;
    let created = upsert_user_from_shoo_profile(
        &test_db.pool,
        &shoo_profile("stable-sub", "before@example.test"),
    )
    .await
    .expect("first login should create the account");

    let updated = upsert_user_from_shoo_profile(
        &test_db.pool,
        &shoo_profile("stable-sub", "after@example.test"),
    )
    .await
    .expect("a known subject may change its email");

    assert_eq!(updated.id, created.id, "row identity must be preserved");
    assert_eq!(updated.email, "after@example.test");
    assert_eq!(updated.shoo_pairwise_sub, "stable-sub");

    test_db.cleanup().await;
}

#[tokio::test]
#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
async fn shoo_login_refuses_to_move_a_known_subject_onto_a_taken_email() {
    let test_db = test_db().await;
    let victim = upsert_user_from_shoo_profile(
        &test_db.pool,
        &shoo_profile("victim-sub", "victim@example.test"),
    )
    .await
    .expect("victim account should be created");
    upsert_user_from_shoo_profile(
        &test_db.pool,
        &shoo_profile("attacker-sub", "attacker@example.test"),
    )
    .await
    .expect("attacker account should be created");

    // The subject matches an existing row, so the update path runs and the
    // `users_email_key` violation must surface as a conflict, not a 500.
    let result = upsert_user_from_shoo_profile(
        &test_db.pool,
        &shoo_profile("attacker-sub", "victim@example.test"),
    )
    .await;
    assert!(
        matches!(result, Err(AppError::Conflict(_))),
        "expected a conflict, got {result:?}"
    );

    let victim_email: String = sqlx::query("SELECT email FROM users WHERE id = $1")
        .bind(victim.id)
        .fetch_one(&test_db.pool)
        .await
        .expect("victim should still exist")
        .try_get("email")
        .expect("email should read");
    assert_eq!(victim_email, "victim@example.test");

    test_db.cleanup().await;
}

#[tokio::test]
#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
async fn shoo_login_creates_a_user_for_an_unused_subject_and_email() {
    let test_db = test_db().await;
    let created = upsert_user_from_shoo_profile(
        &test_db.pool,
        &shoo_profile("fresh-sub", "fresh@example.test"),
    )
    .await
    .expect("a brand-new subject should create an account");
    assert_eq!(created.shoo_pairwise_sub, "fresh-sub");
    assert_eq!(created.email, "fresh@example.test");

    test_db.cleanup().await;
}

#[tokio::test]
#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
async fn product_linked_meal_writes_are_bounded_like_the_manual_path() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let product_id =
        insert_test_food_product(&test_db.pool, Some(user_id), "Oats", "Brand", None).await;

    // DATA-01: the product path never applied MAX_QUANTITY, so this reached
    // the INSERT and came back as a numeric-overflow 500.
    let result = rpc_json(
        &test_db.pool,
        "createMealEntry",
        json!({
            "userId": user_id,
            "input": {
                "date": "2026-01-01",
                "productId": product_id,
                "unit": "g",
                "quantity": 1e12,
            }
        }),
    )
    .await;
    assert!(
        matches!(result, Err(AppError::BadRequest(_))),
        "expected a 400 for an out-of-range quantity, got {result:?}"
    );

    // Same for the macro columns. Creates always recalculate from the
    // product, so the overflow arrives as `per-100 value x quantity` rather
    // than as a client-supplied macro.
    let dense_product_id = Uuid::new_v4();
    sqlx::query(
        r#"
            INSERT INTO food_products (
              id, owner_user_id, scope, source, name, brand,
              default_serving_quantity, default_serving_unit,
              protein_per_100, carbs_per_100, fat_per_100, calories_per_100
            )
            VALUES ($1, $2, 'personal', 'manual', 'Dense', '', 100, 'g', 9999.99, 1, 1, 900)
            "#,
    )
    .bind(dense_product_id)
    .bind(user_id)
    .execute(&test_db.pool)
    .await
    .expect("dense product should insert");

    let result = rpc_json(
        &test_db.pool,
        "createMealEntry",
        json!({
            "userId": user_id,
            "input": {
                "date": "2026-01-01",
                "productId": dense_product_id,
                "unit": "g",
                "quantity": 500_000,
            }
        }),
    )
    .await;
    assert!(
        matches!(result, Err(AppError::BadRequest(_))),
        "expected a 400 for out-of-range macros, got {result:?}"
    );

    let stored: i64 = sqlx::query("SELECT count(*) AS total FROM meal_entries")
        .fetch_one(&test_db.pool)
        .await
        .expect("count should run")
        .try_get("total")
        .expect("count should read");
    assert_eq!(stored, 0, "no out-of-range row may reach the table");

    test_db.cleanup().await;
}

#[tokio::test]
#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
async fn preserved_product_snapshots_cannot_write_negative_macros() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let product_id =
        insert_test_food_product(&test_db.pool, Some(user_id), "Oats", "Brand", None).await;
    let created = rpc_json(
        &test_db.pool,
        "createMealEntry",
        json!({
            "userId": user_id,
            "input": {
                "date": "2026-01-01",
                "productId": product_id,
                "unit": "serving",
                "quantity": 1,
            }
        }),
    )
    .await
    .expect("baseline product-linked entry should be created");
    let entry_id = created
        .get("id")
        .and_then(Value::as_str)
        .expect("created entry should carry an id")
        .to_string();
    let before: i32 = sqlx::query("SELECT calories_kcal FROM meal_entries WHERE id = $1::uuid")
        .bind(&entry_id)
        .fetch_one(&test_db.pool)
        .await
        .expect("entry should exist")
        .try_get("calories_kcal")
        .expect("calories should read");

    let result = rpc_json(
        &test_db.pool,
        "updateMealEntry",
        json!({
            "userId": user_id,
            "entryId": entry_id,
            "input": {
                "date": "2026-01-01",
                "productId": product_id,
                "unit": "serving",
                "quantity": 1,
                "proteinG": 1.0,
                "carbsG": 1.0,
                "fatG": 1.0,
                "caloriesKcal": -2000000000,
                "__recalculateProductMacros": false,
            }
        }),
    )
    .await;
    assert!(
        matches!(result, Err(AppError::BadRequest(_))),
        "expected a 400 for negative calories, got {result:?}"
    );

    // The same preserved-snapshot path must also respect the upper bounds.
    let result = rpc_json(
        &test_db.pool,
        "updateMealEntry",
        json!({
            "userId": user_id,
            "entryId": entry_id,
            "input": {
                "date": "2026-01-01",
                "productId": product_id,
                "unit": "serving",
                "quantity": 1,
                "proteinG": 1.0e9,
                "carbsG": 1.0,
                "fatG": 1.0,
                "caloriesKcal": 100,
                "__recalculateProductMacros": false,
            }
        }),
    )
    .await;
    assert!(
        matches!(result, Err(AppError::BadRequest(_))),
        "expected a 400 for out-of-range macros, got {result:?}"
    );

    let after: i32 = sqlx::query("SELECT calories_kcal FROM meal_entries WHERE id = $1::uuid")
        .bind(&entry_id)
        .fetch_one(&test_db.pool)
        .await
        .expect("entry should still exist")
        .try_get("calories_kcal")
        .expect("calories should read");
    assert_eq!(after, before, "the stored row must be unchanged");

    test_db.cleanup().await;
}

#[tokio::test]
#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
async fn calories_are_bounded_to_the_column_domain() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;

    let result = rpc_json(
        &test_db.pool,
        "createMealEntry",
        json!({
            "userId": user_id,
            "input": meal_payload(&[("caloriesKcal", json!(2_000_000_000i64))]),
        }),
    )
    .await;
    assert!(
        matches!(result, Err(AppError::BadRequest(_))),
        "expected a 400 for an absurd caloriesKcal, got {result:?}"
    );

    // The same unbounded helper fed `caloriesPer100`, which lands in the
    // shared catalogue every other account searches.
    let result = rpc_json(
        &test_db.pool,
        "createPersonalFoodProduct",
        json!({
            "userId": user_id,
            "input": food_payload(&[("caloriesPer100", json!(2_000_000_000i64))]),
        }),
    )
    .await;
    assert!(
        matches!(result, Err(AppError::BadRequest(_))),
        "expected a 400 for an absurd caloriesPer100, got {result:?}"
    );

    test_db.cleanup().await;
}

#[tokio::test]
#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
async fn calorie_aggregates_survive_rows_that_predate_the_bound() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    // Written straight to the table: these are the rows the old unbounded
    // path could already have stored. Every aggregate must still answer.
    for sort_order in 0..2 {
        insert_test_meal_entry(
            &test_db.pool,
            user_id,
            "2026-01-01",
            "eaten",
            "Legacy",
            sort_order,
            (1.0, 1.0, 1.0, 2_000_000_000),
        )
        .await;
    }

    for op in [
        "getDailySummary",
        "getDashboardData",
        "getRecentDailyOverviews",
        "getStatsPageData",
        "getLeaderboardStats",
    ] {
        let result = rpc_json(
            &test_db.pool,
            op,
            json!({
                "userId": user_id,
                "date": "2026-01-01",
                "selectedDate": "2026-01-01",
                "today": "2026-01-01",
                "referenceDate": "2026-01-01",
            }),
        )
        .await;
        assert!(result.is_ok(), "{op} must not overflow: {result:?}");
    }

    test_db.cleanup().await;
}

#[tokio::test]
#[cfg_attr(
    not(has_test_database),
    ignore = "requires TEST_DATABASE_URL or DATABASE_URL"
)]
async fn stats_page_reports_the_same_streaks_as_the_leaderboard() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    // A closed 3-day streak, a gap, then a 4-day streak ending yesterday —
    // so `currentStreak` uses the one-day grace the leaderboard allows.
    for (index, date) in [
        "2026-01-01",
        "2026-01-02",
        "2026-01-03",
        "2026-01-08",
        "2026-01-09",
        "2026-01-10",
        "2026-01-11",
    ]
    .iter()
    .enumerate()
    {
        insert_test_meal_entry(
            &test_db.pool,
            user_id,
            date,
            "eaten",
            "Oats",
            index as i32,
            (10.0, 20.0, 5.0, 165),
        )
        .await;
    }

    let stats = rpc_json(
        &test_db.pool,
        "getStatsPageData",
        json!({ "userId": user_id, "today": "2026-01-12" }),
    )
    .await
    .expect("stats page data should load");
    let leaderboard = rpc_json(
        &test_db.pool,
        "getLeaderboardStats",
        json!({ "userId": user_id, "referenceDate": "2026-01-12" }),
    )
    .await
    .expect("leaderboard should load");

    assert_eq!(
        stats.get("currentStreak"),
        leaderboard.get("currentStreak"),
        "the Summary page must not report a different streak from the leaderboard"
    );
    assert_eq!(stats.get("longestStreak"), leaderboard.get("longestStreak"));
    assert_eq!(stats.get("currentStreak").and_then(Value::as_i64), Some(4));
    assert_eq!(stats.get("longestStreak").and_then(Value::as_i64), Some(4));

    test_db.cleanup().await;
}

mod api_tokens;
mod weight;
