use crate::{
    errors::{AppError, AppResult},
    types::{AppUser, MacroGoals, ShooProfile},
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Postgres, Row, postgres::PgRow};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Clone, Debug)]
struct AdminActor {
    id: Uuid,
    role: String,
}

#[derive(Clone, Debug)]
struct MacroValues {
    protein: f64,
    carbs: f64,
    fat: f64,
    calories: i32,
}

#[derive(Clone, Debug)]
struct FoodProductValues {
    scope: String,
    source: String,
    barcode: Option<String>,
    name: String,
    brand: String,
    default_serving_quantity: f64,
    default_serving_unit: String,
    macros: MacroValues,
    serving_weight_g: Option<f64>,
    serving_volume_ml: Option<f64>,
    source_provider: Option<String>,
    source_confidence: Option<f64>,
    source_metadata: Value,
    corrected_from_product_id: Option<Uuid>,
}

#[derive(Clone, Debug)]
struct MealFoodValues {
    product_id: Option<Uuid>,
    label: String,
    quantity: f64,
    unit: String,
    serving_multiplier: f64,
    macros: MacroValues,
}

#[derive(Clone, Debug)]
struct WeightEntryValues {
    date: String,
    weight_kg: f64,
    body_fat_pct: Option<f64>,
    notes: Option<String>,
}

const API_SCOPE_VALUES: &[&str] = &[
    "read:account",
    "read:daily",
    "write:daily",
    "read:foods",
    "write:foods",
    "read:templates",
    "write:templates",
    "read:recipes",
    "write:recipes",
    "read:weight",
    "write:weight",
    "read:goals",
    "write:goals",
    "read:stats",
];

// Retained only as a temporary parity reference during the Rust port. Startup
// must rely on Drizzle migrations, not this ad-hoc schema bootstrap.
#[allow(dead_code)]
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
  preferred_weight_unit text DEFAULT 'kg' NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_shoo_pairwise_sub_key ON users USING btree (shoo_pairwise_sub);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users USING btree (email);

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
  actor_user_id uuid NOT NULL REFERENCES users(id),
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
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS meal_entries_user_date_idx ON meal_entries USING btree (user_id, entry_date);
CREATE INDEX IF NOT EXISTS meal_entries_user_date_status_idx ON meal_entries USING btree (user_id, entry_date, status);
CREATE INDEX IF NOT EXISTS meal_entries_meal_group_idx ON meal_entries USING btree (meal_group_id);
CREATE INDEX IF NOT EXISTS meal_entries_product_idx ON meal_entries USING btree (product_id);
CREATE UNIQUE INDEX IF NOT EXISTS meal_entries_user_client_mutation_key ON meal_entries USING btree (user_id, client_mutation_id);
CREATE INDEX IF NOT EXISTS meal_entries_user_date_sort_idx ON meal_entries USING btree (user_id, entry_date, sort_order);
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
"#;

const DRIZZLE_MIGRATION_JOURNAL: &str =
    include_str!("../../../packages/db/drizzle/meta/_journal.json");
const DEFAULT_MEAL_GROUP_LABELS: [&str; 4] = ["Breakfast", "Lunch", "Dinner", "Snack"];
const REQUIRED_TABLES: &[&str] = &[
    "users",
    "api_tokens",
    "admin_audit_events",
    "food_products",
    "food_product_revisions",
    "meal_groups",
    "meal_entries",
    "weight_entries",
    "recipes",
    "recipe_ingredients",
    "meal_templates",
    "meal_template_items",
];

fn expected_drizzle_migrations() -> AppResult<Vec<(String, i64)>> {
    let journal: Value = serde_json::from_str(DRIZZLE_MIGRATION_JOURNAL).map_err(|error| {
        AppError::Anyhow(anyhow::anyhow!(
            "failed to parse Drizzle migration journal: {error}"
        ))
    })?;
    let entries = journal
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::Anyhow(anyhow::anyhow!(
                "Drizzle migration journal is missing entries"
            ))
        })?;

    entries
        .iter()
        .map(|entry| {
            let tag = entry
                .get("tag")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AppError::Anyhow(anyhow::anyhow!(
                        "Drizzle migration journal entry is missing tag"
                    ))
                })?
                .to_string();
            let created_at = entry.get("when").and_then(Value::as_i64).ok_or_else(|| {
                AppError::Anyhow(anyhow::anyhow!(
                    "Drizzle migration journal entry {tag} is missing timestamp"
                ))
            })?;
            Ok((tag, created_at))
        })
        .collect()
}

pub async fn verify_schema_ready(pool: &PgPool) -> AppResult<()> {
    let migration_table_exists: bool = sqlx::query(
        r#"
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'drizzle'
            AND table_name = '__drizzle_migrations'
        ) AS exists
        "#,
    )
    .fetch_one(pool)
    .await?
    .try_get("exists")?;

    if !migration_table_exists {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "database migrations have not been applied; run `pnpm --filter @macro-tracker/db db:migrate` before starting the Rust backend"
        )));
    }

    let expected_migrations = expected_drizzle_migrations()?;
    let expected_migration_count = expected_migrations.len() as i64;
    let (latest_migration_tag, latest_migration_created_at) = expected_migrations
        .last()
        .ok_or_else(|| AppError::Anyhow(anyhow::anyhow!("no Drizzle migrations are expected")))?;
    let migration_row = sqlx::query(
        r#"
        SELECT
          COUNT(*)::bigint AS count,
          COALESCE(bool_or(created_at = $1), false) AS has_latest
        FROM drizzle.__drizzle_migrations
        "#,
    )
    .bind(*latest_migration_created_at)
    .fetch_one(pool)
    .await?;
    let migration_count: i64 = migration_row.try_get("count")?;
    let has_latest_migration: bool = migration_row.try_get("has_latest")?;
    if migration_count < expected_migration_count || !has_latest_migration {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "database migrations are incomplete ({migration_count}/{expected_migration_count}; missing latest {latest_migration_tag}); run `pnpm --filter @macro-tracker/db db:migrate` before starting the Rust backend"
        )));
    }

    let rows = sqlx::query(
        r#"
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        "#,
    )
    .fetch_all(pool)
    .await?;
    let existing = rows
        .iter()
        .filter_map(|row| row.try_get::<String, _>("table_name").ok())
        .collect::<HashSet<_>>();
    let missing = REQUIRED_TABLES
        .iter()
        .copied()
        .filter(|table| !existing.contains(*table))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "database schema is missing required tables: {}; run `pnpm --filter @macro-tracker/db db:migrate` before starting the Rust backend",
            missing.join(", ")
        )));
    }

    Ok(())
}

pub async fn get_user_by_id(pool: &PgPool, user_id: Uuid) -> AppResult<Option<AppUser>> {
    let row = sqlx::query(
        r#"
        SELECT
          id,
          email,
          shoo_pairwise_sub,
          display_name,
          picture_url,
          role,
          created_at,
          last_login_at,
          goal_calories_kcal,
          goal_protein_g::float8 AS goal_protein_g,
          goal_carbs_g::float8 AS goal_carbs_g,
          goal_fat_g::float8 AS goal_fat_g,
          goal_weight_kg::float8 AS goal_weight_kg,
          onboarding_completed_at,
          preferred_weight_unit
        FROM users
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    row.map(row_to_app_user).transpose()
}

pub async fn ensure_user_role(pool: &PgPool, user_id: Uuid, role: &str) -> AppResult<AppUser> {
    ensure_user_role_with_executor(pool, user_id, role).await
}

async fn ensure_user_role_with_executor<'e, E>(
    executor: E,
    user_id: Uuid,
    role: &str,
) -> AppResult<AppUser>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let row = sqlx::query(
        r#"
        UPDATE users
        SET role = $2
        WHERE id = $1
        RETURNING
          id,
          email,
          shoo_pairwise_sub,
          display_name,
          picture_url,
          role,
          created_at,
          last_login_at,
          goal_calories_kcal,
          goal_protein_g::float8 AS goal_protein_g,
          goal_carbs_g::float8 AS goal_carbs_g,
          goal_fat_g::float8 AS goal_fat_g,
          goal_weight_kg::float8 AS goal_weight_kg,
          onboarding_completed_at,
          preferred_weight_unit
        "#,
    )
    .bind(user_id)
    .bind(role)
    .fetch_one(executor)
    .await?;

    row_to_app_user(row)
}

pub async fn upsert_user_from_shoo_profile(
    pool: &PgPool,
    profile: &ShooProfile,
) -> AppResult<AppUser> {
    let user_id = Uuid::new_v4();
    if let Some(existing) = sqlx::query(
        r#"
        SELECT id
        FROM users
        WHERE shoo_pairwise_sub = $1 OR email = $2
        ORDER BY CASE WHEN shoo_pairwise_sub = $1 THEN 0 ELSE 1 END
        LIMIT 1
        "#,
    )
    .bind(&profile.pairwise_sub)
    .bind(&profile.email)
    .fetch_optional(pool)
    .await?
    {
        let id: Uuid = existing.try_get("id")?;
        let row = sqlx::query(
            r#"
            UPDATE users
            SET
              shoo_pairwise_sub = $2,
              email = $3,
              display_name = $4,
              picture_url = $5,
              last_login_at = now()
            WHERE id = $1
            RETURNING
              id,
              email,
              shoo_pairwise_sub,
              display_name,
              picture_url,
              role,
              created_at,
              last_login_at,
              goal_calories_kcal,
              goal_protein_g::float8 AS goal_protein_g,
              goal_carbs_g::float8 AS goal_carbs_g,
              goal_fat_g::float8 AS goal_fat_g,
              goal_weight_kg::float8 AS goal_weight_kg,
              onboarding_completed_at,
              preferred_weight_unit
            "#,
        )
        .bind(id)
        .bind(&profile.pairwise_sub)
        .bind(&profile.email)
        .bind(&profile.display_name)
        .bind(&profile.picture_url)
        .fetch_one(pool)
        .await?;

        return row_to_app_user(row);
    }

    let row = sqlx::query(
        r#"
        INSERT INTO users (
          id,
          shoo_pairwise_sub,
          email,
          display_name,
          picture_url,
          last_login_at
        )
        VALUES ($1, $2, $3, $4, $5, now())
        ON CONFLICT (shoo_pairwise_sub)
        DO UPDATE SET
          email = EXCLUDED.email,
          display_name = EXCLUDED.display_name,
          picture_url = EXCLUDED.picture_url,
          last_login_at = now()
        RETURNING
          id,
          email,
          shoo_pairwise_sub,
          display_name,
          picture_url,
          role,
          created_at,
          last_login_at,
          goal_calories_kcal,
          goal_protein_g::float8 AS goal_protein_g,
          goal_carbs_g::float8 AS goal_carbs_g,
          goal_fat_g::float8 AS goal_fat_g,
          goal_weight_kg::float8 AS goal_weight_kg,
          onboarding_completed_at,
          preferred_weight_unit
        "#,
    )
    .bind(user_id)
    .bind(&profile.pairwise_sub)
    .bind(&profile.email)
    .bind(&profile.display_name)
    .bind(&profile.picture_url)
    .fetch_one(pool)
    .await?;

    row_to_app_user(row)
}

pub async fn get_user_goals(pool: &PgPool, user_id: Uuid) -> AppResult<MacroGoals> {
    let row = sqlx::query(
        r#"
        SELECT
          goal_calories_kcal,
          goal_protein_g::float8 AS goal_protein_g,
          goal_carbs_g::float8 AS goal_carbs_g,
          goal_fat_g::float8 AS goal_fat_g
        FROM users
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await?;

    let Some(row) = row else {
        return Err(AppError::NotFound("User not found.".to_string()));
    };

    Ok(MacroGoals {
        calories_kcal: row.try_get("goal_calories_kcal")?,
        protein_g: row.try_get("goal_protein_g")?,
        carbs_g: row.try_get("goal_carbs_g")?,
        fat_g: row.try_get("goal_fat_g")?,
    })
}

/// Goal macros land in `numeric(6, 1)` and the goal weight in `numeric(5, 2)`,
/// so both need the column domain enforced before the UPDATE rather than after
/// Postgres raises numeric-field-overflow.
fn validate_macro_goals(goals: &MacroGoals) -> AppResult<()> {
    for (key, value) in [
        ("proteinG", goals.protein_g),
        ("carbsG", goals.carbs_g),
        ("fatG", goals.fat_g),
    ] {
        if let Some(value) = value
            && (!value.is_finite() || value < 0.0 || value > MAX_MACRO_GRAMS)
        {
            return Err(AppError::BadRequest(format!(
                "{key} must be between 0 and {MAX_MACRO_GRAMS}."
            )));
        }
    }
    if let Some(value) = goals.calories_kcal
        && value < 0
    {
        return Err(AppError::BadRequest(
            "caloriesKcal must be a non-negative integer.".to_string(),
        ));
    }
    Ok(())
}

pub(crate) fn validate_goal_weight_kg(value: Option<f64>) -> AppResult<Option<f64>> {
    match value {
        None => Ok(None),
        Some(value) => {
            let rounded = round2(value);
            if !rounded.is_finite() || rounded < 0.0 || rounded >= 1000.0 {
                return Err(AppError::BadRequest(
                    "goalWeightKg must be between 0 and 1000 kg.".to_string(),
                ));
            }
            Ok(Some(rounded))
        }
    }
}

pub async fn save_user_goals(pool: &PgPool, user_id: Uuid, goals: MacroGoals) -> AppResult<()> {
    validate_macro_goals(&goals)?;
    sqlx::query(
        r#"
        UPDATE users
        SET
          goal_calories_kcal = $2,
          goal_protein_g = $3,
          goal_carbs_g = $4,
          goal_fat_g = $5
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .bind(goals.calories_kcal)
    .bind(goals.protein_g)
    .bind(goals.carbs_g)
    .bind(goals.fat_g)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn authenticate_api_token(pool: &PgPool, token: &str) -> AppResult<Value> {
    if !token.starts_with("mtk_v1_") {
        return Ok(json!({ "ok": false, "reason": "malformed" }));
    }
    let token_hash = hash_token(token);
    let row = sqlx::query(
        r#"
        SELECT
          id,
          user_id,
          token_prefix,
          name,
          scopes,
          created_at,
          last_used_at,
          expires_at,
          revoked_at
        FROM api_tokens
        WHERE token_hash = $1
        "#,
    )
    .bind(token_hash)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(json!({ "ok": false, "reason": "invalid" }));
    };
    let expires_at: Option<DateTime<Utc>> = row.try_get("expires_at")?;
    let revoked_at: Option<DateTime<Utc>> = row.try_get("revoked_at")?;
    if revoked_at.is_some() {
        return Ok(json!({ "ok": false, "reason": "revoked" }));
    }
    if expires_at.is_some_and(|expires_at| expires_at <= Utc::now()) {
        return Ok(json!({ "ok": false, "reason": "expired" }));
    }
    let id: Uuid = row.try_get("id")?;
    // `RETURNING` instead of a follow-up SELECT. The throttle means the UPDATE
    // matches no row most of the time, in which case the row already read
    // above is current.
    let refreshed = sqlx::query(
        r#"
        UPDATE api_tokens
        SET last_used_at = now()
        WHERE id = $1
          AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')
        RETURNING
          id,
          user_id,
          token_prefix,
          name,
          scopes,
          created_at,
          last_used_at,
          expires_at,
          revoked_at
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    let record = api_token_row_json(refreshed.as_ref().unwrap_or(&row))?;
    Ok(json!({ "ok": true, "token": record }))
}

pub async fn ensure_default_meal_groups(pool: &PgPool, user_id: Uuid) -> AppResult<()> {
    // Read paths call this on every dashboard load to lazily backfill accounts
    // that predate onboarding-time provisioning. Once all four deterministic
    // groups exist and are active the provisioning statement is a guaranteed
    // no-op -- the INSERT fully conflicts and the restore UPDATE requires
    // `deleted_at IS NOT NULL` -- so probe first and skip the write entirely.
    if default_meal_groups_are_active(pool, user_id).await? {
        return Ok(());
    }

    ensure_default_meal_groups_with_executor(pool, user_id).await
}

fn default_meal_group_ids(user_id: Uuid) -> [Uuid; DEFAULT_MEAL_GROUP_LABELS.len()] {
    DEFAULT_MEAL_GROUP_LABELS.map(|label| {
        Uuid::new_v5(
            &Uuid::NAMESPACE_URL,
            format!("macro-tracker:meal-group:{user_id}:{label}").as_bytes(),
        )
    })
}

async fn default_meal_groups_are_active(pool: &PgPool, user_id: Uuid) -> AppResult<bool> {
    let ids = default_meal_group_ids(user_id);
    let active: i64 = sqlx::query(
        r#"
        SELECT count(*)::bigint AS active
        FROM meal_groups
        WHERE user_id = $1
          AND id = ANY($2::uuid[])
          AND deleted_at IS NULL
        "#,
    )
    .bind(user_id)
    .bind(&ids[..])
    .fetch_one(pool)
    .await?
    .try_get("active")?;

    Ok(active == DEFAULT_MEAL_GROUP_LABELS.len() as i64)
}

async fn ensure_default_meal_groups_with_executor<'e, E>(
    executor: E,
    user_id: Uuid,
) -> AppResult<()>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let labels = DEFAULT_MEAL_GROUP_LABELS;
    let ids = default_meal_group_ids(user_id);
    sqlx::query(
        r#"
        WITH defaults AS (
          SELECT
            id,
            label,
            (ordinality - 1)::integer AS sort_order
          FROM unnest($2::uuid[], $3::text[])
            WITH ORDINALITY AS defaults(id, label, ordinality)
        ), inserted AS (
          INSERT INTO meal_groups (id, user_id, label, sort_order, is_default)
          SELECT id, $1, label, sort_order, true
          FROM defaults
          ON CONFLICT DO NOTHING
        )
        UPDATE meal_groups AS existing
        SET
          label = defaults.label,
          sort_order = defaults.sort_order,
          is_default = true,
          deleted_at = NULL,
          updated_at = now()
        FROM defaults
        WHERE existing.id = defaults.id
          AND existing.user_id = $1
          AND existing.deleted_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM meal_groups AS active
            WHERE active.user_id = $1
              AND active.label = defaults.label
              AND active.deleted_at IS NULL
              AND active.is_default = true
          )
        "#,
    )
    .bind(user_id)
    .bind(&ids[..])
    .bind(&labels[..])
    .execute(executor)
    .await?;
    Ok(())
}

async fn meal_groups_json(pool: &PgPool, user_id: Uuid) -> AppResult<Value> {
    query_json(
        pool,
        r#"
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
            'id', id,
            'userId', user_id,
            'label', label,
            'sortOrder', sort_order,
            'isDefault', is_default
          )
          ORDER BY sort_order, label
        ), '[]'::jsonb) AS data
        FROM meal_groups
        WHERE user_id = $1 AND deleted_at IS NULL
        "#,
        &[JsonBind::Uuid(user_id)],
    )
    .await
}

async fn complete_user_onboarding_json(
    pool: &PgPool,
    user_id: Uuid,
    preferred_weight_unit: &str,
) -> AppResult<AppUser> {
    sqlx::query(
        r#"
        UPDATE users
        SET
          onboarding_completed_at = coalesce(onboarding_completed_at, now()),
          preferred_weight_unit = $2
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .bind(preferred_weight_unit)
    .execute(pool)
    .await?;
    ensure_default_meal_groups(pool, user_id).await?;
    get_user_by_id(pool, user_id)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found.".to_string()))
}

async fn complete_onboarding_setup_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<AppUser> {
    let preferred_weight_unit = input
        .get("preferredWeightUnit")
        .and_then(Value::as_str)
        .unwrap_or("kg");
    if !matches!(preferred_weight_unit, "kg" | "lb") {
        return Err(AppError::BadRequest(
            "Preferred weight unit is invalid.".to_string(),
        ));
    }
    let goals: MacroGoals = serde_json::from_value(
        input
            .get("goals")
            .cloned()
            .ok_or_else(|| AppError::BadRequest("goals is required.".to_string()))?,
    )
    .map_err(invalid_payload("goals"))?;
    // Onboarding writes the goal columns directly rather than through
    // `save_user_goals`, so the domain check has to be applied here too —
    // otherwise an oversized macro reaches `numeric(6, 1)` and rolls the whole
    // onboarding transaction back with a 500.
    validate_macro_goals(&goals)?;
    let goal_weight_kg = match input.get("goalWeightKg") {
        None | Some(Value::Null) => None,
        Some(value) => validate_goal_weight_kg(Some(value.as_f64().ok_or_else(|| {
            AppError::BadRequest("goalWeightKg must be a non-negative number.".to_string())
        })?))?,
    };
    // Normalized up front, with the same rules the standalone weight endpoint
    // uses: a zero weight or a value that only overflows after rounding must
    // fail as a bad request, not as a database error mid-transaction.
    let current_weight = match input.get("currentWeight") {
        None | Some(Value::Null) => None,
        Some(Value::Object(weight)) => Some(normalize_weight_entry_input(weight)?),
        Some(_) => {
            return Err(AppError::BadRequest(
                "currentWeight must be an object.".to_string(),
            ));
        }
    };
    let starter_template = match input.get("starterTemplate") {
        None | Some(Value::Null) => None,
        Some(Value::Object(template)) => Some(template.clone()),
        Some(_) => {
            return Err(AppError::BadRequest(
                "starterTemplate must be an object.".to_string(),
            ));
        }
    };

    if let Some(template) = starter_template.as_ref() {
        let items = template
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                AppError::BadRequest("A template must include at least one item.".to_string())
            })?;
        if items.is_empty() {
            return Err(AppError::BadRequest(
                "A template must include at least one item.".to_string(),
            ));
        }
        validate_item_product_access(pool, user_id, items).await?;
    }

    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"
        UPDATE users
        SET
          goal_calories_kcal = $2,
          goal_protein_g = $3,
          goal_carbs_g = $4,
          goal_fat_g = $5,
          goal_weight_kg = $6
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .bind(goals.calories_kcal)
    .bind(goals.protein_g)
    .bind(goals.carbs_g)
    .bind(goals.fat_g)
    .bind(goal_weight_kg)
    .execute(&mut *tx)
    .await?;

    if let Some(weight) = current_weight.as_ref() {
        let id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO weight_entries (id, user_id, entry_date, weight_kg, body_fat_pct, notes, updated_at)
            VALUES ($1, $2, $3::date, $4, $5, $6, now())
            ON CONFLICT (user_id, entry_date)
            DO UPDATE SET weight_kg = EXCLUDED.weight_kg, body_fat_pct = EXCLUDED.body_fat_pct, notes = EXCLUDED.notes, updated_at = now()
            "#,
        )
        .bind(id)
        .bind(user_id)
        .bind(&weight.date)
        .bind(weight.weight_kg)
        .bind(weight.body_fat_pct)
        .bind(weight.notes.as_deref())
        .execute(&mut *tx)
        .await?;
    }

    if let Some(template) = starter_template.as_ref() {
        let template_id = Uuid::new_v4();
        let items = template
            .get("items")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                AppError::BadRequest("A template must include at least one item.".to_string())
            })?;
        sqlx::query(
            "INSERT INTO meal_templates (id, user_id, type, label, notes, updated_at) VALUES ($1, $2, $3, $4, $5, now())",
        )
        .bind(template_id)
        .bind(user_id)
        .bind(required_string(template, "type")?)
        .bind(required_string(template, "label")?)
        .bind(template.get("notes").and_then(Value::as_str))
        .execute(&mut *tx)
        .await?;
        insert_template_items(&mut tx, template_id, items).await?;
    }

    let updated = sqlx::query(
        r#"
        UPDATE users
        SET
          onboarding_completed_at = coalesce(onboarding_completed_at, now()),
          preferred_weight_unit = $2
        WHERE id = $1
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(preferred_weight_unit)
    .fetch_optional(&mut *tx)
    .await?
    .is_some();
    if !updated {
        return Err(AppError::NotFound("User not found.".to_string()));
    }

    ensure_default_meal_groups_with_executor(&mut *tx, user_id).await?;

    tx.commit().await?;
    get_user_by_id(pool, user_id)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found.".to_string()))
}

async fn set_user_onboarding_json(
    pool: &PgPool,
    user_id: Uuid,
    onboarded: bool,
) -> AppResult<AppUser> {
    sqlx::query(
        r#"
        UPDATE users
        SET onboarding_completed_at = CASE WHEN $2 THEN coalesce(onboarding_completed_at, now()) ELSE NULL END
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .bind(onboarded)
    .execute(pool)
    .await?;
    get_user_by_id(pool, user_id)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found.".to_string()))
}

pub async fn rpc_json(pool: &PgPool, op: &str, args: Value) -> AppResult<Value> {
    match op {
        "upsertUserFromShooProfile" => {
            let profile: ShooProfile = serde_json::from_value(
                args.get("profile")
                    .cloned()
                    .ok_or_else(|| AppError::BadRequest("profile is required.".to_string()))?,
            )
            .map_err(invalid_payload("profile"))?;
            Ok(serde_json::to_value(
                upsert_user_from_shoo_profile(pool, &profile).await?,
            )?)
        }
        "getUserById" => {
            let user_id = uuid_arg(&args, "userId")?;
            Ok(serde_json::to_value(get_user_by_id(pool, user_id).await?)?)
        }
        "getUserGoals" => {
            let user_id = uuid_arg(&args, "userId")?;
            Ok(serde_json::to_value(get_user_goals(pool, user_id).await?)?)
        }
        "saveUserGoals" => {
            let user_id = uuid_arg(&args, "userId")?;
            let goals: MacroGoals = serde_json::from_value(
                args.get("goals")
                    .cloned()
                    .ok_or_else(|| AppError::BadRequest("goals is required.".to_string()))?,
            )
            .map_err(invalid_payload("goals"))?;
            save_user_goals(pool, user_id, goals).await?;
            Ok(json!(null))
        }
        "ensureDefaultMealGroups" => {
            let user_id = uuid_arg(&args, "userId")?;
            ensure_default_meal_groups(pool, user_id).await?;
            Ok(json!(null))
        }
        "completeUserOnboarding" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            let preferred_weight_unit = input
                .get("preferredWeightUnit")
                .and_then(Value::as_str)
                .unwrap_or("kg");
            if !matches!(preferred_weight_unit, "kg" | "lb") {
                return Err(AppError::BadRequest(
                    "Preferred weight unit is invalid.".to_string(),
                ));
            }
            let user = complete_user_onboarding_json(pool, user_id, preferred_weight_unit).await?;
            Ok(serde_json::to_value(user)?)
        }
        "completeOnboardingSetup" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            Ok(serde_json::to_value(
                complete_onboarding_setup_json(pool, user_id, input).await?,
            )?)
        }
        "setUserOnboardingForTesting" => {
            let user_id = uuid_arg(&args, "userId")?;
            let onboarded = args
                .get("onboarded")
                .and_then(Value::as_bool)
                .ok_or_else(|| AppError::BadRequest("onboarded is required.".to_string()))?;
            Ok(serde_json::to_value(
                set_user_onboarding_json(pool, user_id, onboarded).await?,
            )?)
        }
        "createApiToken" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            create_api_token_json(pool, user_id, input).await
        }
        "listApiTokens" => {
            let user_id = uuid_arg(&args, "userId")?;
            list_api_tokens_json(pool, user_id).await
        }
        "revokeApiToken" => {
            let user_id = uuid_arg(&args, "userId")?;
            let token_id = uuid_arg(&args, "tokenId")?;
            let revoked = sqlx::query(
                "UPDATE api_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = $1 AND id = $2 RETURNING id",
            )
            .bind(user_id)
            .bind(token_id)
            .fetch_optional(pool)
            .await?
            .is_some();
            Ok(json!(revoked))
        }
        "authenticateApiToken" => {
            let Some(token) = args.get("token").and_then(Value::as_str) else {
                return Ok(json!({ "ok": false, "reason": "missing" }));
            };
            authenticate_api_token(pool, token).await
        }
        "getMealGroups" => {
            let user_id = uuid_arg(&args, "userId")?;
            ensure_default_meal_groups(pool, user_id).await?;
            meal_groups_json(pool, user_id).await
        }
        "createMealGroup" => {
            let user_id = uuid_arg(&args, "userId")?;
            ensure_default_meal_groups(pool, user_id).await?;
            let input = object_arg(&args, "input")?;
            let label = required_string(input, "label")?;
            let row = sqlx::query(
                r#"
                WITH next_order AS (
                  SELECT coalesce(max(sort_order), -1) + 1 AS sort_order
                  FROM meal_groups
                  WHERE user_id = $1 AND deleted_at IS NULL
                )
                INSERT INTO meal_groups (id, user_id, label, sort_order, is_default)
                SELECT $2, $1, $3, sort_order, false
                FROM next_order
                RETURNING jsonb_build_object(
                  'id', id,
                  'userId', user_id,
                  'label', label,
                  'sortOrder', sort_order,
                  'isDefault', is_default
                ) AS data
                "#,
            )
            .bind(user_id)
            .bind(Uuid::new_v4())
            .bind(label)
            .fetch_one(pool)
            .await?;
            Ok(row.try_get("data")?)
        }
        "updateMealGroup" => {
            let user_id = uuid_arg(&args, "userId")?;
            let group_id = uuid_arg(&args, "groupId")?;
            let input = object_arg(&args, "input")?;
            let label = required_string(input, "label")?;
            let row = sqlx::query(
                r#"
                UPDATE meal_groups
                SET label = $3, updated_at = now()
                WHERE id = $2 AND user_id = $1 AND deleted_at IS NULL
                RETURNING jsonb_build_object(
                  'id', id,
                  'userId', user_id,
                  'label', label,
                  'sortOrder', sort_order,
                  'isDefault', is_default
                ) AS data
                "#,
            )
            .bind(user_id)
            .bind(group_id)
            .bind(label)
            .fetch_optional(pool)
            .await?;
            Ok(row
                .ok_or_else(|| AppError::NotFound("Meal group not found.".to_string()))?
                .try_get("data")?)
        }
        "deleteMealGroup" => {
            let user_id = uuid_arg(&args, "userId")?;
            let group_id = uuid_arg(&args, "groupId")?;
            let test_fault = test_fault_arg(&args, "meal_group_unassign");
            let mut tx = pool.begin().await?;
            let deleted = sqlx::query(
                r#"
                UPDATE meal_groups
                SET deleted_at = now(), updated_at = now()
                WHERE id = $2 AND user_id = $1 AND deleted_at IS NULL
                RETURNING id
                "#,
            )
            .bind(user_id)
            .bind(group_id)
            .fetch_optional(&mut *tx)
            .await?
            .is_some();
            if deleted {
                maybe_trigger_test_fault(test_fault, 1)?;
                sqlx::query(
                    "UPDATE meal_entries SET meal_group_id = NULL, updated_at = now() WHERE user_id = $1 AND meal_group_id = $2",
                )
                .bind(user_id)
                .bind(group_id)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
            Ok(json!(deleted))
        }
        "reorderMealGroups" => {
            let user_id = uuid_arg(&args, "userId")?;
            let ids = args
                .get("orderedIds")
                .and_then(Value::as_array)
                .ok_or_else(|| AppError::BadRequest("orderedIds is required.".to_string()))?;
            let ordered_ids = ids
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .ok_or_else(|| {
                            AppError::BadRequest("orderedIds must contain strings.".to_string())
                        })
                        .and_then(|value| {
                            Uuid::parse_str(value).map_err(|_| {
                                AppError::BadRequest("orderedIds must contain UUIDs.".to_string())
                            })
                        })
                })
                .collect::<AppResult<Vec<_>>>()?;
            let mut tx = pool.begin().await?;
            let active_rows =
                sqlx::query("SELECT id FROM meal_groups WHERE user_id = $1 AND deleted_at IS NULL")
                    .bind(user_id)
                    .fetch_all(&mut *tx)
                    .await?;
            if active_rows.len() != ordered_ids.len() {
                return Err(AppError::BadRequest(
                    "orderedIds must include each active meal group exactly once.".to_string(),
                ));
            }
            let active_ids = active_rows
                .iter()
                .map(|row| row.try_get::<Uuid, _>("id"))
                .collect::<Result<Vec<_>, _>>()?;
            let mut sorted_active = active_ids;
            let mut sorted_ordered = ordered_ids.clone();
            sorted_active.sort();
            sorted_ordered.sort();
            if sorted_active != sorted_ordered {
                return Err(AppError::BadRequest(
                    "orderedIds must include each active meal group exactly once.".to_string(),
                ));
            }
            // One statement rather than one per group: a drag-to-reorder used
            // to cost a round trip per row.
            let sort_orders: Vec<i32> = (0..ordered_ids.len() as i32).collect();
            sqlx::query(
                r#"
                UPDATE meal_groups
                SET sort_order = ordering.sort_order, updated_at = now()
                FROM unnest($2::uuid[], $3::int[]) AS ordering(id, sort_order)
                WHERE meal_groups.user_id = $1 AND meal_groups.id = ordering.id
                "#,
            )
            .bind(user_id)
            .bind(&ordered_ids)
            .bind(&sort_orders)
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            ensure_default_meal_groups(pool, user_id).await?;
            meal_groups_json(pool, user_id).await
        }
        "getDailySummary" => {
            let user_id = uuid_arg(&args, "userId")?;
            let date = date_arg(&args, "date")?;
            ensure_default_meal_groups(pool, user_id).await?;
            daily_summary_json(pool, user_id, &date).await
        }
        "getDashboardData" => {
            let user_id = uuid_arg(&args, "userId")?;
            let selected_date =
                date_arg(&args, "selectedDate").or_else(|_| date_arg(&args, "date"))?;
            ensure_default_meal_groups(pool, user_id).await?;
            let daily_summary = daily_summary_json(pool, user_id, &selected_date).await?;
            let period_averages = period_averages_json(pool, user_id, &selected_date).await?;
            Ok(json!({
                "dailySummary": daily_summary,
                "periodAverages": period_averages
            }))
        }
        "createMealEntry" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            create_meal_entry_json(pool, user_id, input).await
        }
        "getMealEntryById" => {
            let user_id = uuid_arg(&args, "userId")?;
            let entry_id = uuid_arg(&args, "entryId")?;
            match meal_entry_json(pool, user_id, entry_id).await {
                Ok(entry) => Ok(entry),
                Err(AppError::NotFound(_)) => Ok(Value::Null),
                Err(error) => Err(error),
            }
        }
        "updateMealEntry" => {
            let user_id = uuid_arg(&args, "userId")?;
            let entry_id = uuid_arg(&args, "entryId")?;
            let input = object_arg(&args, "input")?;
            update_meal_entry_json(pool, user_id, entry_id, input).await
        }
        "deleteMealEntry" => {
            let user_id = uuid_arg(&args, "userId")?;
            let entry_id = uuid_arg(&args, "entryId")?;
            let deleted =
                sqlx::query("DELETE FROM meal_entries WHERE user_id = $1 AND id = $2 RETURNING id")
                    .bind(user_id)
                    .bind(entry_id)
                    .fetch_optional(pool)
                    .await?
                    .is_some();
            Ok(json!(deleted))
        }
        "markMealEntryStatus" => {
            let user_id = uuid_arg(&args, "userId")?;
            let entry_id = uuid_arg(&args, "entryId")?;
            let status = string_arg(&args, "status")?;
            if !matches!(status.as_str(), "planned" | "eaten" | "skipped") {
                return Err(AppError::BadRequest("Meal status is invalid.".to_string()));
            }
            sqlx::query(
                "UPDATE meal_entries SET status = $3, updated_at = now() WHERE user_id = $1 AND id = $2",
            )
            .bind(user_id)
            .bind(entry_id)
            .bind(status)
            .execute(pool)
            .await?;
            meal_entry_json(pool, user_id, entry_id).await
        }
        "getTemplates" => {
            let user_id = uuid_arg(&args, "userId")?;
            templates_json(pool, user_id).await
        }
        "getTemplateById" => {
            let user_id = uuid_arg(&args, "userId")?;
            let template_id = uuid_arg(&args, "templateId")?;
            let all = templates_json(pool, user_id).await?;
            let template = all
                .as_array()
                .and_then(|items| {
                    items.iter().find(|item| {
                        item.get("id").and_then(Value::as_str) == Some(&template_id.to_string())
                    })
                })
                .cloned();
            Ok(template.unwrap_or(Value::Null))
        }
        "createTemplate" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            create_template_json(pool, user_id, input).await
        }
        "updateTemplate" => {
            let user_id = uuid_arg(&args, "userId")?;
            let template_id = uuid_arg(&args, "templateId")?;
            let input = object_arg(&args, "input")?;
            update_template_json(pool, user_id, template_id, input).await
        }
        "deleteTemplate" => {
            let user_id = uuid_arg(&args, "userId")?;
            let template_id = uuid_arg(&args, "templateId")?;
            let deleted = sqlx::query(
                "UPDATE meal_templates SET deleted_at = now(), updated_at = now() WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING id",
            )
            .bind(user_id)
            .bind(template_id)
            .fetch_optional(pool)
            .await?
            .is_some();
            Ok(json!(deleted))
        }
        "applyTemplateToDate" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            let test_fault = test_fault_arg(&args, "meal_entry_insert").cloned();
            apply_template_json(pool, user_id, input, test_fault.as_ref()).await
        }
        "createTemplateFromDate" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            create_template_from_date_json(pool, user_id, input).await
        }
        "getRecipes" => {
            let user_id = uuid_arg(&args, "userId")?;
            recipes_json(pool, user_id).await
        }
        "getRecipeCount" => {
            let user_id = uuid_arg(&args, "userId")?;
            let row = sqlx::query("SELECT count(*)::int AS count FROM recipes WHERE user_id = $1")
                .bind(user_id)
                .fetch_one(pool)
                .await?;
            let count: i32 = row.try_get("count")?;
            Ok(json!(count))
        }
        "getRecipeById" => {
            let user_id = uuid_arg(&args, "userId")?;
            let recipe_id = uuid_arg(&args, "recipeId")?;
            let all = recipes_json(pool, user_id).await?;
            let recipe = all
                .as_array()
                .and_then(|items| {
                    items.iter().find(|item| {
                        item.get("id").and_then(Value::as_str) == Some(&recipe_id.to_string())
                    })
                })
                .cloned();
            Ok(recipe.unwrap_or(Value::Null))
        }
        "createRecipe" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            let test_fault = test_fault_arg(&args, "recipe_ingredient_insert").cloned();
            create_recipe_json(pool, user_id, input, test_fault.as_ref()).await
        }
        "updateRecipe" => {
            let user_id = uuid_arg(&args, "userId")?;
            let recipe_id = uuid_arg(&args, "recipeId")?;
            let input = object_arg(&args, "input")?;
            let test_fault = test_fault_arg(&args, "recipe_ingredient_insert").cloned();
            update_recipe_json(pool, user_id, recipe_id, input, test_fault.as_ref()).await
        }
        "deleteRecipe" => {
            let user_id = uuid_arg(&args, "userId")?;
            let recipe_id = uuid_arg(&args, "recipeId")?;
            let deleted =
                sqlx::query("DELETE FROM recipes WHERE user_id = $1 AND id = $2 RETURNING id")
                    .bind(user_id)
                    .bind(recipe_id)
                    .fetch_optional(pool)
                    .await?
                    .is_some();
            Ok(json!(deleted))
        }
        "getWeightEntries" => {
            let user_id = uuid_arg(&args, "userId")?;
            weight_entries_json(pool, user_id).await
        }
        // Fetches one row instead of the account's whole weight history, which
        // the PATCH handler used to load and linear-scan.
        "getWeightEntryById" => {
            let user_id = uuid_arg(&args, "userId")?;
            let entry_id = uuid_arg(&args, "entryId")?;
            weight_entry_by_id_json(pool, user_id, entry_id).await
        }
        "getWeightGoal" => {
            let user_id = uuid_arg(&args, "userId")?;
            let row = sqlx::query(
                "SELECT goal_weight_kg::float8 AS goal_weight_kg FROM users WHERE id = $1",
            )
            .bind(user_id)
            .fetch_one(pool)
            .await?;
            let goal: Option<f64> = row.try_get("goal_weight_kg")?;
            Ok(json!(goal))
        }
        "saveWeightGoal" => {
            let user_id = uuid_arg(&args, "userId")?;
            let goal = validate_goal_weight_kg(args.get("goalWeightKg").and_then(Value::as_f64))?;
            sqlx::query("UPDATE users SET goal_weight_kg = $2 WHERE id = $1")
                .bind(user_id)
                .bind(goal)
                .execute(pool)
                .await?;
            Ok(json!(null))
        }
        "getWeightPageData" => {
            let user_id = uuid_arg(&args, "userId")?;
            let selected_date = date_arg(&args, "selectedDate")?;
            weight_page_data_json(pool, user_id, &selected_date).await
        }
        "createWeightEntry" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            create_weight_entry_json(pool, user_id, input, true).await
        }
        "createWeightEntryNoOverwrite" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            create_weight_entry_json(pool, user_id, input, false).await
        }
        "updateWeightEntry" => {
            let user_id = uuid_arg(&args, "userId")?;
            let entry_id = uuid_arg(&args, "entryId")?;
            let input = object_arg(&args, "input")?;
            update_weight_entry_json(pool, user_id, entry_id, input).await
        }
        "deleteWeightEntry" => {
            let user_id = uuid_arg(&args, "userId")?;
            let entry_id = uuid_arg(&args, "entryId")?;
            let deleted = sqlx::query(
                "DELETE FROM weight_entries WHERE user_id = $1 AND id = $2 RETURNING id",
            )
            .bind(user_id)
            .bind(entry_id)
            .fetch_optional(pool)
            .await?
            .is_some();
            Ok(json!(deleted))
        }
        "getRecentQuickAddCandidates" => {
            let user_id = uuid_arg(&args, "userId")?;
            let limit = args
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(30)
                .clamp(1, 100) as i32;
            recent_quick_add_json(pool, user_id, limit).await
        }
        "getDashboardQuickAddCandidates" => {
            let user_id = uuid_arg(&args, "userId")?;
            let limit = args
                .get("limitPerSource")
                .and_then(Value::as_i64)
                .unwrap_or(30)
                .clamp(1, 30) as i32;
            dashboard_quick_add_json(pool, user_id, limit).await
        }
        "listRecentMealEntries" => {
            let user_id = uuid_arg(&args, "userId")?;
            let limit = args
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(200)
                .clamp(1, 500) as i32;
            list_recent_meal_entries_json(pool, user_id, limit, true).await
        }
        "getRecentDailyOverviews" => {
            let user_id = uuid_arg(&args, "userId")?;
            let selected_date = date_arg(&args, "selectedDate")
                .or_else(|_| date_arg(&args, "date"))
                .unwrap_or_else(|_| Utc::now().date_naive().to_string());
            let days = args
                .get("days")
                .and_then(Value::as_i64)
                .unwrap_or(7)
                .clamp(1, 90) as i32;
            recent_daily_overviews_json(pool, user_id, &selected_date, days).await
        }
        "searchMealEntries" => {
            let user_id = uuid_arg(&args, "userId")?;
            let query = string_arg(&args, "query")?;
            search_meal_entries_json(pool, user_id, &query).await
        }
        "getPeriodAverages" => {
            let user_id = uuid_arg(&args, "userId")?;
            let selected_date =
                date_arg(&args, "selectedDate").or_else(|_| date_arg(&args, "date"))?;
            period_averages_json(pool, user_id, &selected_date).await
        }
        "getStatsPageData" => {
            let user_id = uuid_arg(&args, "userId")?;
            let today = date_arg(&args, "today")
                .or_else(|_| date_arg(&args, "referenceDate"))
                .unwrap_or_else(|_| Utc::now().date_naive().to_string());
            stats_page_data_json(pool, user_id, &today).await
        }
        "getLeaderboardStats" => {
            let user_id = uuid_arg(&args, "userId")?;
            let reference_date = date_arg(&args, "referenceDate")
                .or_else(|_| date_arg(&args, "today"))
                .unwrap_or_else(|_| Utc::now().date_naive().to_string());
            leaderboard_json(pool, user_id, &reference_date).await
        }
        "searchFoodProducts" => {
            let user_id = uuid_arg(&args, "userId")?;
            let query = string_arg(&args, "query")?;
            search_food_products_json(pool, user_id, &query).await
        }
        "getFoodProductByIdForUser" => {
            let user_id = uuid_arg(&args, "userId")?;
            let product_id = uuid_arg(&args, "productId")?;
            Ok(food_product_json_by_id(pool, user_id, product_id)
                .await?
                .unwrap_or(Value::Null))
        }
        "lookupBarcodeFoodProduct" => {
            let barcode = string_arg(&args, "barcode")?;
            Ok(lookup_barcode_food_product_json(pool, &barcode)
                .await?
                .unwrap_or(Value::Null))
        }
        "saveBarcodeFoodProduct" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            maybe_trigger_test_fault(test_fault_arg(&args, "barcode_food_product_insert"), 1)?;
            let revision_test_fault =
                test_fault_arg(&args, "barcode_food_product_revision").cloned();
            save_barcode_food_product_json(pool, user_id, input, revision_test_fault.as_ref()).await
        }
        // Admin reads take an actor and enforce the role here, in the data
        // layer. Relying on the Next.js layout guard alone left a
        // stale-privilege window: Partial Rendering does not re-run a layout on
        // client navigation, so a just-demoted admin could still load every
        // account's PII from an already-open tab.
        "getAdminDashboardData" => {
            require_admin_actor(pool, uuid_arg(&args, "actorUserId")?).await?;
            admin_dashboard_json(pool).await
        }
        "getAdminUserHealthSummary" => {
            require_admin_actor(pool, uuid_arg(&args, "actorUserId")?).await?;
            admin_user_health_summary_json(pool).await
        }
        "listAdminUsers" => {
            require_admin_actor(pool, uuid_arg(&args, "actorUserId")?).await?;
            let input = optional_object_arg(&args, "input");
            list_admin_users_json(pool, input).await
        }
        "getAdminUserDetail" => {
            require_admin_actor(pool, uuid_arg(&args, "actorUserId")?).await?;
            let user_id = uuid_arg(&args, "userId")?;
            get_admin_user_detail_json(pool, user_id).await
        }
        "setUserRole" => {
            let actor_user_id = uuid_arg(&args, "actorUserId")?;
            let target_user_id = uuid_arg(&args, "targetUserId")?;
            let next_role = string_arg(&args, "nextRole")?;
            let audit_test_fault = test_fault_arg(&args, "admin_audit_event").cloned();
            set_user_role_json(
                pool,
                actor_user_id,
                target_user_id,
                &next_role,
                audit_test_fault.as_ref(),
            )
            .await
        }
        "listAdminBarcodeProducts" => {
            require_admin_actor(pool, uuid_arg(&args, "actorUserId")?).await?;
            let input = optional_object_arg(&args, "input");
            list_admin_barcode_products_json(pool, input, false).await
        }
        "listAdminBarcodeReviewQueue" => {
            require_admin_actor(pool, uuid_arg(&args, "actorUserId")?).await?;
            let input = optional_object_arg(&args, "input");
            list_admin_barcode_products_json(pool, input, true).await
        }
        "getAdminBarcodeProductById" => {
            require_admin_actor(pool, uuid_arg(&args, "actorUserId")?).await?;
            let product_id = uuid_arg(&args, "barcodeProductId")?;
            Ok(admin_food_product_by_id_json(pool, product_id)
                .await?
                .unwrap_or(Value::Null))
        }
        "createAdminBarcodeProduct" => {
            let actor_user_id = uuid_arg(&args, "actorUserId")?;
            let input = object_arg(&args, "input")?;
            let audit_test_fault = test_fault_arg(&args, "admin_audit_event").cloned();
            create_admin_barcode_product_json(pool, actor_user_id, input, audit_test_fault.as_ref())
                .await
        }
        "updateAdminBarcodeProduct" => {
            let actor_user_id = uuid_arg(&args, "actorUserId")?;
            let product_id = uuid_arg(&args, "barcodeProductId")?;
            let input = object_arg(&args, "input")?;
            let revision_test_fault = test_fault_arg(&args, "food_product_revision").cloned();
            let audit_test_fault = test_fault_arg(&args, "admin_audit_event").cloned();
            update_admin_barcode_product_json(
                pool,
                actor_user_id,
                product_id,
                input,
                revision_test_fault.as_ref(),
                audit_test_fault.as_ref(),
            )
            .await
        }
        "softDeleteAdminBarcodeProduct" => {
            let actor_user_id = uuid_arg(&args, "actorUserId")?;
            let product_id = uuid_arg(&args, "barcodeProductId")?;
            let revision_test_fault = test_fault_arg(&args, "food_product_revision").cloned();
            let audit_test_fault = test_fault_arg(&args, "admin_audit_event").cloned();
            set_admin_barcode_deleted_json(
                pool,
                actor_user_id,
                product_id,
                true,
                revision_test_fault.as_ref(),
                audit_test_fault.as_ref(),
            )
            .await
        }
        "restoreAdminBarcodeProduct" => {
            let actor_user_id = uuid_arg(&args, "actorUserId")?;
            let product_id = uuid_arg(&args, "barcodeProductId")?;
            let revision_test_fault = test_fault_arg(&args, "food_product_revision").cloned();
            let audit_test_fault = test_fault_arg(&args, "admin_audit_event").cloned();
            set_admin_barcode_deleted_json(
                pool,
                actor_user_id,
                product_id,
                false,
                revision_test_fault.as_ref(),
                audit_test_fault.as_ref(),
            )
            .await
        }
        "listAdminAuditEvents" => {
            require_admin_actor(pool, uuid_arg(&args, "actorUserId")?).await?;
            let input = optional_object_arg(&args, "input");
            list_admin_audit_events_json(pool, input).await
        }
        "getAdminAuditEventById" => {
            require_admin_actor(pool, uuid_arg(&args, "actorUserId")?).await?;
            let event_id = uuid_arg(&args, "eventId")?;
            get_admin_audit_event_json(pool, event_id).await
        }
        "createPersonalFoodProduct" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            create_food_product_json(pool, user_id, input, true).await
        }
        "updatePersonalFoodProduct" => {
            let user_id = uuid_arg(&args, "userId")?;
            let product_id = uuid_arg(&args, "productId")?;
            let input = object_arg(&args, "input")?;
            update_food_product_json(pool, user_id, product_id, input).await
        }
        _ => Err(AppError::NotFound(format!(
            "Unknown backend operation: {op}"
        ))),
    }
}

enum JsonBind {
    Uuid(Uuid),
}

async fn query_json(pool: &PgPool, sql: &str, binds: &[JsonBind]) -> AppResult<Value> {
    let mut query = sqlx::query(sql);
    for bind in binds {
        match bind {
            JsonBind::Uuid(value) => {
                query = query.bind(*value);
            }
        }
    }
    let row = query.fetch_one(pool).await?;
    let value: Value = row.try_get("data")?;
    Ok(value)
}

async fn daily_summary_json(pool: &PgPool, user_id: Uuid, date: &str) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        WITH day_entries AS (
          SELECT *
          FROM meal_entries
          WHERE user_id = $1 AND entry_date = $2::date
        ),
        meals AS (
          SELECT coalesce(jsonb_agg(
            jsonb_build_object(
              'id', me.id,
              'userId', me.user_id,
              'date', me.entry_date,
              'mealGroupId', me.meal_group_id,
              'status', me.status,
              'productId', CASE WHEN fp.id IS NULL THEN NULL ELSE me.product_id END,
              'label', me.label,
              'sortOrder', me.sort_order,
              'quantity', round(me.quantity::numeric, 2)::float8,
              'unit', me.unit,
              'servingMultiplier', round(me.serving_multiplier::numeric, 2)::float8,
              'proteinG', round(me.protein_g::numeric, 1)::float8,
              'carbsG', round(me.carbs_g::numeric, 1)::float8,
              'fatG', round(me.fat_g::numeric, 1)::float8,
              'caloriesKcal', me.calories_kcal,
              'clientMutationId', me.client_mutation_id,
              'sourceLabel', fp.name
            )
            ORDER BY coalesce(mg.sort_order, 999), me.sort_order, me.created_at, me.id
          ), '[]'::jsonb) AS data
          FROM day_entries me
          LEFT JOIN meal_groups mg ON mg.id = me.meal_group_id
          LEFT JOIN food_products fp
            ON fp.id = me.product_id
            AND fp.deleted_at IS NULL
            AND (fp.owner_user_id = me.user_id OR fp.owner_user_id IS NULL)
        ),
        groups AS (
          SELECT coalesce(jsonb_agg(
            jsonb_build_object(
              'id', id,
              'userId', user_id,
              'label', label,
              'sortOrder', sort_order,
              'isDefault', is_default
            )
            ORDER BY sort_order, label
          ), '[]'::jsonb) AS data
          FROM meal_groups
          WHERE user_id = $1 AND deleted_at IS NULL
        ),
        totals AS (
          SELECT
            coalesce(sum(protein_g) FILTER (WHERE status = 'eaten'), 0)::float8 AS protein_g,
            coalesce(sum(carbs_g) FILTER (WHERE status = 'eaten'), 0)::float8 AS carbs_g,
            coalesce(sum(fat_g) FILTER (WHERE status = 'eaten'), 0)::float8 AS fat_g,
            coalesce(sum(calories_kcal) FILTER (WHERE status = 'eaten'), 0)::int AS calories_kcal,
            coalesce(sum(protein_g) FILTER (WHERE status = 'planned'), 0)::float8 AS planned_protein_g,
            coalesce(sum(carbs_g) FILTER (WHERE status = 'planned'), 0)::float8 AS planned_carbs_g,
            coalesce(sum(fat_g) FILTER (WHERE status = 'planned'), 0)::float8 AS planned_fat_g,
            coalesce(sum(calories_kcal) FILTER (WHERE status = 'planned'), 0)::int AS planned_calories_kcal,
            coalesce(sum(protein_g) FILTER (WHERE status = 'skipped'), 0)::float8 AS skipped_protein_g,
            coalesce(sum(carbs_g) FILTER (WHERE status = 'skipped'), 0)::float8 AS skipped_carbs_g,
            coalesce(sum(fat_g) FILTER (WHERE status = 'skipped'), 0)::float8 AS skipped_fat_g,
            coalesce(sum(calories_kcal) FILTER (WHERE status = 'skipped'), 0)::int AS skipped_calories_kcal
          FROM day_entries
        )
        SELECT jsonb_build_object(
          'date', $2::text,
          'totals', jsonb_build_object(
            'proteinG', round(totals.protein_g::numeric, 1)::float8,
            'carbsG', round(totals.carbs_g::numeric, 1)::float8,
            'fatG', round(totals.fat_g::numeric, 1)::float8,
            'caloriesKcal', totals.calories_kcal
          ),
          'plannedTotals', jsonb_build_object(
            'proteinG', round(totals.planned_protein_g::numeric, 1)::float8,
            'carbsG', round(totals.planned_carbs_g::numeric, 1)::float8,
            'fatG', round(totals.planned_fat_g::numeric, 1)::float8,
            'caloriesKcal', totals.planned_calories_kcal
          ),
          'skippedTotals', jsonb_build_object(
            'proteinG', round(totals.skipped_protein_g::numeric, 1)::float8,
            'carbsG', round(totals.skipped_carbs_g::numeric, 1)::float8,
            'fatG', round(totals.skipped_fat_g::numeric, 1)::float8,
            'caloriesKcal', totals.skipped_calories_kcal
          ),
          'meals', meals.data,
          'mealGroups', groups.data
        ) AS data
        FROM totals, meals, groups
        "#,
    )
    .bind(user_id)
    .bind(date)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn templates_json(pool: &PgPool, user_id: Uuid) -> AppResult<Value> {
    templates_json_filtered(pool, user_id, None).await
}

/// Shared shape for the template list and single-template reads. Passing a
/// `template_id` narrows both the outer select and the item aggregation to one
/// row, so by-id lookups stay indexed instead of building the whole collection.
async fn templates_json_filtered(
    pool: &PgPool,
    user_id: Uuid,
    template_id: Option<Uuid>,
) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        WITH visible_templates AS (
          SELECT id, user_id, type, label, notes, created_at, updated_at
          FROM meal_templates
          WHERE user_id = $1
            AND deleted_at IS NULL
            AND ($2::uuid IS NULL OR id = $2::uuid)
        ),
        item_data AS (
          SELECT
            template_id,
            jsonb_agg(
              jsonb_build_object(
                'id', id,
                'templateId', template_id,
                'productId', product_id,
                'mealGroupLabel', meal_group_label,
                'sortOrder', sort_order,
                'label', label,
                'quantity', quantity::float8,
                'unit', unit,
                'servingMultiplier', serving_multiplier::float8,
                'proteinG', protein_g::float8,
                'carbsG', carbs_g::float8,
                'fatG', fat_g::float8,
                'caloriesKcal', calories_kcal
              )
              ORDER BY sort_order, created_at, id
            ) AS items
          FROM meal_template_items
          WHERE template_id IN (SELECT id FROM visible_templates)
          GROUP BY template_id
        )
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
            'id', mt.id,
            'userId', mt.user_id,
            'type', mt.type,
            'label', mt.label,
            'notes', mt.notes,
            'items', coalesce(item_data.items, '[]'::jsonb),
            'createdAt', mt.created_at,
            'updatedAt', mt.updated_at
          )
          ORDER BY mt.updated_at DESC, mt.created_at DESC
        ), '[]'::jsonb) AS data
        FROM visible_templates mt
        LEFT JOIN item_data ON item_data.template_id = mt.id
        "#,
    )
    .bind(user_id)
    .bind(template_id)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn recipes_json(pool: &PgPool, user_id: Uuid) -> AppResult<Value> {
    recipes_json_filtered(pool, user_id, None).await
}

/// Shared shape for the recipe list and single-recipe reads. See
/// [`templates_json_filtered`] for why the id filter lives in SQL.
async fn recipes_json_filtered(
    pool: &PgPool,
    user_id: Uuid,
    recipe_id: Option<Uuid>,
) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        WITH visible_recipes AS (
          SELECT id, user_id, label, portions, total_cooked_weight_g, created_at, updated_at
          FROM recipes
          WHERE user_id = $1
            AND ($2::uuid IS NULL OR id = $2::uuid)
        ),
        ingredient_data AS (
          SELECT
            recipe_id,
            jsonb_agg(
              jsonb_build_object(
                'id', id,
                'recipeId', recipe_id,
                'productId', product_id,
                'sortOrder', sort_order,
                'label', label,
                'quantity', quantity::float8,
                'unit', unit,
                'servingMultiplier', serving_multiplier::float8,
                'proteinG', protein_g::float8,
                'carbsG', carbs_g::float8,
                'fatG', fat_g::float8,
                'caloriesKcal', calories_kcal
              )
              ORDER BY sort_order, created_at, id
            ) AS ingredients,
            coalesce(sum(protein_g), 0)::float8 AS protein_g,
            coalesce(sum(carbs_g), 0)::float8 AS carbs_g,
            coalesce(sum(fat_g), 0)::float8 AS fat_g,
            coalesce(sum(calories_kcal), 0)::int AS calories_kcal
          FROM recipe_ingredients
          WHERE recipe_id IN (SELECT id FROM visible_recipes)
          GROUP BY recipe_id
        )
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
            'id', r.id,
            'userId', r.user_id,
            'label', r.label,
            'portions', r.portions,
            'totalCookedWeightG', r.total_cooked_weight_g::float8,
            'ingredients', coalesce(ingredient_data.ingredients, '[]'::jsonb),
            'totalMacros', jsonb_build_object(
              'proteinG', coalesce(ingredient_data.protein_g, 0),
              'carbsG', coalesce(ingredient_data.carbs_g, 0),
              'fatG', coalesce(ingredient_data.fat_g, 0),
              'caloriesKcal', coalesce(ingredient_data.calories_kcal, 0)
            ),
            'perPortionMacros', jsonb_build_object(
              'proteinG', round((coalesce(ingredient_data.protein_g, 0) / greatest(r.portions, 1))::numeric, 1)::float8,
              'carbsG', round((coalesce(ingredient_data.carbs_g, 0) / greatest(r.portions, 1))::numeric, 1)::float8,
              'fatG', round((coalesce(ingredient_data.fat_g, 0) / greatest(r.portions, 1))::numeric, 1)::float8,
              'caloriesKcal', round(coalesce(ingredient_data.calories_kcal, 0)::numeric / greatest(r.portions, 1))::int
            )
          )
          ORDER BY r.updated_at DESC, r.created_at DESC
        ), '[]'::jsonb) AS data
        FROM visible_recipes r
        LEFT JOIN ingredient_data ON ingredient_data.recipe_id = r.id
        "#,
    )
    .bind(user_id)
    .bind(recipe_id)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn search_food_products_json(pool: &PgPool, user_id: Uuid, query: &str) -> AppResult<Value> {
    validate_search_query(query)?;
    let patterns = search_like_patterns(query);
    if patterns.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }
    let row = sqlx::query(
        r#"
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
            'id', id,
            'ownerUserId', owner_user_id,
            'scope', scope,
            'source', source,
            'barcode', barcode,
            'name', name,
            'brand', brand,
            'defaultServingQuantity', default_serving_quantity::float8,
            'defaultServingUnit', default_serving_unit,
            'proteinPer100', protein_per_100::float8,
            'carbsPer100', carbs_per_100::float8,
            'fatPer100', fat_per_100::float8,
            'caloriesPer100', calories_per_100,
            'servingWeightG', serving_weight_g::float8,
            'servingVolumeMl', serving_volume_ml::float8,
            'submittedByUserId', submitted_by_user_id,
            'deletedByUserId', deleted_by_user_id,
            'sourceProvider', source_provider,
            'sourceConfidence', source_confidence::float8,
            'sourceMetadata', source_metadata,
            'correctedFromProductId', corrected_from_product_id,
            'createdAt', created_at,
            'updatedAt', updated_at,
            'deletedAt', deleted_at
          )
          ORDER BY
            CASE
              WHEN owner_user_id = $1 AND corrected_from_product_id IS NOT NULL THEN 0
              WHEN owner_user_id = $1 THEN 1
              ELSE 2
            END,
            name ASC
        ), '[]'::jsonb) AS data
        FROM (
          SELECT *
          FROM food_products
          WHERE
            deleted_at IS NULL
            AND (owner_user_id = $1 OR owner_user_id IS NULL)
            -- Redundant by construction: the NOT EXISTS below already requires
            -- every pattern to match one of these columns, so requiring it of
            -- the first pattern cannot change the result set. Spelling it out
            -- gives the planner an indexable OR that the pg_trgm indexes from
            -- migration 0014 can serve as a bitmap scan, instead of sequentially
            -- scanning the whole shared catalog.
            AND (
              name ILIKE $3 ESCAPE '\'
              OR brand ILIKE $3 ESCAPE '\'
              OR barcode ILIKE $3 ESCAPE '\'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM unnest($2::text[]) AS patterns(pattern)
              WHERE NOT coalesce(
                name ILIKE pattern ESCAPE '\'
                OR brand ILIKE pattern ESCAPE '\'
                OR barcode ILIKE pattern ESCAPE '\',
                false
              )
            )
          ORDER BY
            CASE
              WHEN owner_user_id = $1 AND corrected_from_product_id IS NOT NULL THEN 0
              WHEN owner_user_id = $1 THEN 1
              ELSE 2
            END,
            name ASC
          LIMIT 50
        ) products
        "#,
    )
    .bind(user_id)
    .bind(&patterns)
    .bind(&patterns[0])
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

/// Longest search string accepted. The SQL runs three ILIKEs per pattern per
/// candidate row, so an uncapped query makes the scan cost quadratic in
/// attacker-controlled input.
pub(crate) const MAX_SEARCH_QUERY_LENGTH: usize = 128;
/// Most whitespace-separated terms accepted from one query.
pub(crate) const MAX_SEARCH_TERMS: usize = 8;

fn validate_search_query(query: &str) -> AppResult<()> {
    if query.chars().count() > MAX_SEARCH_QUERY_LENGTH {
        return Err(AppError::BadRequest(format!(
            "Search query must be at most {MAX_SEARCH_QUERY_LENGTH} characters."
        )));
    }
    if query.split_whitespace().count() > MAX_SEARCH_TERMS {
        return Err(AppError::BadRequest(format!(
            "Search query must have at most {MAX_SEARCH_TERMS} terms."
        )));
    }
    Ok(())
}

fn search_like_patterns(query: &str) -> Vec<String> {
    query
        .split_whitespace()
        .take(MAX_SEARCH_TERMS)
        .map(|word| format!("%{}%", escape_like_pattern(word)))
        .collect()
}

fn escape_like_pattern(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

async fn assert_meal_group_access(
    pool: &PgPool,
    user_id: Uuid,
    group_id: Option<Uuid>,
) -> AppResult<()> {
    let Some(group_id) = group_id else {
        return Ok(());
    };
    let exists = sqlx::query(
        "SELECT id FROM meal_groups WHERE id = $2 AND user_id = $1 AND deleted_at IS NULL",
    )
    .bind(user_id)
    .bind(group_id)
    .fetch_optional(pool)
    .await?
    .is_some();
    if exists {
        Ok(())
    } else {
        Err(AppError::NotFound("Meal group not found.".to_string()))
    }
}

async fn food_product_json_by_id(
    pool: &PgPool,
    user_id: Uuid,
    product_id: Uuid,
) -> AppResult<Option<Value>> {
    food_product_json_by_id_with_executor(pool, user_id, product_id).await
}

async fn food_product_json_by_id_with_executor<'e, E>(
    executor: E,
    user_id: Uuid,
    product_id: Uuid,
) -> AppResult<Option<Value>>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let row = sqlx::query(
        r#"
        SELECT jsonb_build_object(
          'id', id,
          'ownerUserId', owner_user_id,
          'scope', scope,
          'source', source,
          'barcode', barcode,
          'name', name,
          'brand', brand,
          'defaultServingQuantity', default_serving_quantity::float8,
          'defaultServingUnit', default_serving_unit,
          'proteinPer100', protein_per_100::float8,
          'carbsPer100', carbs_per_100::float8,
          'fatPer100', fat_per_100::float8,
          'caloriesPer100', calories_per_100,
          'servingWeightG', serving_weight_g::float8,
          'servingVolumeMl', serving_volume_ml::float8,
          'submittedByUserId', submitted_by_user_id,
          'deletedByUserId', deleted_by_user_id,
          'sourceProvider', source_provider,
          'sourceConfidence', source_confidence::float8,
          'sourceMetadata', source_metadata,
          'correctedFromProductId', corrected_from_product_id,
          'createdAt', created_at,
          'updatedAt', updated_at,
          'deletedAt', deleted_at
        ) AS data
        FROM food_products
        WHERE id = $2
          AND deleted_at IS NULL
          AND (owner_user_id = $1 OR owner_user_id IS NULL)
        "#,
    )
    .bind(user_id)
    .bind(product_id)
    .fetch_optional(executor)
    .await?;

    row.map(|row| row.try_get("data"))
        .transpose()
        .map_err(Into::into)
}

fn nutrition_for_product(
    product: &Value,
    input: &serde_json::Map<String, Value>,
    recalculate_product_macros: bool,
) -> (String, f64, String, f64, f64, f64, f64, i32) {
    let product_name = product
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let brand = product.get("brand").and_then(Value::as_str).unwrap_or("");
    let label = if brand.is_empty() {
        product_name
    } else {
        format!("{product_name} ({brand})")
    };
    let quantity = optional_f64(input, "quantity")
        .or_else(|| {
            product
                .get("defaultServingQuantity")
                .and_then(Value::as_f64)
        })
        .unwrap_or(1.0);
    let unit = input
        .get("unit")
        .and_then(Value::as_str)
        .or_else(|| product.get("defaultServingUnit").and_then(Value::as_str))
        .unwrap_or("serving")
        .to_string();
    let serving_multiplier = optional_f64(input, "servingMultiplier").unwrap_or(1.0);
    let scope = product
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("personal");
    let source = product
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("manual");
    let controls_macros = recalculate_product_macros && scope != "legacy" && source != "legacy";

    if !controls_macros {
        return (
            label,
            quantity,
            unit,
            serving_multiplier,
            required_f64_lossy(input, "proteinG"),
            required_f64_lossy(input, "carbsG"),
            required_f64_lossy(input, "fatG"),
            required_i32_lossy(input, "caloriesKcal"),
        );
    }

    let safe_quantity = if quantity.is_finite() && quantity > 0.0 {
        quantity
    } else {
        1.0
    };
    let safe_multiplier = if serving_multiplier.is_finite() && serving_multiplier > 0.0 {
        serving_multiplier
    } else {
        1.0
    };
    let factor = if unit == "g" || unit == "ml" {
        safe_quantity / 100.0
    } else {
        let base_amount = product
            .get("servingWeightG")
            .and_then(Value::as_f64)
            .or_else(|| product.get("servingVolumeMl").and_then(Value::as_f64))
            .unwrap_or(100.0);
        safe_quantity * safe_multiplier * base_amount / 100.0
    };
    let protein = round1(
        product
            .get("proteinPer100")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            * factor,
    );
    let carbs = round1(
        product
            .get("carbsPer100")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            * factor,
    );
    let fat = round1(
        product
            .get("fatPer100")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            * factor,
    );
    let calories = (product
        .get("caloriesPer100")
        .and_then(Value::as_i64)
        .unwrap_or(0) as f64
        * factor)
        .round() as i32;

    (
        label,
        quantity,
        unit,
        serving_multiplier,
        protein,
        carbs,
        fat,
        calories,
    )
}

/// A meal entry after validation, ready to be written. Previously returned as a
/// fourteen-element tuple whose `String`, `f64`, and `Option<Uuid>` fields were
/// distinguished only by position.
struct NormalizedMealEntry {
    date: String,
    meal_group_id: Option<Uuid>,
    status: String,
    product_id: Option<Uuid>,
    label: String,
    sort_order: i32,
    quantity: f64,
    unit: String,
    serving_multiplier: f64,
    macros: MacroValues,
    client_mutation_id: Option<String>,
}

async fn normalize_meal_input(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
    default_sort_order: i32,
    recalculate_product_macros: bool,
) -> AppResult<NormalizedMealEntry> {
    let date = required_date(input, "date")?;
    let meal_group_id = optional_uuid(input, "mealGroupId")?;
    assert_meal_group_access(pool, user_id, meal_group_id).await?;
    let product_id = optional_uuid(input, "productId")?;
    let sort_order = optional_i32(input, "sortOrder").unwrap_or(default_sort_order);
    if sort_order < 0 {
        return Err(AppError::BadRequest(
            "Sort order must be a non-negative integer.".to_string(),
        ));
    }
    let status = input
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("eaten")
        .to_string();
    if !matches!(status.as_str(), "planned" | "eaten" | "skipped") {
        return Err(AppError::BadRequest("Meal status is invalid.".to_string()));
    }
    let client_mutation_id = input
        .get("clientMutationId")
        .and_then(Value::as_str)
        .map(str::to_string);

    if let Some(product_id) = product_id {
        let product = food_product_json_by_id(pool, user_id, product_id)
            .await?
            .ok_or_else(|| AppError::NotFound("Food product not found.".to_string()))?;
        let (product_label, quantity, unit, serving_multiplier, protein, carbs, fat, calories) =
            nutrition_for_product(&product, input, recalculate_product_macros);
        let label = input
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|label| !label.trim().is_empty())
            .map(str::to_string)
            .unwrap_or(product_label);
        let macros = MacroValues {
            protein: round1(protein),
            carbs: round1(carbs),
            fat: round1(fat),
            calories,
        };
        validate_meal_components(
            &label,
            sort_order,
            quantity,
            &unit,
            serving_multiplier,
            &macros,
            "Meal name is required.",
        )?;
        return Ok(NormalizedMealEntry {
            date,
            meal_group_id,
            status,
            product_id: Some(product_id),
            label,
            sort_order,
            quantity,
            unit,
            serving_multiplier,
            macros,
            client_mutation_id,
        });
    }

    let values = normalize_meal_food_values(input, sort_order, "Meal name is required.")?;

    Ok(NormalizedMealEntry {
        date,
        meal_group_id,
        status,
        product_id: values.product_id,
        label: values.label,
        sort_order,
        quantity: values.quantity,
        unit: values.unit,
        serving_multiplier: values.serving_multiplier,
        macros: values.macros,
        client_mutation_id,
    })
}

async fn create_meal_entry_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let date = required_date(input, "date")?;
    let row = sqlx::query(
        "SELECT coalesce(max(sort_order), -1) + 1 AS sort_order FROM meal_entries WHERE user_id = $1 AND entry_date = $2::date",
    )
    .bind(user_id)
    .bind(&date)
    .fetch_one(pool)
    .await?;
    let next_sort_order: i32 = row.try_get("sort_order")?;
    let entry = normalize_meal_input(pool, user_id, input, next_sort_order, true).await?;

    let id = Uuid::new_v4();
    let inserted = sqlx::query(
        r#"
        INSERT INTO meal_entries (
          id, user_id, entry_date, meal_group_id, status, product_id, label,
          sort_order, quantity, unit, serving_multiplier, protein_g, carbs_g,
          fat_g, calories_kcal, client_mutation_id
        )
        VALUES (
          $1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
        )
        ON CONFLICT (user_id, client_mutation_id) DO NOTHING
        RETURNING id
        "#,
    )
    .bind(id)
    .bind(user_id)
    .bind(&entry.date)
    .bind(entry.meal_group_id)
    .bind(&entry.status)
    .bind(entry.product_id)
    .bind(&entry.label)
    .bind(entry.sort_order)
    .bind(entry.quantity)
    .bind(&entry.unit)
    .bind(entry.serving_multiplier)
    .bind(entry.macros.protein)
    .bind(entry.macros.carbs)
    .bind(entry.macros.fat)
    .bind(entry.macros.calories)
    .bind(entry.client_mutation_id.as_deref())
    .fetch_optional(pool)
    .await?;

    if let Some(row) = inserted {
        let created_id: Uuid = row.try_get("id")?;
        return meal_entry_json(pool, user_id, created_id).await;
    }

    if let Some(client_mutation_id) = entry.client_mutation_id {
        let existing = sqlx::query(
            "SELECT id FROM meal_entries WHERE user_id = $1 AND client_mutation_id = $2",
        )
        .bind(user_id)
        .bind(client_mutation_id)
        .fetch_one(pool)
        .await?;
        return meal_entry_json(pool, user_id, existing.try_get("id")?).await;
    }

    Err(AppError::Conflict(
        "Unable to create meal entry.".to_string(),
    ))
}

async fn update_meal_entry_json(
    pool: &PgPool,
    user_id: Uuid,
    entry_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let existing = sqlx::query(
        r#"
        SELECT jsonb_build_object(
          'date', entry_date,
          'mealGroupId', meal_group_id,
          'status', status,
          'productId', product_id,
          'label', label,
          'sortOrder', sort_order,
          'quantity', quantity::float8,
          'unit', unit,
          'servingMultiplier', serving_multiplier::float8,
          'proteinG', protein_g::float8,
          'carbsG', carbs_g::float8,
          'fatG', fat_g::float8,
          'caloriesKcal', calories_kcal,
          'clientMutationId', client_mutation_id
        ) AS data
        FROM meal_entries
        WHERE user_id = $1 AND id = $2
        "#,
    )
    .bind(user_id)
    .bind(entry_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound("Meal entry not found.".to_string()))?;
    let recalculate_product_macros = input
        .get("__recalculateProductMacros")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut merged = existing.try_get::<Value, _>("data")?;
    let merged_obj = merged
        .as_object_mut()
        .ok_or_else(|| AppError::BadRequest("Invalid meal entry.".to_string()))?;
    for (key, value) in input {
        if key == "__recalculateProductMacros" {
            continue;
        }
        merged_obj.insert(key.clone(), value.clone());
    }
    let entry =
        normalize_meal_input(pool, user_id, merged_obj, 0, recalculate_product_macros).await?;

    sqlx::query(
        r#"
        UPDATE meal_entries
        SET
          entry_date = $3::date,
          meal_group_id = $4,
          status = $5,
          product_id = $6,
          label = $7,
          sort_order = $8,
          quantity = $9,
          unit = $10,
          serving_multiplier = $11,
          protein_g = $12,
          carbs_g = $13,
          fat_g = $14,
          calories_kcal = $15,
          client_mutation_id = $16,
          updated_at = now()
        WHERE user_id = $1 AND id = $2
        "#,
    )
    .bind(user_id)
    .bind(entry_id)
    .bind(&entry.date)
    .bind(entry.meal_group_id)
    .bind(&entry.status)
    .bind(entry.product_id)
    .bind(&entry.label)
    .bind(entry.sort_order)
    .bind(entry.quantity)
    .bind(&entry.unit)
    .bind(entry.serving_multiplier)
    .bind(entry.macros.protein)
    .bind(entry.macros.carbs)
    .bind(entry.macros.fat)
    .bind(entry.macros.calories)
    .bind(entry.client_mutation_id.as_deref())
    .execute(pool)
    .await?;

    meal_entry_json(pool, user_id, entry_id).await
}

async fn meal_entry_json(pool: &PgPool, user_id: Uuid, entry_id: Uuid) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        SELECT jsonb_build_object(
          'id', me.id,
          'userId', me.user_id,
          'date', me.entry_date,
          'mealGroupId', me.meal_group_id,
          'status', me.status,
          'productId', CASE WHEN fp.id IS NULL THEN NULL ELSE me.product_id END,
          'label', me.label,
          'sortOrder', me.sort_order,
          'quantity', me.quantity::float8,
          'unit', me.unit,
          'servingMultiplier', me.serving_multiplier::float8,
          'proteinG', me.protein_g::float8,
          'carbsG', me.carbs_g::float8,
          'fatG', me.fat_g::float8,
          'caloriesKcal', me.calories_kcal,
          'clientMutationId', me.client_mutation_id,
          'sourceLabel', fp.name
        ) AS data
        FROM meal_entries me
        LEFT JOIN food_products fp
          ON fp.id = me.product_id
          AND fp.deleted_at IS NULL
          AND (fp.owner_user_id = me.user_id OR fp.owner_user_id IS NULL)
        WHERE me.user_id = $1 AND me.id = $2
        "#,
    )
    .bind(user_id)
    .bind(entry_id)
    .fetch_optional(pool)
    .await?;
    Ok(row
        .ok_or_else(|| AppError::NotFound("Meal entry not found.".to_string()))?
        .try_get("data")?)
}

/// Read back a batch of freshly written entries in one round trip, preserving
/// the caller's id order via `WITH ORDINALITY`.
async fn meal_entries_json_by_ids(
    pool: &PgPool,
    user_id: Uuid,
    entry_ids: &[Uuid],
) -> AppResult<Value> {
    if entry_ids.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }

    let row = sqlx::query(
        r#"
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
            'id', me.id,
            'userId', me.user_id,
            'date', me.entry_date,
            'mealGroupId', me.meal_group_id,
            'status', me.status,
            'productId', CASE WHEN fp.id IS NULL THEN NULL ELSE me.product_id END,
            'label', me.label,
            'sortOrder', me.sort_order,
            'quantity', me.quantity::float8,
            'unit', me.unit,
            'servingMultiplier', me.serving_multiplier::float8,
            'proteinG', me.protein_g::float8,
            'carbsG', me.carbs_g::float8,
            'fatG', me.fat_g::float8,
            'caloriesKcal', me.calories_kcal,
            'clientMutationId', me.client_mutation_id,
            'sourceLabel', fp.name
          )
          ORDER BY requested.ordinality
        ), '[]'::jsonb) AS data
        FROM unnest($2::uuid[]) WITH ORDINALITY AS requested(id, ordinality)
        JOIN meal_entries me ON me.id = requested.id AND me.user_id = $1
        LEFT JOIN food_products fp
          ON fp.id = me.product_id
          AND fp.deleted_at IS NULL
          AND (fp.owner_user_id = me.user_id OR fp.owner_user_id IS NULL)
        "#,
    )
    .bind(user_id)
    .bind(entry_ids)
    .fetch_one(pool)
    .await?;

    Ok(row.try_get("data")?)
}

async fn create_template_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let template_id = Uuid::new_v4();
    let template_type = required_string(input, "type")?;
    let label = required_string(input, "label")?;
    let notes = input.get("notes").and_then(Value::as_str);
    let items = input
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::BadRequest("A template must include at least one item.".to_string())
        })?;
    if items.is_empty() {
        return Err(AppError::BadRequest(
            "A template must include at least one item.".to_string(),
        ));
    }
    validate_item_product_access(pool, user_id, items).await?;
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO meal_templates (id, user_id, type, label, notes, updated_at) VALUES ($1, $2, $3, $4, $5, now())",
    )
    .bind(template_id)
    .bind(user_id)
    .bind(template_type)
    .bind(label)
    .bind(notes)
    .execute(&mut *tx)
    .await?;
    insert_template_items(&mut tx, template_id, items).await?;
    tx.commit().await?;
    template_by_id_json(pool, user_id, template_id).await
}

async fn update_template_json(
    pool: &PgPool,
    user_id: Uuid,
    template_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let template_type = required_string(input, "type")?;
    let label = required_string(input, "label")?;
    let notes = input.get("notes").and_then(Value::as_str);
    let items = input
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::BadRequest("A template must include at least one item.".to_string())
        })?;
    if items.is_empty() {
        return Err(AppError::BadRequest(
            "A template must include at least one item.".to_string(),
        ));
    }
    validate_item_product_access(pool, user_id, items).await?;
    let mut tx = pool.begin().await?;
    let updated = sqlx::query(
        "UPDATE meal_templates SET type = $3, label = $4, notes = $5, updated_at = now() WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING id",
    )
    .bind(user_id)
    .bind(template_id)
    .bind(template_type)
    .bind(label)
    .bind(notes)
    .fetch_optional(&mut *tx)
    .await?
    .is_some();
    if !updated {
        return Err(AppError::NotFound("Template not found.".to_string()));
    }
    sqlx::query("DELETE FROM meal_template_items WHERE template_id = $1")
        .bind(template_id)
        .execute(&mut *tx)
        .await?;
    insert_template_items(&mut tx, template_id, items).await?;
    tx.commit().await?;
    template_by_id_json(pool, user_id, template_id).await
}

async fn insert_template_items(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    template_id: Uuid,
    items: &[Value],
) -> AppResult<()> {
    if items.is_empty() {
        return Ok(());
    }

    let mut rows = TemplateItemColumns::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let item = item
            .as_object()
            .ok_or_else(|| AppError::BadRequest("Template item must be an object.".to_string()))?;
        let values = normalize_meal_food_values(item, index as i32, "Meal name is required.")?;
        rows.push(
            index as i32,
            trim_optional_string(item, "mealGroupLabel"),
            values,
        );
    }

    sqlx::query(
        r#"
        INSERT INTO meal_template_items (
          id, template_id, product_id, meal_group_label, sort_order, label,
          quantity, unit, serving_multiplier, protein_g, carbs_g, fat_g, calories_kcal
        )
        SELECT
          id, $1, product_id, meal_group_label, sort_order, label,
          quantity, unit, serving_multiplier, protein_g, carbs_g, fat_g, calories_kcal
        FROM unnest(
          $2::uuid[], $3::uuid[], $4::text[], $5::int[], $6::text[],
          $7::float8[], $8::text[], $9::float8[], $10::float8[], $11::float8[],
          $12::float8[], $13::int[]
        ) AS items(
          id, product_id, meal_group_label, sort_order, label,
          quantity, unit, serving_multiplier, protein_g, carbs_g, fat_g, calories_kcal
        )
        "#,
    )
    .bind(template_id)
    .bind(&rows.ids)
    .bind(&rows.product_ids)
    .bind(&rows.meal_group_labels)
    .bind(&rows.sort_orders)
    .bind(&rows.labels)
    .bind(&rows.quantities)
    .bind(&rows.units)
    .bind(&rows.serving_multipliers)
    .bind(&rows.proteins)
    .bind(&rows.carbs)
    .bind(&rows.fats)
    .bind(&rows.calories)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

/// Column-major staging buffer for a multi-row `unnest` insert. Template items
/// and recipe ingredients share every column except `meal_group_label`, which
/// recipe rows leave empty.
#[derive(Default)]
struct TemplateItemColumns {
    ids: Vec<Uuid>,
    product_ids: Vec<Option<Uuid>>,
    meal_group_labels: Vec<Option<String>>,
    sort_orders: Vec<i32>,
    labels: Vec<String>,
    quantities: Vec<f64>,
    units: Vec<String>,
    serving_multipliers: Vec<f64>,
    proteins: Vec<f64>,
    carbs: Vec<f64>,
    fats: Vec<f64>,
    calories: Vec<i32>,
}

impl TemplateItemColumns {
    fn with_capacity(capacity: usize) -> Self {
        Self {
            ids: Vec::with_capacity(capacity),
            product_ids: Vec::with_capacity(capacity),
            meal_group_labels: Vec::with_capacity(capacity),
            sort_orders: Vec::with_capacity(capacity),
            labels: Vec::with_capacity(capacity),
            quantities: Vec::with_capacity(capacity),
            units: Vec::with_capacity(capacity),
            serving_multipliers: Vec::with_capacity(capacity),
            proteins: Vec::with_capacity(capacity),
            carbs: Vec::with_capacity(capacity),
            fats: Vec::with_capacity(capacity),
            calories: Vec::with_capacity(capacity),
        }
    }

    fn push(&mut self, sort_order: i32, meal_group_label: Option<String>, values: MealFoodValues) {
        self.ids.push(Uuid::new_v4());
        self.product_ids.push(values.product_id);
        self.meal_group_labels.push(meal_group_label);
        self.sort_orders.push(sort_order);
        self.labels.push(values.label);
        self.quantities.push(values.quantity);
        self.units.push(values.unit);
        self.serving_multipliers.push(values.serving_multiplier);
        self.proteins.push(values.macros.protein);
        self.carbs.push(values.macros.carbs);
        self.fats.push(values.macros.fat);
        self.calories.push(values.macros.calories);
    }
}

async fn validate_item_product_access(
    pool: &PgPool,
    user_id: Uuid,
    items: &[Value],
) -> AppResult<()> {
    let mut product_ids = Vec::new();
    for item in items {
        let item = item
            .as_object()
            .ok_or_else(|| AppError::BadRequest("Item must be an object.".to_string()))?;
        if let Some(product_id) = optional_uuid(item, "productId")? {
            product_ids.push(product_id);
        }
    }

    assert_food_products_accessible(pool, user_id, &product_ids).await
}

/// Resolve access for a whole item list in one round trip. The per-item variant
/// issued a query each, which made template and recipe writes scale their
/// latency with item count.
async fn assert_food_products_accessible(
    pool: &PgPool,
    user_id: Uuid,
    product_ids: &[Uuid],
) -> AppResult<()> {
    let requested = product_ids.iter().copied().collect::<HashSet<_>>();
    if requested.is_empty() {
        return Ok(());
    }

    let accessible: i64 = sqlx::query(
        r#"
        SELECT count(*)::bigint AS accessible
        FROM (SELECT DISTINCT unnest($2::uuid[]) AS id) AS requested
        WHERE EXISTS (
          SELECT 1
          FROM food_products
          WHERE food_products.id = requested.id
            AND food_products.deleted_at IS NULL
            AND (food_products.owner_user_id = $1 OR food_products.owner_user_id IS NULL)
        )
        "#,
    )
    .bind(user_id)
    .bind(product_ids)
    .fetch_one(pool)
    .await?
    .try_get("accessible")?;

    if accessible == requested.len() as i64 {
        Ok(())
    } else {
        Err(AppError::NotFound("Food product not found.".to_string()))
    }
}

async fn template_by_id_json(pool: &PgPool, user_id: Uuid, template_id: Uuid) -> AppResult<Value> {
    first_json_item(templates_json_filtered(pool, user_id, Some(template_id)).await?)
        .ok_or_else(|| AppError::NotFound("Template not found.".to_string()))
}

/// Take ownership of the single row a filtered collection query returned.
fn first_json_item(value: Value) -> Option<Value> {
    match value {
        Value::Array(items) => items.into_iter().next(),
        _ => None,
    }
}

/// Maps a template's `mealGroupLabel` onto the user's live meal groups. An
/// exact match wins when it is unambiguous; otherwise a unique
/// case-insensitive match is accepted. Ambiguous labels stay ungrouped.
struct MealGroupLabelIndex {
    exact: HashMap<String, (Uuid, usize)>,
    case_insensitive: HashMap<String, (Uuid, usize)>,
}

impl MealGroupLabelIndex {
    async fn load(pool: &PgPool, user_id: Uuid) -> AppResult<Self> {
        let rows = sqlx::query(
            "SELECT id, label FROM meal_groups WHERE user_id = $1 AND deleted_at IS NULL",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await?;

        let mut index = Self {
            exact: HashMap::with_capacity(rows.len()),
            case_insensitive: HashMap::with_capacity(rows.len()),
        };
        for row in rows {
            let label: String = row.try_get("label")?;
            let id: Uuid = row.try_get("id")?;
            index
                .case_insensitive
                .entry(label.to_lowercase())
                .and_modify(|entry| entry.1 += 1)
                .or_insert((id, 1));
            index
                .exact
                .entry(label)
                .and_modify(|entry| entry.1 += 1)
                .or_insert((id, 1));
        }
        Ok(index)
    }

    fn resolve(&self, label: &str) -> Option<Uuid> {
        match self.exact.get(label) {
            Some((id, 1)) => return Some(*id),
            // An ambiguous exact match never falls through to the looser pass.
            Some(_) => return None,
            None => {}
        }

        match self.case_insensitive.get(&label.to_lowercase()) {
            Some((id, 1)) => Some(*id),
            _ => None,
        }
    }
}

async fn apply_template_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
    test_fault: Option<&serde_json::Map<String, Value>>,
) -> AppResult<Value> {
    let template_id = optional_uuid(input, "templateId")?
        .ok_or_else(|| AppError::BadRequest("templateId is required.".to_string()))?;
    let date = required_date(input, "date")?;
    let status = input
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("planned")
        .to_string();
    let template = template_by_id_json(pool, user_id, template_id).await?;
    let items = template
        .get("items")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::BadRequest("Template items missing.".to_string()))?;
    validate_item_product_access(pool, user_id, items).await?;
    let meal_groups = MealGroupLabelIndex::load(pool, user_id).await?;
    let row = sqlx::query(
        "SELECT coalesce(max(sort_order), -1) + 1 AS sort_order FROM meal_entries WHERE user_id = $1 AND entry_date = $2::date",
    )
    .bind(user_id)
    .bind(&date)
    .fetch_one(pool)
    .await?;
    let next_sort_order: i32 = row.try_get("sort_order")?;
    let mut normalized = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let mut meal = item
            .as_object()
            .ok_or_else(|| AppError::BadRequest("Template item must be an object.".to_string()))?
            .clone();
        let meal_group_id = item
            .get("mealGroupLabel")
            .and_then(Value::as_str)
            .and_then(|label| meal_groups.resolve(label));
        if let Some(meal_group_id) = meal_group_id {
            meal.insert("mealGroupId".to_string(), json!(meal_group_id));
        }
        meal.insert("date".to_string(), Value::String(date.clone()));
        meal.insert("status".to_string(), Value::String(status.clone()));
        normalized.push(
            normalize_meal_input(pool, user_id, &meal, next_sort_order + index as i32, true)
                .await?,
        );
    }

    let mut tx = pool.begin().await?;
    let mut created_ids = Vec::new();
    for (index, entry) in normalized.into_iter().enumerate() {
        maybe_trigger_test_fault(test_fault, index + 1)?;
        let id = Uuid::new_v4();
        let inserted = sqlx::query(
            r#"
            INSERT INTO meal_entries (
              id, user_id, entry_date, meal_group_id, status, product_id, label,
              sort_order, quantity, unit, serving_multiplier, protein_g, carbs_g,
              fat_g, calories_kcal, client_mutation_id
            )
            VALUES (
              $1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
            )
            ON CONFLICT (user_id, client_mutation_id) DO NOTHING
            RETURNING id
            "#,
        )
        .bind(id)
        .bind(user_id)
        .bind(&entry.date)
        .bind(entry.meal_group_id)
        .bind(&entry.status)
        .bind(entry.product_id)
        .bind(&entry.label)
        .bind(entry.sort_order)
        .bind(entry.quantity)
        .bind(&entry.unit)
        .bind(entry.serving_multiplier)
        .bind(entry.macros.protein)
        .bind(entry.macros.carbs)
        .bind(entry.macros.fat)
        .bind(entry.macros.calories)
        .bind(entry.client_mutation_id.as_deref())
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(row) = inserted {
            created_ids.push(row.try_get::<Uuid, _>("id")?);
        } else if let Some(client_mutation_id) = entry.client_mutation_id {
            let existing = sqlx::query(
                "SELECT id FROM meal_entries WHERE user_id = $1 AND client_mutation_id = $2",
            )
            .bind(user_id)
            .bind(client_mutation_id)
            .fetch_one(&mut *tx)
            .await?;
            created_ids.push(existing.try_get("id")?);
        } else {
            return Err(AppError::Conflict(
                "Unable to create meal entry.".to_string(),
            ));
        }
    }
    tx.commit().await?;

    meal_entries_json_by_ids(pool, user_id, &created_ids).await
}

async fn create_template_from_date_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let date = required_date(input, "date")?;
    let template_type = required_string(input, "type")?;
    let label = required_string(input, "label")?;
    let summary = daily_summary_json(pool, user_id, &date).await?;
    let groups = summary
        .get("mealGroups")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let group_label_by_id = groups
        .iter()
        .filter_map(|group| {
            Some((
                group.get("id")?.as_str()?.to_string(),
                group.get("label")?.as_str()?.to_string(),
            ))
        })
        .collect::<std::collections::HashMap<_, _>>();
    let items = summary
        .get("meals")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|meal| meal.get("status").and_then(Value::as_str) != Some("skipped"))
        .map(|meal| {
            let mut item = serde_json::Map::new();
            for key in [
                "productId",
                "label",
                "quantity",
                "unit",
                "servingMultiplier",
                "proteinG",
                "carbsG",
                "fatG",
                "caloriesKcal",
            ] {
                if let Some(value) = meal.get(key) {
                    item.insert(key.to_string(), value.clone());
                }
            }
            if let Some(meal_group_id) = meal.get("mealGroupId").and_then(Value::as_str)
                && let Some(label) = group_label_by_id.get(meal_group_id)
            {
                item.insert("mealGroupLabel".to_string(), Value::String(label.clone()));
            }
            Value::Object(item)
        })
        .collect::<Vec<_>>();
    let mut template = serde_json::Map::new();
    template.insert("type".to_string(), Value::String(template_type));
    template.insert("label".to_string(), Value::String(label));
    template.insert("items".to_string(), Value::Array(items));
    create_template_json(pool, user_id, &template).await
}

async fn create_food_product_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
    personal: bool,
) -> AppResult<Value> {
    let product_id = Uuid::new_v4();
    let mut normalized =
        normalize_food_product_input(input, if personal { "personal" } else { "global" })?;
    normalized.scope = if personal { "personal" } else { "global" }.to_string();
    if !personal
        && normalized.source == "barcode"
        && let Some(barcode) = normalized.barcode.as_deref()
        && active_global_barcode_exists(pool, barcode, None).await?
    {
        return Err(AppError::BadRequest(
            "That barcode already exists.".to_string(),
        ));
    }
    sqlx::query(
        r#"
        INSERT INTO food_products (
          id, owner_user_id, scope, source, barcode, name, brand,
          default_serving_quantity, default_serving_unit, protein_per_100,
          carbs_per_100, fat_per_100, calories_per_100, serving_weight_g,
          serving_volume_ml, submitted_by_user_id, source_provider,
          source_confidence, source_metadata, corrected_from_product_id,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, now()
        )
        "#,
    )
    .bind(product_id)
    .bind(if personal { Some(user_id) } else { None })
    .bind(normalized.scope)
    .bind(normalized.source)
    .bind(normalized.barcode.as_deref())
    .bind(normalized.name)
    .bind(normalized.brand)
    .bind(normalized.default_serving_quantity)
    .bind(normalized.default_serving_unit)
    .bind(normalized.macros.protein)
    .bind(normalized.macros.carbs)
    .bind(normalized.macros.fat)
    .bind(normalized.macros.calories)
    .bind(normalized.serving_weight_g)
    .bind(normalized.serving_volume_ml)
    .bind(Some(user_id))
    .bind(normalized.source_provider.as_deref())
    .bind(normalized.source_confidence)
    .bind(normalized.source_metadata)
    .bind(normalized.corrected_from_product_id)
    .execute(pool)
    .await?;
    let product = food_product_json_by_id(pool, user_id, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Food product not found.".to_string()))?;
    Ok(product)
}

async fn active_global_barcode_exists(
    pool: &PgPool,
    barcode: &str,
    exclude_product_id: Option<Uuid>,
) -> AppResult<bool> {
    active_global_barcode_exists_with_executor(pool, barcode, exclude_product_id).await
}

async fn active_global_barcode_exists_with_executor<'e, E>(
    executor: E,
    barcode: &str,
    exclude_product_id: Option<Uuid>,
) -> AppResult<bool>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let exists = sqlx::query(
        r#"
        SELECT id
        FROM food_products
        WHERE owner_user_id IS NULL
          AND source = 'barcode'
          AND deleted_at IS NULL
          AND barcode = $1
          AND ($2::uuid IS NULL OR id <> $2)
        LIMIT 1
        "#,
    )
    .bind(barcode.trim())
    .bind(exclude_product_id)
    .fetch_optional(executor)
    .await?
    .is_some();
    Ok(exists)
}

async fn lookup_barcode_food_product_json(
    pool: &PgPool,
    barcode: &str,
) -> AppResult<Option<Value>> {
    let row = sqlx::query(
        r#"
        SELECT jsonb_build_object(
          'id', id,
          'ownerUserId', owner_user_id,
          'scope', scope,
          'source', source,
          'barcode', barcode,
          'name', name,
          'brand', brand,
          'defaultServingQuantity', default_serving_quantity::float8,
          'defaultServingUnit', default_serving_unit,
          'proteinPer100', protein_per_100::float8,
          'carbsPer100', carbs_per_100::float8,
          'fatPer100', fat_per_100::float8,
          'caloriesPer100', calories_per_100,
          'servingWeightG', serving_weight_g::float8,
          'servingVolumeMl', serving_volume_ml::float8,
          'submittedByUserId', submitted_by_user_id,
          'deletedByUserId', deleted_by_user_id,
          'sourceProvider', source_provider,
          'sourceConfidence', source_confidence::float8,
          'sourceMetadata', source_metadata,
          'correctedFromProductId', corrected_from_product_id,
          'createdAt', created_at,
          'updatedAt', updated_at,
          'deletedAt', deleted_at
        ) AS data
        FROM food_products
        WHERE owner_user_id IS NULL
          AND source = 'barcode'
          AND deleted_at IS NULL
          AND barcode = $1
        ORDER BY updated_at DESC
        LIMIT 1
        "#,
    )
    .bind(barcode.trim())
    .fetch_optional(pool)
    .await?;

    row.map(|row| row.try_get("data"))
        .transpose()
        .map_err(Into::into)
}

fn normalize_barcode_food_product_input(
    input: &serde_json::Map<String, Value>,
) -> AppResult<serde_json::Map<String, Value>> {
    let serving_size_g = optional_positive_number(input, "servingSizeG", "Serving weight")?;
    let product_input = serde_json::Map::from_iter([
        ("scope".to_string(), Value::String("global".to_string())),
        ("source".to_string(), Value::String("barcode".to_string())),
        (
            "barcode".to_string(),
            Value::String(required_string_with_message(
                input,
                "barcode",
                "Barcode is required.",
            )?),
        ),
        (
            "name".to_string(),
            Value::String(required_string_with_message(
                input,
                "name",
                "Product name is required.",
            )?),
        ),
        (
            "brand".to_string(),
            Value::String(trim_optional_string(input, "brands").unwrap_or_default()),
        ),
        ("defaultServingQuantity".to_string(), json!(1.0)),
        (
            "defaultServingUnit".to_string(),
            Value::String("serving".to_string()),
        ),
        (
            "proteinPer100".to_string(),
            json!(required_f64(input, "proteinG")?),
        ),
        (
            "carbsPer100".to_string(),
            json!(required_f64(input, "carbsG")?),
        ),
        ("fatPer100".to_string(), json!(required_f64(input, "fatG")?)),
        (
            "caloriesPer100".to_string(),
            json!(required_i32(input, "caloriesKcal")?),
        ),
        (
            "servingWeightG".to_string(),
            json!(serving_size_g.unwrap_or(100.0)),
        ),
        ("servingVolumeMl".to_string(), Value::Null),
        (
            "sourceProvider".to_string(),
            Value::String("community".to_string()),
        ),
        (
            "sourceMetadata".to_string(),
            json!({ "servingSizeG": serving_size_g }),
        ),
    ]);
    normalize_food_product_input(&product_input, "global")?;
    Ok(product_input)
}

async fn save_barcode_food_product_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
    test_fault: Option<&serde_json::Map<String, Value>>,
) -> AppResult<Value> {
    let mut tx = pool.begin().await?;
    let (_, product) =
        save_barcode_food_product_with_executor(&mut tx, user_id, input, test_fault).await?;
    tx.commit().await?;
    Ok(product)
}

async fn save_barcode_food_product_with_executor(
    executor: &mut sqlx::PgConnection,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
    test_fault: Option<&serde_json::Map<String, Value>>,
) -> AppResult<(Uuid, Value)> {
    let product_input = normalize_barcode_food_product_input(input)?;
    let product_id = Uuid::new_v4();
    let mut normalized = normalize_food_product_input(&product_input, "global")?;
    normalized.scope = "global".to_string();

    if normalized.source == "barcode"
        && let Some(barcode) = normalized.barcode.as_deref()
        && active_global_barcode_exists_with_executor(&mut *executor, barcode, None).await?
    {
        return Err(AppError::BadRequest(
            "That barcode already exists.".to_string(),
        ));
    }

    sqlx::query(
        r#"
        INSERT INTO food_products (
          id, owner_user_id, scope, source, barcode, name, brand,
          default_serving_quantity, default_serving_unit, protein_per_100,
          carbs_per_100, fat_per_100, calories_per_100, serving_weight_g,
          serving_volume_ml, submitted_by_user_id, source_provider,
          source_confidence, source_metadata, corrected_from_product_id,
          updated_at
        )
        VALUES (
          $1, NULL, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now()
        )
        "#,
    )
    .bind(product_id)
    .bind(normalized.scope)
    .bind(normalized.source)
    .bind(normalized.barcode.as_deref())
    .bind(normalized.name)
    .bind(normalized.brand)
    .bind(normalized.default_serving_quantity)
    .bind(normalized.default_serving_unit)
    .bind(normalized.macros.protein)
    .bind(normalized.macros.carbs)
    .bind(normalized.macros.fat)
    .bind(normalized.macros.calories)
    .bind(normalized.serving_weight_g)
    .bind(normalized.serving_volume_ml)
    .bind(Some(user_id))
    .bind(normalized.source_provider.as_deref())
    .bind(normalized.source_confidence)
    .bind(normalized.source_metadata)
    .bind(normalized.corrected_from_product_id)
    .execute(&mut *executor)
    .await?;

    let product = food_product_json_by_id_with_executor(&mut *executor, user_id, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Food product not found.".to_string()))?;
    maybe_trigger_test_fault(test_fault, 1)?;
    insert_food_product_revision_with_executor(
        &mut *executor,
        product_id,
        Some(user_id),
        "created",
        product.clone(),
    )
    .await?;
    Ok((product_id, product))
}

async fn admin_dashboard_json(pool: &PgPool) -> AppResult<Value> {
    let counts = sqlx::query(
        r#"
        SELECT
          count(*)::int AS total_users,
          count(*) FILTER (WHERE role = 'owner')::int AS owner_count,
          count(*) FILTER (WHERE role = 'admin')::int AS admin_count,
          count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS new_users_last_7_days,
          count(*) FILTER (WHERE last_login_at >= now() - interval '7 days')::int AS active_users_last_7_days
        FROM users
        "#,
    )
    .fetch_one(pool)
    .await?;
    let barcode_counts = sqlx::query(
        r#"
        SELECT
          count(*) FILTER (WHERE deleted_at IS NULL)::int AS active_barcode_count,
          count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted_barcode_count
        FROM food_products
        WHERE owner_user_id IS NULL AND source = 'barcode'
        "#,
    )
    .fetch_one(pool)
    .await?;
    let recent_barcode_additions =
        admin_food_products_json(pool, 1, 5, false, &AdminBarcodeFilters::empty()).await?["items"]
            .clone();
    let recent_audit_events = list_admin_audit_events_json(
        pool,
        &serde_json::Map::from_iter([("pageSize".to_string(), json!(5))]),
    )
    .await?["items"]
        .clone();
    let health = admin_user_health_summary_json(pool).await?;
    Ok(json!({
        "totalUsers": counts.try_get::<i32, _>("total_users")?,
        "ownerCount": counts.try_get::<i32, _>("owner_count")?,
        "adminCount": counts.try_get::<i32, _>("admin_count")?,
        "newUsersLast7Days": counts.try_get::<i32, _>("new_users_last_7_days")?,
        "activeUsersLast7Days": counts.try_get::<i32, _>("active_users_last_7_days")?,
        "activeBarcodeCount": barcode_counts.try_get::<i32, _>("active_barcode_count")?,
        "deletedBarcodeCount": barcode_counts.try_get::<i32, _>("deleted_barcode_count")?,
        "recentBarcodeAdditions": recent_barcode_additions,
        "recentAuditEvents": recent_audit_events,
        "health": health
    }))
}

async fn admin_user_health_summary_json(pool: &PgPool) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        SELECT
          count(*) FILTER (
            WHERE onboarding_completed_at IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM meal_entries WHERE meal_entries.user_id = users.id)
          )::int AS onboarded_no_logs,
          count(*) FILTER (
            WHERE goal_calories_kcal IS NULL
              AND goal_protein_g IS NULL
              AND goal_carbs_g IS NULL
              AND goal_fat_g IS NULL
              AND goal_weight_kg IS NULL
          )::int AS no_goals,
          count(*) FILTER (WHERE last_login_at <= now() - interval '7 days')::int AS inactive7,
          count(*) FILTER (WHERE last_login_at <= now() - interval '30 days')::int AS inactive30,
          count(*) FILTER (
            WHERE NOT EXISTS (SELECT 1 FROM weight_entries WHERE weight_entries.user_id = users.id)
          )::int AS no_weight_entries,
          count(*) FILTER (
            WHERE (
              SELECT count(*)
              FROM food_products
              WHERE food_products.submitted_by_user_id = users.id
                AND food_products.source = 'barcode'
            ) >= 5
          )::int AS heavy_barcode_submitters
        FROM users
        "#,
    )
    .fetch_one(pool)
    .await?;
    Ok(json!({
        "segments": [
            { "id": "onboarded_no_logs", "label": "Onboarded but no logs", "count": row.try_get::<i32, _>("onboarded_no_logs")?, "href": "/admin/users?health=onboarded_no_logs" },
            { "id": "no_goals", "label": "No goals set", "count": row.try_get::<i32, _>("no_goals")?, "href": "/admin/users?health=no_goals" },
            { "id": "inactive7", "label": "Inactive 7+ days", "count": row.try_get::<i32, _>("inactive7")?, "href": "/admin/users?activity=inactive7" },
            { "id": "inactive30", "label": "Inactive 30+ days", "count": row.try_get::<i32, _>("inactive30")?, "href": "/admin/users?activity=inactive30" },
            { "id": "no_weight_entries", "label": "No weight entries", "count": row.try_get::<i32, _>("no_weight_entries")?, "href": "/admin/users?health=no_weight_entries" },
            { "id": "heavy_barcode_submitters", "label": "Heavy barcode submitters", "count": row.try_get::<i32, _>("heavy_barcode_submitters")?, "href": "/admin/users?health=heavy_barcode_submitters" }
        ]
    }))
}

async fn list_admin_users_json(
    pool: &PgPool,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let (page, page_size, offset) = pagination(input);
    let q = input
        .get("q")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{}%", value.replace('%', "\\%").replace('_', "\\_")));
    let role = input
        .get("role")
        .and_then(Value::as_str)
        .filter(|value| *value != "all");
    if let Some(role) = role
        && !matches!(role, "user" | "admin" | "owner")
    {
        return Err(AppError::BadRequest("User role is invalid.".to_string()));
    }
    let activity = input
        .get("activity")
        .and_then(Value::as_str)
        .filter(|value| *value != "all");
    if let Some(activity) = activity
        && !matches!(activity, "active7" | "inactive7" | "inactive30")
    {
        return Err(AppError::BadRequest(
            "User activity filter is invalid.".to_string(),
        ));
    }
    let health = input
        .get("health")
        .and_then(Value::as_str)
        .filter(|value| *value != "all");
    if let Some(health) = health
        && !matches!(
            health,
            "onboarded_no_logs" | "no_goals" | "no_weight_entries" | "heavy_barcode_submitters"
        )
    {
        return Err(AppError::BadRequest(
            "User health filter is invalid.".to_string(),
        ));
    }
    let rows = sqlx::query(
        r#"
        SELECT jsonb_build_object(
          'id', id,
          'email', email,
          'displayName', display_name,
          'pictureUrl', picture_url,
          'role', role,
          'createdAt', created_at,
          'lastLoginAt', last_login_at
        ) AS data
        FROM users
        WHERE ($1::text IS NULL OR email ILIKE $1 ESCAPE '\' OR display_name ILIKE $1 ESCAPE '\')
          AND ($4::text IS NULL OR role = $4)
          AND (
            $5::text IS NULL
            OR ($5 = 'active7' AND last_login_at >= now() - interval '7 days')
            OR ($5 = 'inactive7' AND last_login_at <= now() - interval '7 days')
            OR ($5 = 'inactive30' AND last_login_at <= now() - interval '30 days')
          )
          AND (
            $6::text IS NULL
            OR ($6 = 'onboarded_no_logs' AND onboarding_completed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM meal_entries WHERE meal_entries.user_id = users.id))
            OR ($6 = 'no_goals' AND goal_calories_kcal IS NULL AND goal_protein_g IS NULL AND goal_carbs_g IS NULL AND goal_fat_g IS NULL AND goal_weight_kg IS NULL)
            OR ($6 = 'no_weight_entries' AND NOT EXISTS (SELECT 1 FROM weight_entries WHERE weight_entries.user_id = users.id))
            OR ($6 = 'heavy_barcode_submitters' AND (SELECT count(*) FROM food_products WHERE food_products.submitted_by_user_id = users.id AND food_products.source = 'barcode') >= 5)
          )
        ORDER BY created_at DESC, email
        LIMIT $2 OFFSET $3
        "#,
    )
    .bind(q.as_deref())
    .bind(page_size)
    .bind(offset)
    .bind(role)
    .bind(activity)
    .bind(health)
    .fetch_all(pool)
    .await?;
    let total_row = sqlx::query(
        r#"
        SELECT count(*)::int AS total
        FROM users
        WHERE ($1::text IS NULL OR email ILIKE $1 ESCAPE '\' OR display_name ILIKE $1 ESCAPE '\')
          AND ($2::text IS NULL OR role = $2)
          AND (
            $3::text IS NULL
            OR ($3 = 'active7' AND last_login_at >= now() - interval '7 days')
            OR ($3 = 'inactive7' AND last_login_at <= now() - interval '7 days')
            OR ($3 = 'inactive30' AND last_login_at <= now() - interval '30 days')
          )
          AND (
            $4::text IS NULL
            OR ($4 = 'onboarded_no_logs' AND onboarding_completed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM meal_entries WHERE meal_entries.user_id = users.id))
            OR ($4 = 'no_goals' AND goal_calories_kcal IS NULL AND goal_protein_g IS NULL AND goal_carbs_g IS NULL AND goal_fat_g IS NULL AND goal_weight_kg IS NULL)
            OR ($4 = 'no_weight_entries' AND NOT EXISTS (SELECT 1 FROM weight_entries WHERE weight_entries.user_id = users.id))
            OR ($4 = 'heavy_barcode_submitters' AND (SELECT count(*) FROM food_products WHERE food_products.submitted_by_user_id = users.id AND food_products.source = 'barcode') >= 5)
          )
        "#,
    )
    .bind(q.as_deref())
    .bind(role)
    .bind(activity)
    .bind(health)
    .fetch_one(pool)
    .await?;
    let total: i32 = total_row.try_get("total")?;
    Ok(page_json(
        rows.into_iter()
            .map(|row| row.try_get("data"))
            .collect::<Result<Vec<Value>, _>>()?,
        page,
        page_size,
        total,
    ))
}

async fn get_admin_user_detail_json(pool: &PgPool, user_id: Uuid) -> AppResult<Value> {
    let Some(user) = get_user_by_id(pool, user_id).await? else {
        return Ok(Value::Null);
    };
    let counts = sqlx::query(
        r#"
        SELECT
          (SELECT count(*)::int FROM meal_entries WHERE user_id = $1) AS meal_entries,
          (SELECT count(*)::int FROM weight_entries WHERE user_id = $1) AS weight_entries,
          (SELECT count(*)::int FROM recipes WHERE user_id = $1) AS recipes,
          (SELECT count(*)::int FROM meal_templates WHERE user_id = $1 AND deleted_at IS NULL) AS templates,
          (SELECT count(*)::int FROM food_products WHERE submitted_by_user_id = $1 AND source = 'barcode') AS barcode_submissions
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    // Independent reads, so total latency should be their max rather than
    // their sum.
    let (recent_recipes, recent_templates, recent_weights, goals, recent_meals, recent_barcodes) =
        tokio::try_join!(
            recipes_json(pool, user_id),
            templates_json(pool, user_id),
            weight_entries_json(pool, user_id),
            get_user_goals(pool, user_id),
            list_recent_meal_entries_json(pool, user_id, 10, false),
            recent_barcode_submissions_json(pool, user_id, 10),
        )?;
    Ok(json!({
        "user": user,
        "goals": goals,
        "counts": {
            "mealEntries": counts.try_get::<i32, _>("meal_entries")?,
            "weightEntries": counts.try_get::<i32, _>("weight_entries")?,
            "recipes": counts.try_get::<i32, _>("recipes")?,
            "templates": counts.try_get::<i32, _>("templates")?,
            "barcodeSubmissions": counts.try_get::<i32, _>("barcode_submissions")?
        },
        "recentMeals": recent_meals,
        "recentWeights": recent_weights.as_array().cloned().unwrap_or_default().into_iter().rev().take(10).collect::<Vec<_>>(),
        "recentRecipes": recent_recipes.as_array().cloned().unwrap_or_default().into_iter().take(10).collect::<Vec<_>>(),
        "recentTemplates": recent_templates.as_array().cloned().unwrap_or_default().into_iter().take(10).collect::<Vec<_>>(),
        "recentBarcodeSubmissions": recent_barcodes
    }))
}

async fn recent_barcode_submissions_json(
    pool: &PgPool,
    user_id: Uuid,
    limit: i32,
) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
            'id', id,
            'ownerUserId', owner_user_id,
            'scope', scope,
            'source', source,
            'barcode', barcode,
            'name', name,
            'brand', brand,
            'defaultServingQuantity', default_serving_quantity::float8,
            'defaultServingUnit', default_serving_unit,
            'proteinPer100', protein_per_100::float8,
            'carbsPer100', carbs_per_100::float8,
            'fatPer100', fat_per_100::float8,
            'caloriesPer100', calories_per_100,
            'servingWeightG', serving_weight_g::float8,
            'servingVolumeMl', serving_volume_ml::float8,
            'submittedByUserId', submitted_by_user_id,
            'deletedByUserId', deleted_by_user_id,
            'sourceProvider', source_provider,
            'sourceConfidence', source_confidence::float8,
            'sourceMetadata', source_metadata,
            'correctedFromProductId', corrected_from_product_id,
            'createdAt', created_at,
            'updatedAt', updated_at,
            'deletedAt', deleted_at
          )
          ORDER BY created_at DESC, id
        ), '[]'::jsonb) AS data
        FROM (
          SELECT *
          FROM food_products
          WHERE submitted_by_user_id = $1 AND source = 'barcode'
          ORDER BY created_at DESC, id
          LIMIT $2
        ) recent
        "#,
    )
    .bind(user_id)
    .bind(limit)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn set_user_role_json(
    pool: &PgPool,
    actor_user_id: Uuid,
    target_user_id: Uuid,
    next_role: &str,
    audit_test_fault: Option<&serde_json::Map<String, Value>>,
) -> AppResult<Value> {
    if !matches!(next_role, "user" | "admin" | "owner") {
        return Err(AppError::BadRequest("User role is invalid.".to_string()));
    }

    let mut tx = pool.begin().await?;
    let actor = sqlx::query(
        r#"
        SELECT
          id,
          email,
          shoo_pairwise_sub,
          display_name,
          picture_url,
          role,
          created_at,
          last_login_at,
          goal_calories_kcal,
          goal_protein_g::float8 AS goal_protein_g,
          goal_carbs_g::float8 AS goal_carbs_g,
          goal_fat_g::float8 AS goal_fat_g,
          goal_weight_kg::float8 AS goal_weight_kg,
          onboarding_completed_at,
          preferred_weight_unit
        FROM users
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(actor_user_id)
    .fetch_optional(&mut *tx)
    .await?
    .map(row_to_app_user)
    .transpose()?
    .ok_or_else(|| AppError::Forbidden("Actor user not found.".to_string()))?;
    if actor.role != "owner" {
        return Err(AppError::Forbidden(
            "Only owners can change user roles.".to_string(),
        ));
    }

    let target = sqlx::query(
        r#"
        SELECT
          id,
          email,
          shoo_pairwise_sub,
          display_name,
          picture_url,
          role,
          created_at,
          last_login_at,
          goal_calories_kcal,
          goal_protein_g::float8 AS goal_protein_g,
          goal_carbs_g::float8 AS goal_carbs_g,
          goal_fat_g::float8 AS goal_fat_g,
          goal_weight_kg::float8 AS goal_weight_kg,
          onboarding_completed_at,
          preferred_weight_unit
        FROM users
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(target_user_id)
    .fetch_optional(&mut *tx)
    .await?
    .map(row_to_app_user)
    .transpose()?
    .ok_or_else(|| AppError::NotFound("User not found.".to_string()))?;
    if target.role == next_role {
        return Ok(serde_json::to_value(target)?);
    }
    if target.role == "owner" && next_role != "owner" {
        let owner_rows =
            sqlx::query("SELECT id FROM users WHERE role = 'owner' ORDER BY id FOR UPDATE")
                .fetch_all(&mut *tx)
                .await?;
        if owner_rows.len() <= 1 {
            return Err(AppError::BadRequest(
                "You cannot demote the last owner.".to_string(),
            ));
        }
    }

    let user = ensure_user_role_with_executor(&mut *tx, target_user_id, next_role).await?;
    maybe_trigger_test_fault(audit_test_fault, 1)?;
    insert_admin_audit_event_with_executor(
        &mut *tx,
        actor_user_id,
        &actor.role,
        "user.role_changed",
        "user",
        target_user_id,
        json!({
            "fromRole": target.role,
            "toRole": next_role,
            "targetEmail": target.email
        }),
    )
    .await?;
    tx.commit().await?;
    Ok(serde_json::to_value(user)?)
}

struct AdminBarcodeFilters {
    q_pattern: Option<String>,
    status: String,
    submitter_pattern: Option<String>,
}

impl AdminBarcodeFilters {
    fn from_input(input: &serde_json::Map<String, Value>) -> Self {
        let q_pattern = trim_optional_string(input, "q")
            .map(|value| format!("%{}%", escape_like_pattern(&value)));
        let status = match trim_optional_string(input, "status").as_deref() {
            Some("active") => "active",
            Some("deleted") => "deleted",
            _ => "all",
        }
        .to_string();
        let submitter_pattern = trim_optional_string(input, "submitter")
            .map(|value| format!("%{}%", escape_like_pattern(&value)));
        Self {
            q_pattern,
            status,
            submitter_pattern,
        }
    }

    fn empty() -> Self {
        Self {
            q_pattern: None,
            status: "all".to_string(),
            submitter_pattern: None,
        }
    }
}

async fn list_admin_barcode_products_json(
    pool: &PgPool,
    input: &serde_json::Map<String, Value>,
    review_queue: bool,
) -> AppResult<Value> {
    let (page, page_size, _offset) = pagination(input);
    let filters = if review_queue {
        AdminBarcodeFilters::empty()
    } else {
        AdminBarcodeFilters::from_input(input)
    };
    admin_food_products_json(pool, page, page_size, review_queue, &filters).await
}

async fn admin_food_products_json(
    pool: &PgPool,
    page: i64,
    page_size: i64,
    review_queue: bool,
    filters: &AdminBarcodeFilters,
) -> AppResult<Value> {
    let offset = (page - 1) * page_size;
    let rows = sqlx::query(
        r#"
        WITH barcode_products AS (
          SELECT
            fp.*,
            nullif(regexp_replace(lower(trim(fp.name)), '\s+', ' ', 'g'), '') AS review_name
          FROM food_products fp
          LEFT JOIN users submitter ON submitter.id = fp.submitted_by_user_id
          WHERE fp.owner_user_id IS NULL
            AND fp.source = 'barcode'
            AND (
              $4::text IS NULL
              OR fp.barcode ILIKE $4 ESCAPE '\'
              OR fp.name ILIKE $4 ESCAPE '\'
              OR fp.brand ILIKE $4 ESCAPE '\'
            )
            AND (
              $5 = 'all'
              OR ($5 = 'active' AND fp.deleted_at IS NULL)
              OR ($5 = 'deleted' AND fp.deleted_at IS NOT NULL)
            )
            AND ($6::text IS NULL OR submitter.email ILIKE $6 ESCAPE '\')
        ),
        duplicate_names AS (
          SELECT review_name, count(*)::int AS duplicate_name_count
          FROM barcode_products
          WHERE review_name IS NOT NULL
          GROUP BY review_name
        ),
        revision_counts AS (
          SELECT product_id, count(*)::int AS revision_count_30_days
          FROM food_product_revisions
          WHERE created_at >= now() - interval '30 days'
          GROUP BY product_id
        ),
        latest_audit AS (
          SELECT DISTINCT ON (target_id) target_id, action, created_at
          FROM admin_audit_events
          WHERE target_type = 'food_product'
            AND created_at >= now() - interval '30 days'
          ORDER BY target_id, created_at DESC
        ),
        recently_restored AS (
          SELECT target_id
          FROM admin_audit_events
          WHERE target_type = 'food_product'
            AND action = 'barcode.restored'
            AND created_at >= now() - interval '30 days'
          GROUP BY target_id
        ),
        review_candidates AS (
          SELECT
            bp.*,
            coalesce(rc.revision_count_30_days, 0) AS revision_count_30_days,
            coalesce(dn.duplicate_name_count, 0) AS duplicate_name_count,
            la.action AS latest_audit_action,
            la.created_at AS latest_audit_at,
            bp.deleted_at IS NOT NULL AND bp.deleted_at >= now() - interval '30 days' AS recently_deleted,
            rr.target_id IS NOT NULL AS recently_restored
          FROM barcode_products bp
          LEFT JOIN duplicate_names dn ON dn.review_name = bp.review_name
          LEFT JOIN revision_counts rc ON rc.product_id = bp.id
          LEFT JOIN latest_audit la ON la.target_id = bp.id::text
          LEFT JOIN recently_restored rr ON rr.target_id = bp.id::text
        )
        SELECT jsonb_build_object(
          'id', fp.id,
          'ownerUserId', fp.owner_user_id,
          'scope', fp.scope,
          'source', fp.source,
          'barcode', fp.barcode,
          'name', fp.name,
          'brand', fp.brand,
          'defaultServingQuantity', fp.default_serving_quantity::float8,
          'defaultServingUnit', fp.default_serving_unit,
          'proteinPer100', fp.protein_per_100::float8,
          'carbsPer100', fp.carbs_per_100::float8,
          'fatPer100', fp.fat_per_100::float8,
          'caloriesPer100', fp.calories_per_100,
          'servingWeightG', fp.serving_weight_g::float8,
          'servingVolumeMl', fp.serving_volume_ml::float8,
          'submittedByUserId', fp.submitted_by_user_id,
          'deletedByUserId', fp.deleted_by_user_id,
          'sourceProvider', fp.source_provider,
          'sourceConfidence', fp.source_confidence::float8,
          'sourceMetadata', fp.source_metadata,
          'correctedFromProductId', fp.corrected_from_product_id,
          'createdAt', fp.created_at,
          'updatedAt', fp.updated_at,
          'deletedAt', fp.deleted_at,
          'reviewReasons', CASE WHEN $3 THEN
            (CASE WHEN fp.source_confidence IS NOT NULL AND fp.source_confidence < 0.75 THEN jsonb_build_array('low_confidence') ELSE '[]'::jsonb END)
            || (CASE WHEN fp.serving_weight_g IS NULL AND fp.serving_volume_ml IS NULL THEN jsonb_build_array('missing_serving_size') ELSE '[]'::jsonb END)
            || (CASE WHEN fp.recently_deleted THEN jsonb_build_array('recently_deleted') ELSE '[]'::jsonb END)
            || (CASE WHEN fp.recently_restored THEN jsonb_build_array('recently_restored') ELSE '[]'::jsonb END)
            || (CASE WHEN fp.duplicate_name_count > 1 THEN jsonb_build_array('duplicate_name') ELSE '[]'::jsonb END)
            || (CASE WHEN fp.revision_count_30_days >= 3 THEN jsonb_build_array('frequent_revisions') ELSE '[]'::jsonb END)
          ELSE '[]'::jsonb END,
          'revisionCount30Days', fp.revision_count_30_days,
          'duplicateNameCount', fp.duplicate_name_count,
          'latestAuditAction', fp.latest_audit_action,
          'latestAuditAt', fp.latest_audit_at
        ) AS data
        FROM review_candidates fp
        WHERE NOT $3
          OR (
            (fp.source_confidence IS NOT NULL AND fp.source_confidence < 0.75)
            OR (fp.serving_weight_g IS NULL AND fp.serving_volume_ml IS NULL)
            OR fp.recently_deleted
            OR fp.recently_restored
            OR fp.duplicate_name_count > 1
            OR fp.revision_count_30_days >= 3
          )
        ORDER BY fp.updated_at DESC, fp.created_at DESC
        LIMIT $1 OFFSET $2
        "#,
    )
    .bind(page_size)
    .bind(offset)
    .bind(review_queue)
    .bind(filters.q_pattern.as_deref())
    .bind(filters.status.as_str())
    .bind(filters.submitter_pattern.as_deref())
    .fetch_all(pool)
    .await?;
    let total_row = sqlx::query(
        r#"
        WITH barcode_products AS (
          SELECT
            fp.*,
            nullif(regexp_replace(lower(trim(fp.name)), '\s+', ' ', 'g'), '') AS review_name
          FROM food_products fp
          LEFT JOIN users submitter ON submitter.id = fp.submitted_by_user_id
          WHERE fp.owner_user_id IS NULL
            AND fp.source = 'barcode'
            AND (
              $2::text IS NULL
              OR fp.barcode ILIKE $2 ESCAPE '\'
              OR fp.name ILIKE $2 ESCAPE '\'
              OR fp.brand ILIKE $2 ESCAPE '\'
            )
            AND (
              $3 = 'all'
              OR ($3 = 'active' AND fp.deleted_at IS NULL)
              OR ($3 = 'deleted' AND fp.deleted_at IS NOT NULL)
            )
            AND ($4::text IS NULL OR submitter.email ILIKE $4 ESCAPE '\')
        ),
        duplicate_names AS (
          SELECT review_name, count(*)::int AS duplicate_name_count
          FROM barcode_products
          WHERE review_name IS NOT NULL
          GROUP BY review_name
        ),
        revision_counts AS (
          SELECT product_id, count(*)::int AS revision_count_30_days
          FROM food_product_revisions
          WHERE created_at >= now() - interval '30 days'
          GROUP BY product_id
        ),
        recently_restored AS (
          SELECT target_id
          FROM admin_audit_events
          WHERE target_type = 'food_product'
            AND action = 'barcode.restored'
            AND created_at >= now() - interval '30 days'
          GROUP BY target_id
        ),
        review_candidates AS (
          SELECT
            bp.*,
            coalesce(rc.revision_count_30_days, 0) AS revision_count_30_days,
            coalesce(dn.duplicate_name_count, 0) AS duplicate_name_count,
            bp.deleted_at IS NOT NULL AND bp.deleted_at >= now() - interval '30 days' AS recently_deleted,
            rr.target_id IS NOT NULL AS recently_restored
          FROM barcode_products bp
          LEFT JOIN duplicate_names dn ON dn.review_name = bp.review_name
          LEFT JOIN revision_counts rc ON rc.product_id = bp.id
          LEFT JOIN recently_restored rr ON rr.target_id = bp.id::text
        )
        SELECT count(*)::int AS total
        FROM review_candidates fp
        WHERE NOT $1
          OR (
            (fp.source_confidence IS NOT NULL AND fp.source_confidence < 0.75)
            OR (fp.serving_weight_g IS NULL AND fp.serving_volume_ml IS NULL)
            OR fp.recently_deleted
            OR fp.recently_restored
            OR fp.duplicate_name_count > 1
            OR fp.revision_count_30_days >= 3
          )
        "#,
    )
    .bind(review_queue)
    .bind(filters.q_pattern.as_deref())
    .bind(filters.status.as_str())
    .bind(filters.submitter_pattern.as_deref())
    .fetch_one(pool)
    .await?;
    let total: i32 = total_row.try_get("total")?;
    Ok(page_json(
        rows.into_iter()
            .map(|row| row.try_get("data"))
            .collect::<Result<Vec<Value>, _>>()?,
        page,
        page_size,
        total,
    ))
}

async fn admin_food_product_by_id_json(
    pool: &PgPool,
    product_id: Uuid,
) -> AppResult<Option<Value>> {
    admin_food_product_by_id_json_with_executor(pool, product_id).await
}

async fn admin_food_product_by_id_json_with_executor<'e, E>(
    executor: E,
    product_id: Uuid,
) -> AppResult<Option<Value>>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let row = sqlx::query(
        r#"
        SELECT jsonb_build_object(
          'id', id,
          'ownerUserId', owner_user_id,
          'scope', scope,
          'source', source,
          'barcode', barcode,
          'name', name,
          'brand', brand,
          'defaultServingQuantity', default_serving_quantity::float8,
          'defaultServingUnit', default_serving_unit,
          'proteinPer100', protein_per_100::float8,
          'carbsPer100', carbs_per_100::float8,
          'fatPer100', fat_per_100::float8,
          'caloriesPer100', calories_per_100,
          'servingWeightG', serving_weight_g::float8,
          'servingVolumeMl', serving_volume_ml::float8,
          'submittedByUserId', submitted_by_user_id,
          'deletedByUserId', deleted_by_user_id,
          'sourceProvider', source_provider,
          'sourceConfidence', source_confidence::float8,
          'sourceMetadata', source_metadata,
          'correctedFromProductId', corrected_from_product_id,
          'createdAt', created_at,
          'updatedAt', updated_at,
          'deletedAt', deleted_at
        ) AS data
        FROM food_products
        WHERE id = $1 AND owner_user_id IS NULL AND source = 'barcode'
        "#,
    )
    .bind(product_id)
    .fetch_optional(executor)
    .await?;
    row.map(|row| row.try_get("data"))
        .transpose()
        .map_err(Into::into)
}

async fn require_admin_actor(pool: &PgPool, actor_user_id: Uuid) -> AppResult<AdminActor> {
    let row = sqlx::query("SELECT id, role FROM users WHERE id = $1")
        .bind(actor_user_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::Forbidden("Admin actor not found.".to_string()))?;
    let role: String = row.try_get("role")?;
    if !is_admin_actor_role(&role) {
        return Err(AppError::Forbidden("Admin access is required.".to_string()));
    }
    Ok(AdminActor {
        id: row.try_get("id")?,
        role,
    })
}

fn is_admin_actor_role(role: &str) -> bool {
    matches!(role, "admin" | "owner")
}

async fn create_admin_barcode_product_json(
    pool: &PgPool,
    actor_user_id: Uuid,
    input: &serde_json::Map<String, Value>,
    audit_test_fault: Option<&serde_json::Map<String, Value>>,
) -> AppResult<Value> {
    let actor = require_admin_actor(pool, actor_user_id).await?;
    let mut tx = pool.begin().await?;
    let (product_id, product) =
        save_barcode_food_product_with_executor(&mut tx, actor.id, input, None).await?;
    maybe_trigger_test_fault(audit_test_fault, 1)?;
    insert_admin_audit_event_with_executor(
        &mut *tx,
        actor.id,
        &actor.role,
        "barcode.created",
        "food_product",
        product_id,
        json!({
            "barcode": product.get("barcode").cloned().unwrap_or(Value::Null),
            "name": product.get("name").cloned().unwrap_or(Value::Null)
        }),
    )
    .await?;
    tx.commit().await?;
    Ok(product)
}

async fn update_admin_barcode_product_json(
    pool: &PgPool,
    actor_user_id: Uuid,
    product_id: Uuid,
    input: &serde_json::Map<String, Value>,
    revision_test_fault: Option<&serde_json::Map<String, Value>>,
    audit_test_fault: Option<&serde_json::Map<String, Value>>,
) -> AppResult<Value> {
    let actor = require_admin_actor(pool, actor_user_id).await?;
    let product_input = normalize_barcode_food_product_input(input)?;
    let normalized = normalize_food_product_input(&product_input, "global")?;
    let barcode = normalized
        .barcode
        .as_deref()
        .ok_or_else(|| AppError::BadRequest("Barcode is required.".to_string()))?;

    let mut tx = pool.begin().await?;
    let before = admin_food_product_by_id_json_with_executor(&mut *tx, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Barcode product not found.".to_string()))?;
    if active_global_barcode_exists_with_executor(&mut *tx, barcode, Some(product_id)).await? {
        return Err(AppError::BadRequest(
            "That barcode already exists.".to_string(),
        ));
    }
    let updated = sqlx::query(
        r#"
        UPDATE food_products
        SET
          barcode = $2,
          name = $3,
          brand = $4,
          default_serving_quantity = $5,
          default_serving_unit = $6,
          protein_per_100 = $7,
          carbs_per_100 = $8,
          fat_per_100 = $9,
          calories_per_100 = $10,
          serving_weight_g = $11,
          serving_volume_ml = NULL,
          source_provider = coalesce($12, source_provider),
          source_metadata = $13,
          updated_at = now()
        WHERE id = $1 AND owner_user_id IS NULL AND source = 'barcode'
        RETURNING id
        "#,
    )
    .bind(product_id)
    .bind(normalized.barcode.as_deref())
    .bind(normalized.name)
    .bind(normalized.brand)
    .bind(normalized.default_serving_quantity)
    .bind(normalized.default_serving_unit)
    .bind(normalized.macros.protein)
    .bind(normalized.macros.carbs)
    .bind(normalized.macros.fat)
    .bind(normalized.macros.calories)
    .bind(normalized.serving_weight_g)
    .bind(normalized.source_provider.as_deref())
    .bind(normalized.source_metadata)
    .fetch_optional(&mut *tx)
    .await?
    .is_some();
    if !updated {
        return Err(AppError::NotFound("Barcode product not found.".to_string()));
    }
    let product = admin_food_product_by_id_json_with_executor(&mut *tx, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Barcode product not found.".to_string()))?;
    maybe_trigger_test_fault(revision_test_fault, 1)?;
    insert_food_product_revision_with_executor(
        &mut *tx,
        product_id,
        Some(actor.id),
        "updated",
        product.clone(),
    )
    .await?;
    maybe_trigger_test_fault(audit_test_fault, 1)?;
    insert_admin_audit_event_with_executor(
        &mut *tx,
        actor.id,
        &actor.role,
        "barcode.updated",
        "food_product",
        product_id,
        json!({
            "before": before,
            "after": product
        }),
    )
    .await?;
    tx.commit().await?;
    admin_food_product_by_id_json(pool, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Barcode product not found.".to_string()))
}

async fn set_admin_barcode_deleted_json(
    pool: &PgPool,
    actor_user_id: Uuid,
    product_id: Uuid,
    deleted: bool,
    revision_test_fault: Option<&serde_json::Map<String, Value>>,
    audit_test_fault: Option<&serde_json::Map<String, Value>>,
) -> AppResult<Value> {
    let actor = require_admin_actor(pool, actor_user_id).await?;
    let mut tx = pool.begin().await?;
    let existing = admin_food_product_by_id_json_with_executor(&mut *tx, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Barcode product not found.".to_string()))?;
    let already_deleted = existing
        .get("deletedAt")
        .is_some_and(|value| !value.is_null());
    if deleted && already_deleted {
        return Ok(existing);
    }
    if !deleted && !already_deleted {
        return Ok(existing);
    }
    if !deleted
        && let Some(barcode) = existing.get("barcode").and_then(Value::as_str)
        && active_global_barcode_exists_with_executor(&mut *tx, barcode, Some(product_id)).await?
    {
        return Err(AppError::BadRequest(
            "That barcode already exists.".to_string(),
        ));
    }
    let row = sqlx::query(
        r#"
        UPDATE food_products
        SET
          deleted_at = CASE WHEN $3 THEN coalesce(deleted_at, now()) ELSE NULL END,
          deleted_by_user_id = CASE WHEN $3 THEN $1 ELSE NULL END,
          updated_at = now()
        WHERE id = $2 AND owner_user_id IS NULL AND source = 'barcode'
        RETURNING id
        "#,
    )
    .bind(actor.id)
    .bind(product_id)
    .bind(deleted)
    .fetch_optional(&mut *tx)
    .await?;
    if row.is_none() {
        return Err(AppError::NotFound("Barcode product not found.".to_string()));
    }
    let product = admin_food_product_by_id_json_with_executor(&mut *tx, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Barcode product not found.".to_string()))?;
    maybe_trigger_test_fault(revision_test_fault, 1)?;
    insert_food_product_revision_with_executor(
        &mut *tx,
        product_id,
        Some(actor.id),
        if deleted { "deleted" } else { "restored" },
        product,
    )
    .await?;
    maybe_trigger_test_fault(audit_test_fault, 1)?;
    insert_admin_audit_event_with_executor(
        &mut *tx,
        actor.id,
        &actor.role,
        if deleted {
            "barcode.deleted"
        } else {
            "barcode.restored"
        },
        "food_product",
        product_id,
        json!({
            "barcode": existing.get("barcode").cloned().unwrap_or(Value::Null),
            "name": existing.get("name").cloned().unwrap_or(Value::Null)
        }),
    )
    .await?;
    tx.commit().await?;
    admin_food_product_by_id_json(pool, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Barcode product not found.".to_string()))
}

async fn insert_food_product_revision_with_executor<'e, E>(
    executor: E,
    product_id: Uuid,
    actor_user_id: Option<Uuid>,
    action: &str,
    snapshot: Value,
) -> AppResult<()>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query(
        r#"
        INSERT INTO food_product_revisions (
          id, product_id, actor_user_id, action, snapshot_json
        )
        VALUES ($1, $2, $3, $4, $5)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(product_id)
    .bind(actor_user_id)
    .bind(action)
    .bind(snapshot)
    .execute(executor)
    .await?;
    Ok(())
}

async fn insert_admin_audit_event_with_executor<'e, E>(
    executor: E,
    actor_user_id: Uuid,
    actor_role: &str,
    action: &str,
    target_type: &str,
    target_id: Uuid,
    details: Value,
) -> AppResult<()>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    sqlx::query(
        r#"
        INSERT INTO admin_audit_events (
          id, actor_user_id, actor_role, action, target_type, target_id, details_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(actor_user_id)
    .bind(actor_role)
    .bind(action)
    .bind(target_type)
    .bind(target_id.to_string())
    .bind(details)
    .execute(executor)
    .await?;
    Ok(())
}

async fn list_admin_audit_events_json(
    pool: &PgPool,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let (page, page_size, offset) = pagination(input);
    let target_type = input.get("targetType").and_then(Value::as_str);
    let target_id = input.get("targetId").and_then(Value::as_str);
    let rows = sqlx::query(
        r#"
        SELECT jsonb_build_object(
          'id', ae.id,
          'actorUserId', ae.actor_user_id,
          'actorEmail', u.email,
          'actorDisplayName', u.display_name,
          'actorRole', ae.actor_role,
          'action', ae.action,
          'targetType', ae.target_type,
          'targetId', ae.target_id,
          'details', ae.details_json,
          'createdAt', ae.created_at
        ) AS data
        FROM admin_audit_events ae
        LEFT JOIN users u ON u.id = ae.actor_user_id
        WHERE ($3::text IS NULL OR ae.target_type = $3)
          AND ($4::text IS NULL OR ae.target_id = $4)
        ORDER BY ae.created_at DESC
        LIMIT $1 OFFSET $2
        "#,
    )
    .bind(page_size)
    .bind(offset)
    .bind(target_type)
    .bind(target_id)
    .fetch_all(pool)
    .await?;
    let total_row = sqlx::query(
        r#"
        SELECT count(*)::int AS total
        FROM admin_audit_events
        WHERE ($1::text IS NULL OR target_type = $1)
          AND ($2::text IS NULL OR target_id = $2)
        "#,
    )
    .bind(target_type)
    .bind(target_id)
    .fetch_one(pool)
    .await?;
    let total: i32 = total_row.try_get("total")?;
    Ok(page_json(
        rows.into_iter()
            .map(|row| row.try_get("data"))
            .collect::<Result<Vec<Value>, _>>()?,
        page,
        page_size,
        total,
    ))
}

async fn get_admin_audit_event_json(pool: &PgPool, event_id: Uuid) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        SELECT jsonb_build_object(
          'id', ae.id,
          'actorUserId', ae.actor_user_id,
          'actorEmail', u.email,
          'actorDisplayName', u.display_name,
          'actorRole', ae.actor_role,
          'action', ae.action,
          'targetType', ae.target_type,
          'targetId', ae.target_id,
          'details', ae.details_json,
          'createdAt', ae.created_at
        ) AS data
        FROM admin_audit_events ae
        LEFT JOIN users u ON u.id = ae.actor_user_id
        WHERE ae.id = $1
        "#,
    )
    .bind(event_id)
    .fetch_optional(pool)
    .await?;
    Ok(row
        .map(|row| row.try_get("data"))
        .transpose()?
        .unwrap_or(Value::Null))
}

async fn create_api_token_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let name = required_string(input, "name")?;
    let scopes = normalize_api_token_scopes(input.get("scopes"))?;
    let token_secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("mtk_v1_{token_secret}");
    let token_hash = hash_token(&token);
    let token_prefix = format!("mtk_v1_{}", &token_hash[..12]);
    let expires_at = normalize_api_token_expiry(input.get("expiresAt"))?;
    let row = sqlx::query(
        r#"
        INSERT INTO api_tokens (
          id, user_id, token_hash, token_prefix, name, scopes, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
        RETURNING
          id,
          user_id,
          token_prefix,
          name,
          scopes,
          created_at,
          last_used_at,
          expires_at,
          revoked_at
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(token_hash)
    .bind(token_prefix)
    .bind(name)
    .bind(Value::Array(
        scopes.into_iter().map(Value::String).collect(),
    ))
    .bind(expires_at)
    .fetch_one(pool)
    .await?;
    Ok(json!({
        "token": token,
        "record": api_token_row_json(&row)?
    }))
}

fn normalize_api_token_scopes(scopes: Option<&Value>) -> AppResult<Vec<String>> {
    let scopes = scopes
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::BadRequest("API token scopes are required.".to_string()))?;
    if scopes.is_empty() {
        return Err(AppError::BadRequest(
            "API token must include at least one scope.".to_string(),
        ));
    }

    let allowed = API_SCOPE_VALUES.iter().copied().collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for scope in scopes {
        let Some(scope) = scope.as_str() else {
            return Err(AppError::BadRequest(
                "API token scope is invalid.".to_string(),
            ));
        };
        if !allowed.contains(scope) {
            return Err(AppError::BadRequest(
                "API token scope is invalid.".to_string(),
            ));
        }
        if seen.insert(scope.to_string()) {
            normalized.push(scope.to_string());
        }
    }

    Ok(normalized)
}

fn normalize_api_token_expiry(expires_at: Option<&Value>) -> AppResult<Option<DateTime<Utc>>> {
    match expires_at {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => DateTime::parse_from_rfc3339(value)
            .map(|date| Some(date.with_timezone(&Utc)))
            .map_err(|_| AppError::BadRequest("API token expiry is invalid.".to_string())),
        None => Ok(Some(Utc::now() + Duration::days(90))),
        Some(_) => Err(AppError::BadRequest(
            "API token expiry is invalid.".to_string(),
        )),
    }
}

async fn list_api_tokens_json(pool: &PgPool, user_id: Uuid) -> AppResult<Value> {
    let rows = sqlx::query(
        r#"
        SELECT
          id,
          user_id,
          token_prefix,
          name,
          scopes,
          created_at,
          last_used_at,
          expires_at,
          revoked_at
        FROM api_tokens
        WHERE user_id = $1
        ORDER BY created_at DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    let records = rows
        .iter()
        .map(api_token_row_json)
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Value::Array(records))
}

fn api_token_row_json(row: &PgRow) -> AppResult<Value> {
    let id: Uuid = row.try_get("id")?;
    let user_id: Uuid = row.try_get("user_id")?;
    let scopes: Value = row.try_get("scopes")?;
    let created_at: DateTime<Utc> = row.try_get("created_at")?;
    let last_used_at: Option<DateTime<Utc>> = row.try_get("last_used_at")?;
    let expires_at: Option<DateTime<Utc>> = row.try_get("expires_at")?;
    let revoked_at: Option<DateTime<Utc>> = row.try_get("revoked_at")?;
    Ok(json!({
        "id": id,
        "userId": user_id,
        "tokenPrefix": row.try_get::<String, _>("token_prefix")?,
        "name": row.try_get::<String, _>("name")?,
        "scopes": scopes,
        "createdAt": created_at,
        "lastUsedAt": last_used_at,
        "expiresAt": expires_at,
        "revokedAt": revoked_at
    }))
}

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    format!("{:x}", hasher.finalize())
}

async fn update_food_product_json(
    pool: &PgPool,
    user_id: Uuid,
    product_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let mut normalized = normalize_food_product_input(input, "personal")?;
    normalized.scope = "personal".to_string();
    let updated = sqlx::query(
        r#"
        UPDATE food_products
        SET
          source = $3,
          barcode = $4,
          name = $5,
          brand = $6,
          default_serving_quantity = $7,
          default_serving_unit = $8,
          protein_per_100 = $9,
          carbs_per_100 = $10,
          fat_per_100 = $11,
          calories_per_100 = $12,
          serving_weight_g = $13,
          serving_volume_ml = $14,
          source_provider = NULL,
          source_confidence = NULL,
          source_metadata = '{}'::jsonb,
          corrected_from_product_id = NULL,
          updated_at = now()
        WHERE id = $2 AND owner_user_id = $1 AND deleted_at IS NULL
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(product_id)
    .bind(normalized.source)
    .bind(normalized.barcode.as_deref())
    .bind(normalized.name)
    .bind(normalized.brand)
    .bind(normalized.default_serving_quantity)
    .bind(normalized.default_serving_unit)
    .bind(normalized.macros.protein)
    .bind(normalized.macros.carbs)
    .bind(normalized.macros.fat)
    .bind(normalized.macros.calories)
    .bind(normalized.serving_weight_g)
    .bind(normalized.serving_volume_ml)
    .fetch_optional(pool)
    .await?
    .is_some();
    if !updated {
        return Err(AppError::NotFound("Food product not found.".to_string()));
    }
    food_product_json_by_id(pool, user_id, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Food product not found.".to_string()))
}

async fn create_recipe_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
    test_fault: Option<&serde_json::Map<String, Value>>,
) -> AppResult<Value> {
    let recipe_id = Uuid::new_v4();
    let recipe = parse_recipe_input(input)?;
    validate_item_product_access(pool, user_id, recipe.ingredients).await?;
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO recipes (id, user_id, label, portions, total_cooked_weight_g, updated_at) VALUES ($1, $2, $3, $4, $5, now())",
    )
    .bind(recipe_id)
    .bind(user_id)
    .bind(recipe.label)
    .bind(recipe.portions)
    .bind(recipe.total_cooked_weight_g)
    .execute(&mut *tx)
    .await?;
    insert_recipe_ingredients(&mut tx, recipe_id, recipe.ingredients, test_fault).await?;
    tx.commit().await?;
    recipe_by_id_json(pool, user_id, recipe_id).await
}

async fn update_recipe_json(
    pool: &PgPool,
    user_id: Uuid,
    recipe_id: Uuid,
    input: &serde_json::Map<String, Value>,
    test_fault: Option<&serde_json::Map<String, Value>>,
) -> AppResult<Value> {
    let recipe = parse_recipe_input(input)?;
    validate_item_product_access(pool, user_id, recipe.ingredients).await?;
    let mut tx = pool.begin().await?;
    let updated = sqlx::query(
        "UPDATE recipes SET label = $3, portions = $4, total_cooked_weight_g = $5, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING id",
    )
    .bind(user_id)
    .bind(recipe_id)
    .bind(recipe.label)
    .bind(recipe.portions)
    .bind(recipe.total_cooked_weight_g)
    .fetch_optional(&mut *tx)
    .await?
    .is_some();
    if !updated {
        return Err(AppError::NotFound("Recipe not found.".to_string()));
    }
    sqlx::query("DELETE FROM recipe_ingredients WHERE recipe_id = $1")
        .bind(recipe_id)
        .execute(&mut *tx)
        .await?;
    insert_recipe_ingredients(&mut tx, recipe_id, recipe.ingredients, test_fault).await?;
    tx.commit().await?;
    recipe_by_id_json(pool, user_id, recipe_id).await
}

struct RecipeInput<'a> {
    label: String,
    portions: i32,
    total_cooked_weight_g: Option<f64>,
    ingredients: &'a [Value],
}

fn parse_recipe_input(input: &serde_json::Map<String, Value>) -> AppResult<RecipeInput<'_>> {
    let label = required_string_with_message(input, "label", "Recipe name is required.")?;
    let portions = optional_i32(input, "portions").unwrap_or(1);
    if !(1..=999).contains(&portions) {
        let message = if portions < 1 {
            "Portions must be at least 1."
        } else {
            "Portions must be less than 1000."
        };
        return Err(AppError::BadRequest(message.to_string()));
    }
    let total_cooked_weight_g =
        optional_positive_number(input, "totalCookedWeightG", "Cooked weight")?;
    let ingredients = input
        .get("ingredients")
        .and_then(Value::as_array)
        .filter(|ingredients| !ingredients.is_empty())
        .ok_or_else(|| {
            AppError::BadRequest("A recipe must have at least one ingredient.".to_string())
        })?;

    Ok(RecipeInput {
        label,
        portions,
        total_cooked_weight_g,
        ingredients,
    })
}

async fn insert_recipe_ingredients(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    recipe_id: Uuid,
    ingredients: &[Value],
    test_fault: Option<&serde_json::Map<String, Value>>,
) -> AppResult<()> {
    if ingredients.is_empty() {
        return Ok(());
    }

    let mut rows = TemplateItemColumns::with_capacity(ingredients.len());
    for (index, ingredient) in ingredients.iter().enumerate() {
        // Kept per item so injected faults still abort at the same ingredient;
        // the surrounding transaction rolls back either way.
        maybe_trigger_test_fault(test_fault, index + 1)?;
        let ingredient = ingredient.as_object().ok_or_else(|| {
            AppError::BadRequest("Recipe ingredient must be an object.".to_string())
        })?;
        let values = normalize_meal_food_values(
            ingredient,
            index as i32,
            &format!("Ingredient {} name is required.", index + 1),
        )?;
        rows.push(index as i32, None, values);
    }

    sqlx::query(
        r#"
        INSERT INTO recipe_ingredients (
          id, recipe_id, product_id, sort_order, label, quantity, unit,
          serving_multiplier, protein_g, carbs_g, fat_g, calories_kcal
        )
        SELECT
          id, $1, product_id, sort_order, label, quantity, unit,
          serving_multiplier, protein_g, carbs_g, fat_g, calories_kcal
        FROM unnest(
          $2::uuid[], $3::uuid[], $4::int[], $5::text[], $6::float8[],
          $7::text[], $8::float8[], $9::float8[], $10::float8[], $11::float8[],
          $12::int[]
        ) AS ingredients(
          id, product_id, sort_order, label, quantity, unit,
          serving_multiplier, protein_g, carbs_g, fat_g, calories_kcal
        )
        "#,
    )
    .bind(recipe_id)
    .bind(&rows.ids)
    .bind(&rows.product_ids)
    .bind(&rows.sort_orders)
    .bind(&rows.labels)
    .bind(&rows.quantities)
    .bind(&rows.units)
    .bind(&rows.serving_multipliers)
    .bind(&rows.proteins)
    .bind(&rows.carbs)
    .bind(&rows.fats)
    .bind(&rows.calories)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

async fn recipe_by_id_json(pool: &PgPool, user_id: Uuid, recipe_id: Uuid) -> AppResult<Value> {
    first_json_item(recipes_json_filtered(pool, user_id, Some(recipe_id)).await?)
        .ok_or_else(|| AppError::NotFound("Recipe not found.".to_string()))
}

async fn weight_entries_json(pool: &PgPool, user_id: Uuid) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
            'id', id,
            'userId', user_id,
            'date', entry_date,
            'weightKg', weight_kg::float8,
            'bodyFatPct', body_fat_pct::float8,
            'notes', notes
          )
          ORDER BY entry_date ASC
        ), '[]'::jsonb) AS data
        FROM weight_entries
        WHERE user_id = $1
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

#[derive(Clone, Copy)]
struct WeightStatEntry {
    date: NaiveDate,
    weight_kg: f64,
}

fn weight_stat_entry(entry: &Value) -> AppResult<WeightStatEntry> {
    let date = entry
        .get("date")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest("weight entry date is required.".to_string()))
        .and_then(|value| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map_err(|_| AppError::BadRequest("weight entry date is invalid.".to_string()))
        })?;
    let weight_kg = entry
        .get("weightKg")
        .and_then(Value::as_f64)
        .ok_or_else(|| AppError::BadRequest("weight entry weightKg is required.".to_string()))?;
    Ok(WeightStatEntry { date, weight_kg })
}

fn closest_weight_on_or_before(
    entries: &[WeightStatEntry],
    target_date: NaiveDate,
) -> Option<WeightStatEntry> {
    entries
        .iter()
        .copied()
        .filter(|entry| entry.date <= target_date)
        .min_by_key(|entry| {
            entry
                .date
                .signed_duration_since(target_date)
                .num_days()
                .abs()
        })
}

fn trend_direction_from_diff(diff: f64) -> &'static str {
    if diff > 0.1 {
        "up"
    } else if diff < -0.1 {
        "down"
    } else {
        "stable"
    }
}

async fn weight_page_data_json(pool: &PgPool, user_id: Uuid, today: &str) -> AppResult<Value> {
    let entries = weight_entries_json(pool, user_id).await?;
    let row =
        sqlx::query("SELECT goal_weight_kg::float8 AS goal_weight_kg FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_one(pool)
            .await?;
    let goal_weight_kg: Option<f64> = row.try_get("goal_weight_kg")?;
    let entry_array = entries.as_array().cloned().unwrap_or_default();
    let stat_entries = entry_array
        .iter()
        .map(weight_stat_entry)
        .collect::<AppResult<Vec<_>>>()?;
    let today_date = NaiveDate::parse_from_str(today, "%Y-%m-%d")
        .map_err(|_| AppError::BadRequest("selectedDate must be YYYY-MM-DD.".to_string()))?;
    let latest = stat_entries.last().copied();
    let current_weight = latest.map(|entry| entry.weight_kg);
    let week_change = latest.and_then(|latest| {
        closest_weight_on_or_before(&stat_entries, today_date - Duration::days(7))
            .map(|entry| round2(latest.weight_kg - entry.weight_kg))
    });
    let month_change = latest.and_then(|latest| {
        closest_weight_on_or_before(&stat_entries, today_date - Duration::days(30))
            .map(|entry| round2(latest.weight_kg - entry.weight_kg))
    });
    let trend_direction = match stat_entries.len() {
        0 | 1 => None,
        2 => {
            let diff = stat_entries[1].weight_kg - stat_entries[0].weight_kg;
            Some(trend_direction_from_diff(diff))
        }
        len => {
            let last3 = &stat_entries[len - 3..];
            let first_diff = last3[1].weight_kg - last3[0].weight_kg;
            let second_diff = last3[2].weight_kg - last3[1].weight_kg;
            Some(trend_direction_from_diff((first_diff + second_diff) / 2.0))
        }
    };
    Ok(json!({
        "entries": entries,
        "goalWeightKg": goal_weight_kg,
        "stats": {
            "currentWeight": current_weight,
            "weekChange": week_change,
            "monthChange": month_change,
            "trendDirection": trend_direction
        }
    }))
}

async fn create_weight_entry_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
    overwrite: bool,
) -> AppResult<Value> {
    let id = Uuid::new_v4();
    let values = normalize_weight_entry_input(input)?;
    let row = if overwrite {
        sqlx::query(
            r#"
            INSERT INTO weight_entries (id, user_id, entry_date, weight_kg, body_fat_pct, notes, updated_at)
            VALUES ($1, $2, $3::date, $4, $5, $6, now())
            ON CONFLICT (user_id, entry_date)
            DO UPDATE SET weight_kg = EXCLUDED.weight_kg, body_fat_pct = EXCLUDED.body_fat_pct, notes = EXCLUDED.notes, updated_at = now()
            RETURNING id
            "#,
        )
        .bind(id)
        .bind(user_id)
        .bind(&values.date)
        .bind(values.weight_kg)
        .bind(values.body_fat_pct)
        .bind(values.notes.as_deref())
        .fetch_optional(pool)
        .await?
    } else {
        sqlx::query(
            r#"
            INSERT INTO weight_entries (id, user_id, entry_date, weight_kg, body_fat_pct, notes, updated_at)
            VALUES ($1, $2, $3::date, $4, $5, $6, now())
            ON CONFLICT (user_id, entry_date) DO NOTHING
            RETURNING id
            "#,
        )
        .bind(id)
        .bind(user_id)
        .bind(&values.date)
        .bind(values.weight_kg)
        .bind(values.body_fat_pct)
        .bind(values.notes.as_deref())
        .fetch_optional(pool)
        .await?
    };
    let Some(row) = row else {
        return Ok(Value::Null);
    };
    weight_entry_by_id_json(pool, user_id, row.try_get("id")?).await
}

async fn update_weight_entry_json(
    pool: &PgPool,
    user_id: Uuid,
    entry_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let values = normalize_weight_entry_input(input)?;
    let updated = sqlx::query(
        r#"
        UPDATE weight_entries
        SET entry_date = $3::date, weight_kg = $4, body_fat_pct = $5, notes = $6, updated_at = now()
        WHERE user_id = $1 AND id = $2
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(entry_id)
    .bind(values.date)
    .bind(values.weight_kg)
    .bind(values.body_fat_pct)
    .bind(values.notes.as_deref())
    .fetch_optional(pool)
    .await?
    .is_some();
    if !updated {
        return Err(AppError::NotFound("Weight entry not found.".to_string()));
    }
    weight_entry_by_id_json(pool, user_id, entry_id).await
}

async fn weight_entry_by_id_json(pool: &PgPool, user_id: Uuid, entry_id: Uuid) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        SELECT jsonb_build_object(
          'id', id,
          'userId', user_id,
          'date', entry_date,
          'weightKg', weight_kg::float8,
          'bodyFatPct', body_fat_pct::float8,
          'notes', notes
        ) AS data
        FROM weight_entries
        WHERE user_id = $1 AND id = $2
        "#,
    )
    .bind(user_id)
    .bind(entry_id)
    .fetch_optional(pool)
    .await?;
    Ok(row
        .ok_or_else(|| AppError::NotFound("Weight entry not found.".to_string()))?
        .try_get("data")?)
}

async fn recent_quick_add_json(pool: &PgPool, user_id: Uuid, limit: i32) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        WITH history AS (
          SELECT
            label,
            round(protein_g::numeric, 1)::float8 AS protein_g,
            round(carbs_g::numeric, 1)::float8 AS carbs_g,
            round(fat_g::numeric, 1)::float8 AS fat_g,
            calories_kcal,
            entry_date,
            created_at,
            lower(trim(label))
              || '|' || round(protein_g::numeric, 1)::text
              || '|' || round(carbs_g::numeric, 1)::text
              || '|' || round(fat_g::numeric, 1)::text
              || '|' || calories_kcal::text AS food_key
          FROM meal_entries
          WHERE user_id = $1 AND status = 'eaten'
          ORDER BY entry_date DESC, created_at DESC
          LIMIT 400
        ),
        latest AS (
          SELECT DISTINCT ON (food_key)
            food_key,
            label,
            protein_g,
            carbs_g,
            fat_g,
            calories_kcal,
            entry_date AS source_date,
            created_at
          FROM history
          ORDER BY food_key, entry_date DESC, created_at DESC
        ),
        use_days AS (
          SELECT food_key, count(DISTINCT entry_date)::int AS observed_use_days
          FROM history
          GROUP BY food_key
        ),
        habit_buckets AS (
          SELECT
            food_key,
            -- Pinned to UTC: the client compares this against a UTC hour, and
            -- `extract(hour from timestamptz)` would otherwise resolve in
            -- whatever the session TimeZone GUC happens to be.
            floor(extract(hour from created_at AT TIME ZONE 'UTC') / 3)::int AS bucket,
            count(*)::int AS habit_count
          FROM history
          GROUP BY food_key, bucket
        ),
        habits AS (
          SELECT DISTINCT ON (food_key)
            food_key,
            CASE WHEN habit_count >= 3 THEN bucket * 3 + 1 ELSE NULL END AS peak_hour_utc,
            CASE WHEN habit_count >= 3 THEN habit_count ELSE NULL END AS habit_count
          FROM habit_buckets
          ORDER BY food_key, habit_count DESC, bucket
        ),
        candidates AS (
          SELECT
            latest.*,
            use_days.observed_use_days,
            habits.peak_hour_utc,
            habits.habit_count
          FROM latest
          JOIN use_days ON use_days.food_key = latest.food_key
          LEFT JOIN habits ON habits.food_key = latest.food_key
          ORDER BY latest.source_date DESC, latest.created_at DESC
          LIMIT $2
        )
        SELECT coalesce(jsonb_agg(
          jsonb_strip_nulls(jsonb_build_object(
            'label', label,
            'proteinG', protein_g,
            'carbsG', carbs_g,
            'fatG', fat_g,
            'caloriesKcal', calories_kcal,
            'source', 'recent',
            'sourceDate', source_date,
            'observedUseDays', observed_use_days,
            'peakHourUtc', peak_hour_utc,
            'habitCount', habit_count
          ))
          ORDER BY source_date DESC, created_at DESC
        ), '[]'::jsonb) AS data
        FROM candidates
        "#,
    )
    .bind(user_id)
    .bind(limit)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn template_quick_add_json(pool: &PgPool, user_id: Uuid, limit: i32) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        WITH single_item_templates AS (
          SELECT
            mt.id,
            mt.updated_at,
            item.label,
            item.protein_g,
            item.carbs_g,
            item.fat_g,
            item.calories_kcal
          FROM meal_templates mt
          JOIN LATERAL (
            SELECT
              count(*) OVER () AS item_count,
              label,
              protein_g,
              carbs_g,
              fat_g,
              calories_kcal
            FROM meal_template_items
            WHERE template_id = mt.id
          ) item ON item.item_count = 1
          WHERE mt.user_id = $1
            AND mt.type = 'meal'
            AND mt.deleted_at IS NULL
          ORDER BY mt.updated_at DESC, mt.id
          LIMIT $2
        )
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
            'label', label,
            'proteinG', protein_g::float8,
            'carbsG', carbs_g::float8,
            'fatG', fat_g::float8,
            'caloriesKcal', calories_kcal,
            'source', 'preset',
            'presetId', id
          )
          ORDER BY updated_at DESC, id
        ), '[]'::jsonb) AS data
        FROM single_item_templates
        "#,
    )
    .bind(user_id)
    .bind(limit)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn dashboard_quick_add_json(
    pool: &PgPool,
    user_id: Uuid,
    limit_per_source: i32,
) -> AppResult<Value> {
    let (recent, templates) = tokio::try_join!(
        recent_quick_add_json(pool, user_id, limit_per_source),
        template_quick_add_json(pool, user_id, limit_per_source),
    )?;
    let mut candidates = match templates {
        Value::Array(values) => values,
        _ => Vec::new(),
    };
    if let Value::Array(values) = recent {
        candidates.extend(values);
    }
    Ok(Value::Array(candidates))
}

async fn search_meal_entries_json(pool: &PgPool, user_id: Uuid, query: &str) -> AppResult<Value> {
    validate_search_query(query)?;
    let patterns = search_like_patterns(query);
    if patterns.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }
    let row = sqlx::query(
        r#"
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
            'id', matches.id,
            'userId', matches.user_id,
            'date', matches.entry_date,
            'mealGroupId', matches.meal_group_id,
            'status', matches.status,
            'productId', CASE WHEN fp.id IS NULL THEN NULL ELSE matches.product_id END,
            'label', matches.label,
            'sortOrder', matches.sort_order,
            'quantity', matches.quantity::float8,
            'unit', matches.unit,
            'servingMultiplier', matches.serving_multiplier::float8,
            'proteinG', matches.protein_g::float8,
            'carbsG', matches.carbs_g::float8,
            'fatG', matches.fat_g::float8,
            'caloriesKcal', matches.calories_kcal,
            'clientMutationId', matches.client_mutation_id,
            'sourceLabel', fp.name
          )
          ORDER BY matches.entry_date DESC, matches.sort_order ASC
        ), '[]'::jsonb) AS data
        FROM (
          SELECT *
          FROM (
            SELECT
              meal_entries.*,
              row_number() OVER (
                PARTITION BY lower(label), protein_g, carbs_g, fat_g, calories_kcal
                ORDER BY entry_date DESC, sort_order ASC, created_at DESC, id
              ) AS duplicate_rank
            FROM meal_entries
            WHERE
              user_id = $1
              AND status = 'eaten'
              AND NOT EXISTS (
                SELECT 1
                FROM unnest($2::text[]) AS patterns(pattern)
                WHERE label NOT ILIKE pattern ESCAPE '\'
              )
          ) ranked
          WHERE duplicate_rank = 1
          ORDER BY entry_date DESC, sort_order ASC
          LIMIT 50
        ) matches
        LEFT JOIN food_products fp
          ON fp.id = matches.product_id
          AND fp.deleted_at IS NULL
          AND (fp.owner_user_id = $1 OR fp.owner_user_id IS NULL)
        "#,
    )
    .bind(user_id)
    .bind(patterns)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn list_recent_meal_entries_json(
    pool: &PgPool,
    user_id: Uuid,
    limit: i32,
    eaten_only: bool,
) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
            'id', id,
            'userId', user_id,
            'date', entry_date,
            'mealGroupId', meal_group_id,
            'status', status,
            'productId', product_id,
            'label', label,
            'sortOrder', sort_order,
            'quantity', quantity::float8,
            'unit', unit,
            'servingMultiplier', serving_multiplier::float8,
            'proteinG', protein_g::float8,
            'carbsG', carbs_g::float8,
            'fatG', fat_g::float8,
            'caloriesKcal', calories_kcal,
            'clientMutationId', client_mutation_id,
            'sourceLabel', NULL
          )
          ORDER BY entry_date DESC, sort_order ASC, created_at DESC, id
        ), '[]'::jsonb) AS data
        FROM (
          SELECT *
          FROM meal_entries
          WHERE user_id = $1 AND (NOT $3::bool OR status = 'eaten')
          ORDER BY entry_date DESC, sort_order ASC, created_at DESC, id
          LIMIT $2
        ) recent
        "#,
    )
    .bind(user_id)
    .bind(limit)
    .bind(eaten_only)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn recent_daily_overviews_json(
    pool: &PgPool,
    user_id: Uuid,
    selected_date: &str,
    days: i32,
) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
            'date', entry_date,
            'totals', jsonb_build_object(
              'proteinG', protein_g,
              'carbsG', carbs_g,
              'fatG', fat_g,
              'caloriesKcal', calories_kcal
            ),
            'itemCount', item_count
          )
          ORDER BY entry_date DESC
        ), '[]'::jsonb) AS data
        FROM (
          SELECT
            entry_date,
            round(sum(protein_g)::numeric, 1)::float8 AS protein_g,
            round(sum(carbs_g)::numeric, 1)::float8 AS carbs_g,
            round(sum(fat_g)::numeric, 1)::float8 AS fat_g,
            sum(calories_kcal)::int AS calories_kcal,
            count(*)::int AS item_count
          FROM meal_entries
          WHERE user_id = $1 AND status = 'eaten' AND entry_date <= $2::date
          GROUP BY entry_date
          ORDER BY entry_date DESC
          LIMIT $3
        ) daily
        "#,
    )
    .bind(user_id)
    .bind(selected_date)
    .bind(days)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn period_averages_json(
    pool: &PgPool,
    user_id: Uuid,
    selected_date: &str,
) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        WITH bounds AS (
          SELECT
            $2::date AS selected,
            date_trunc('week', $2::date)::date AS week_start,
            (date_trunc('week', $2::date)::date + interval '6 days')::date AS week_end,
            date_trunc('month', $2::date)::date AS month_start,
            (date_trunc('month', $2::date)::date + interval '1 month - 1 day')::date AS month_end,
            ($2::date - interval '6 days')::date AS rolling7_start,
            ($2::date - interval '29 days')::date AS rolling30_start
        ),
        ranges(label, start_date, end_date) AS (
          SELECT 'week', week_start, week_end FROM bounds
          UNION ALL SELECT 'month', month_start, month_end FROM bounds
          UNION ALL SELECT 'rolling7', rolling7_start, selected FROM bounds
          UNION ALL SELECT 'rolling30', rolling30_start, selected FROM bounds
        ),
        totals AS (
          SELECT
            ranges.label,
            ranges.start_date,
            ranges.end_date,
            count(DISTINCT me.entry_date)::int AS logged_days,
            coalesce(sum(me.protein_g), 0)::float8 AS protein_g,
            coalesce(sum(me.carbs_g), 0)::float8 AS carbs_g,
            coalesce(sum(me.fat_g), 0)::float8 AS fat_g,
            coalesce(sum(me.calories_kcal), 0)::float8 AS calories_kcal
          FROM ranges
          LEFT JOIN meal_entries me
            ON me.user_id = $1
            AND me.status = 'eaten'
            AND me.entry_date >= ranges.start_date
            AND me.entry_date <= ranges.end_date
          GROUP BY ranges.label, ranges.start_date, ranges.end_date
        )
        SELECT jsonb_agg(
          jsonb_build_object(
            'label', label,
            'startDate', start_date,
            'endDate', end_date,
            'loggedDays', logged_days,
            'averages', jsonb_build_object(
              'proteinG', CASE WHEN logged_days = 0 THEN 0 ELSE round((protein_g / logged_days)::numeric, 1)::float8 END,
              'carbsG', CASE WHEN logged_days = 0 THEN 0 ELSE round((carbs_g / logged_days)::numeric, 1)::float8 END,
              'fatG', CASE WHEN logged_days = 0 THEN 0 ELSE round((fat_g / logged_days)::numeric, 1)::float8 END,
              'caloriesKcal', CASE WHEN logged_days = 0 THEN 0 ELSE round(calories_kcal / logged_days)::int END
            )
          )
          ORDER BY CASE label WHEN 'week' THEN 1 WHEN 'month' THEN 2 WHEN 'rolling7' THEN 3 ELSE 4 END
        ) AS data
        FROM totals
        "#,
    )
    .bind(user_id)
    .bind(selected_date)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn stats_page_data_json(pool: &PgPool, user_id: Uuid, today: &str) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        WITH user_goals AS (
          SELECT
            goal_calories_kcal,
            goal_protein_g,
            goal_carbs_g,
            goal_fat_g
          FROM users
          WHERE id = $1
        ),
        -- One pass over the user's entries; `FILTER` splits eaten from planned
        -- so the eaten/planned aggregates no longer scan the table twice and
        -- then re-`UNION` their dates back together.
        daily AS (
          SELECT
            entry_date,
            coalesce(sum(protein_g) FILTER (WHERE status = 'eaten'), 0)::float8 AS protein_g,
            coalesce(sum(carbs_g) FILTER (WHERE status = 'eaten'), 0)::float8 AS carbs_g,
            coalesce(sum(fat_g) FILTER (WHERE status = 'eaten'), 0)::float8 AS fat_g,
            coalesce(sum(calories_kcal) FILTER (WHERE status = 'eaten'), 0)::int AS calories_kcal,
            coalesce(sum(protein_g) FILTER (WHERE status = 'planned' AND entry_date <= $2::date), 0)::float8 AS planned_protein_g,
            coalesce(sum(carbs_g) FILTER (WHERE status = 'planned' AND entry_date <= $2::date), 0)::float8 AS planned_carbs_g,
            coalesce(sum(fat_g) FILTER (WHERE status = 'planned' AND entry_date <= $2::date), 0)::float8 AS planned_fat_g,
            coalesce(sum(calories_kcal) FILTER (WHERE status = 'planned' AND entry_date <= $2::date), 0)::int AS planned_calories_kcal
          FROM meal_entries
          WHERE user_id = $1
            AND (
              status = 'eaten'
              OR (status = 'planned' AND entry_date <= $2::date)
            )
          GROUP BY entry_date
        ),
        eaten_days AS (
          SELECT *
          FROM daily
          WHERE calories_kcal > 0
        ),
        totals AS (
          SELECT
            count(*)::int AS total_days_tracked,
            coalesce(sum(protein_g), 0)::float8 AS total_protein_g,
            coalesce(sum(carbs_g), 0)::float8 AS total_carbs_g,
            coalesce(sum(fat_g), 0)::float8 AS total_fat_g,
            coalesce(sum(calories_kcal), 0)::int AS total_calories_kcal
          FROM eaten_days
        ),
        rolling_7 AS (
          SELECT
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(protein_g) / count(*))::numeric, 1)::float8 END AS protein_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(carbs_g) / count(*))::numeric, 1)::float8 END AS carbs_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(fat_g) / count(*))::numeric, 1)::float8 END AS fat_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round(sum(calories_kcal)::numeric / count(*))::int END AS calories_kcal
          FROM eaten_days
          WHERE entry_date >= $2::date - interval '6 days' AND entry_date <= $2::date
        ),
        rolling_30 AS (
          SELECT
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(protein_g) / count(*))::numeric, 1)::float8 END AS protein_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(carbs_g) / count(*))::numeric, 1)::float8 END AS carbs_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(fat_g) / count(*))::numeric, 1)::float8 END AS fat_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round(sum(calories_kcal)::numeric / count(*))::int END AS calories_kcal
          FROM eaten_days
          WHERE entry_date >= $2::date - interval '29 days' AND entry_date <= $2::date
        ),
        goal_hits AS (
          SELECT
            count(*) FILTER (WHERE entry_date >= $2::date - interval '6 days' AND entry_date <= $2::date)::int AS days7_count,
            count(*) FILTER (WHERE entry_date >= $2::date - interval '29 days' AND entry_date <= $2::date)::int AS days30_count,
            count(*) FILTER (WHERE entry_date >= $2::date - interval '89 days' AND entry_date <= $2::date)::int AS days90_count,
            count(*) FILTER (WHERE entry_date >= $2::date - interval '6 days' AND entry_date <= $2::date AND user_goals.goal_calories_kcal IS NOT NULL AND calories_kcal <= user_goals.goal_calories_kcal)::int AS days7_calories,
            count(*) FILTER (WHERE entry_date >= $2::date - interval '29 days' AND entry_date <= $2::date AND user_goals.goal_calories_kcal IS NOT NULL AND calories_kcal <= user_goals.goal_calories_kcal)::int AS days30_calories,
            count(*) FILTER (WHERE entry_date >= $2::date - interval '89 days' AND entry_date <= $2::date AND user_goals.goal_calories_kcal IS NOT NULL AND calories_kcal <= user_goals.goal_calories_kcal)::int AS days90_calories,
            count(*) FILTER (WHERE entry_date >= $2::date - interval '6 days' AND entry_date <= $2::date AND user_goals.goal_protein_g IS NOT NULL AND protein_g >= user_goals.goal_protein_g)::int AS days7_protein,
            count(*) FILTER (WHERE entry_date >= $2::date - interval '29 days' AND entry_date <= $2::date AND user_goals.goal_protein_g IS NOT NULL AND protein_g >= user_goals.goal_protein_g)::int AS days30_protein,
            count(*) FILTER (WHERE entry_date >= $2::date - interval '89 days' AND entry_date <= $2::date AND user_goals.goal_protein_g IS NOT NULL AND protein_g >= user_goals.goal_protein_g)::int AS days90_protein,
            count(*) FILTER (WHERE entry_date >= $2::date - interval '6 days' AND entry_date <= $2::date AND user_goals.goal_carbs_g IS NOT NULL AND carbs_g <= user_goals.goal_carbs_g)::int AS days7_carbs,
            count(*) FILTER (WHERE entry_date >= $2::date - interval '29 days' AND entry_date <= $2::date AND user_goals.goal_carbs_g IS NOT NULL AND carbs_g <= user_goals.goal_carbs_g)::int AS days30_carbs,
            count(*) FILTER (WHERE entry_date >= $2::date - interval '89 days' AND entry_date <= $2::date AND user_goals.goal_carbs_g IS NOT NULL AND carbs_g <= user_goals.goal_carbs_g)::int AS days90_carbs,
            count(*) FILTER (WHERE entry_date >= $2::date - interval '6 days' AND entry_date <= $2::date AND user_goals.goal_fat_g IS NOT NULL AND fat_g <= user_goals.goal_fat_g)::int AS days7_fat,
            count(*) FILTER (WHERE entry_date >= $2::date - interval '29 days' AND entry_date <= $2::date AND user_goals.goal_fat_g IS NOT NULL AND fat_g <= user_goals.goal_fat_g)::int AS days30_fat,
            count(*) FILTER (WHERE entry_date >= $2::date - interval '89 days' AND entry_date <= $2::date AND user_goals.goal_fat_g IS NOT NULL AND fat_g <= user_goals.goal_fat_g)::int AS days90_fat
          FROM eaten_days, user_goals
        ),
        best_calorie_day AS (
          SELECT jsonb_build_object('date', entry_date, 'caloriesKcal', calories_kcal) AS value
          FROM eaten_days
          ORDER BY calories_kcal DESC, entry_date ASC
          LIMIT 1
        ),
        top_labels AS (
          SELECT coalesce(jsonb_agg(jsonb_build_object('label', label, 'count', count) ORDER BY count DESC, label), '[]'::jsonb) AS value
          FROM (
            SELECT label, count(*)::int AS count
            FROM meal_entries
            WHERE user_id = $1 AND status = 'eaten'
            GROUP BY label
            ORDER BY count(*) DESC, label
            LIMIT 5
          ) labels
        ),
        macro_consistency AS (
          SELECT
            CASE
              WHEN user_goals.goal_calories_kcal IS NULL OR count(eaten_days.*) = 0 THEN NULL
              ELSE round(avg(abs(eaten_days.calories_kcal - user_goals.goal_calories_kcal)))::int
            END AS calorie_avg_absolute_deviation,
            CASE
              WHEN user_goals.goal_calories_kcal IS NULL OR user_goals.goal_calories_kcal <= 0 OR count(eaten_days.*) = 0 THEN NULL
              ELSE greatest(0, round(100 - (avg(abs(eaten_days.calories_kcal - user_goals.goal_calories_kcal)) / user_goals.goal_calories_kcal) * 100))::int
            END AS score
          FROM user_goals
          LEFT JOIN eaten_days ON true
          GROUP BY user_goals.goal_calories_kcal
        ),
        energy_balance AS (
          SELECT
            CASE
              WHEN user_goals.goal_calories_kcal IS NULL OR totals.total_days_tracked = 0 THEN NULL
              ELSE round((totals.total_calories_kcal::float8 / totals.total_days_tracked) - user_goals.goal_calories_kcal)::int
            END AS average_daily_delta_kcal
          FROM totals, user_goals
        ),
        latest_weight AS (
          SELECT weight_kg::float8 AS weight_kg
          FROM weight_entries
          WHERE user_id = $1
          ORDER BY entry_date DESC
          LIMIT 1
        ),
        smoothed_weight_trend AS (
          SELECT coalesce(jsonb_agg(
            jsonb_build_object(
              'date', entry_date,
              'weightKg', weight_kg,
              'smoothedWeightKg', smoothed_weight_kg
            ) ORDER BY entry_date
          ), '[]'::jsonb) AS value
          FROM (
            SELECT
              entry_date,
              round(weight_kg::numeric, 2)::float8 AS weight_kg,
              round(avg(weight_kg) OVER (ORDER BY entry_date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)::numeric, 2)::float8 AS smoothed_weight_kg
            FROM weight_entries
            WHERE user_id = $1
          ) weights
        ),
        planned_adherence AS (
          SELECT
            count(*) FILTER (WHERE status = 'planned')::int AS planned_count,
            count(*) FILTER (WHERE status = 'eaten')::int AS eaten_count,
            count(*) FILTER (WHERE status = 'skipped')::int AS skipped_count,
            count(*) FILTER (WHERE status IN ('planned', 'eaten', 'skipped'))::int AS base_count
          FROM meal_entries
          WHERE user_id = $1
        ),
        daily_totals AS (
          SELECT coalesce(jsonb_agg(
            jsonb_build_object(
              'date', entry_date,
              'proteinG', protein_g,
              'carbsG', carbs_g,
              'fatG', fat_g,
              'caloriesKcal', calories_kcal,
              'plannedTotals', jsonb_build_object(
                'proteinG', planned_protein_g,
                'carbsG', planned_carbs_g,
                'fatG', planned_fat_g,
                'caloriesKcal', planned_calories_kcal
              )
            )
            ORDER BY entry_date
          ), '[]'::jsonb) AS all_daily_totals
          FROM daily
        )
        SELECT jsonb_build_object(
          'allDailyTotals', daily_totals.all_daily_totals,
          'totalDaysTracked', totals.total_days_tracked,
          'currentStreak', 0,
          'longestStreak', 0,
          'totalProteinG', totals.total_protein_g,
          'totalCarbsG', totals.total_carbs_g,
          'totalFatG', totals.total_fat_g,
          'totalCaloriesKcal', totals.total_calories_kcal,
          'bestCalorieDay', coalesce(best_calorie_day.value, 'null'::jsonb),
          'topLabels', top_labels.value,
          'goalHitRates', jsonb_build_object(
            'days7', jsonb_build_object(
              'caloriesKcal', CASE WHEN goal_hits.days7_count = 0 OR user_goals.goal_calories_kcal IS NULL THEN NULL ELSE round(goal_hits.days7_calories * 100.0 / goal_hits.days7_count)::int END,
              'proteinG', CASE WHEN goal_hits.days7_count = 0 OR user_goals.goal_protein_g IS NULL THEN NULL ELSE round(goal_hits.days7_protein * 100.0 / goal_hits.days7_count)::int END,
              'carbsG', CASE WHEN goal_hits.days7_count = 0 OR user_goals.goal_carbs_g IS NULL THEN NULL ELSE round(goal_hits.days7_carbs * 100.0 / goal_hits.days7_count)::int END,
              'fatG', CASE WHEN goal_hits.days7_count = 0 OR user_goals.goal_fat_g IS NULL THEN NULL ELSE round(goal_hits.days7_fat * 100.0 / goal_hits.days7_count)::int END
            ),
            'days30', jsonb_build_object(
              'caloriesKcal', CASE WHEN goal_hits.days30_count = 0 OR user_goals.goal_calories_kcal IS NULL THEN NULL ELSE round(goal_hits.days30_calories * 100.0 / goal_hits.days30_count)::int END,
              'proteinG', CASE WHEN goal_hits.days30_count = 0 OR user_goals.goal_protein_g IS NULL THEN NULL ELSE round(goal_hits.days30_protein * 100.0 / goal_hits.days30_count)::int END,
              'carbsG', CASE WHEN goal_hits.days30_count = 0 OR user_goals.goal_carbs_g IS NULL THEN NULL ELSE round(goal_hits.days30_carbs * 100.0 / goal_hits.days30_count)::int END,
              'fatG', CASE WHEN goal_hits.days30_count = 0 OR user_goals.goal_fat_g IS NULL THEN NULL ELSE round(goal_hits.days30_fat * 100.0 / goal_hits.days30_count)::int END
            ),
            'days90', jsonb_build_object(
              'caloriesKcal', CASE WHEN goal_hits.days90_count = 0 OR user_goals.goal_calories_kcal IS NULL THEN NULL ELSE round(goal_hits.days90_calories * 100.0 / goal_hits.days90_count)::int END,
              'proteinG', CASE WHEN goal_hits.days90_count = 0 OR user_goals.goal_protein_g IS NULL THEN NULL ELSE round(goal_hits.days90_protein * 100.0 / goal_hits.days90_count)::int END,
              'carbsG', CASE WHEN goal_hits.days90_count = 0 OR user_goals.goal_carbs_g IS NULL THEN NULL ELSE round(goal_hits.days90_carbs * 100.0 / goal_hits.days90_count)::int END,
              'fatG', CASE WHEN goal_hits.days90_count = 0 OR user_goals.goal_fat_g IS NULL THEN NULL ELSE round(goal_hits.days90_fat * 100.0 / goal_hits.days90_count)::int END
            )
          ),
          'macroConsistency', jsonb_build_object('calorieAvgAbsoluteDeviation', macro_consistency.calorie_avg_absolute_deviation, 'score', macro_consistency.score),
          'rollingAverages', jsonb_build_object(
            'days7', jsonb_build_object('proteinG', rolling_7.protein_g, 'carbsG', rolling_7.carbs_g, 'fatG', rolling_7.fat_g, 'caloriesKcal', rolling_7.calories_kcal),
            'days30', jsonb_build_object('proteinG', rolling_30.protein_g, 'carbsG', rolling_30.carbs_g, 'fatG', rolling_30.fat_g, 'caloriesKcal', rolling_30.calories_kcal)
          ),
          'estimatedEnergyBalance', jsonb_build_object(
            'averageDailyDeltaKcal', energy_balance.average_daily_delta_kcal,
            'estimatedWeeklyWeightChangeKg', CASE WHEN energy_balance.average_daily_delta_kcal IS NULL THEN NULL ELSE round(((energy_balance.average_daily_delta_kcal * 7.0) / 7700.0)::numeric, 2)::float8 END
          ),
          'proteinPerKg', CASE WHEN latest_weight.weight_kg IS NULL OR latest_weight.weight_kg <= 0 OR totals.total_days_tracked = 0 THEN NULL ELSE round(((totals.total_protein_g / totals.total_days_tracked) / latest_weight.weight_kg)::numeric, 2)::float8 END,
          'smoothedWeightTrend', smoothed_weight_trend.value,
          'plannedAdherence', jsonb_build_object(
            'plannedCount', planned_adherence.planned_count,
            'eatenCount', planned_adherence.eaten_count,
            'skippedCount', planned_adherence.skipped_count,
            'adherencePct', CASE WHEN planned_adherence.base_count = 0 THEN NULL ELSE round(planned_adherence.eaten_count * 100.0 / planned_adherence.base_count)::int END
          )
        ) AS data
        FROM totals
        CROSS JOIN rolling_7
        CROSS JOIN rolling_30
        CROSS JOIN goal_hits
        CROSS JOIN user_goals
        CROSS JOIN daily_totals
        CROSS JOIN top_labels
        CROSS JOIN macro_consistency
        CROSS JOIN energy_balance
        CROSS JOIN smoothed_weight_trend
        CROSS JOIN planned_adherence
        LEFT JOIN best_calorie_day ON true
        LEFT JOIN latest_weight ON true
        "#,
    )
    .bind(user_id)
    .bind(today)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn leaderboard_json(pool: &PgPool, user_id: Uuid, reference_date: &str) -> AppResult<Value> {
    let today = NaiveDate::parse_from_str(reference_date, "%Y-%m-%d")
        .map_err(|_| AppError::BadRequest("referenceDate must be YYYY-MM-DD.".to_string()))?;
    let row = sqlx::query(
        r#"
        WITH daily AS (
          SELECT
            entry_date,
            round(sum(calories_kcal)::numeric)::int AS calories_kcal,
            round(sum(protein_g)::numeric, 1)::float8 AS protein_g,
            round(sum(carbs_g)::numeric, 1)::float8 AS carbs_g,
            count(*)::int AS entry_count
          FROM meal_entries
          WHERE user_id = $1 AND status = 'eaten'
          GROUP BY entry_date
        ),
        dated_islands AS (
          SELECT
            entry_date,
            entry_date - row_number() OVER (ORDER BY entry_date)::int AS island
          FROM daily
        ),
        streaks AS (
          SELECT
            min(entry_date) AS start_date,
            max(entry_date) AS end_date,
            count(*)::int AS streak_length
          FROM dated_islands
          GROUP BY island
        ),
        streak_summary AS (
          SELECT
            coalesce(max(CASE
              WHEN start_date <= $2 AND end_date >= $2 THEN ($2 - start_date) + 1
              WHEN end_date = $2 - 1 THEN streak_length
            END), 0)::int AS current_streak,
            coalesce(max(streak_length), 0)::int AS longest_streak
          FROM streaks
        )
        SELECT jsonb_build_object(
          'currentStreak', streak_summary.current_streak,
          'longestStreak', streak_summary.longest_streak,
          'totalDaysTracked', (SELECT count(*)::int FROM daily),
          'bestCalorieDay', (
            SELECT jsonb_build_object('date', entry_date, 'caloriesKcal', calories_kcal)
            FROM daily
            ORDER BY calories_kcal DESC, entry_date ASC
            LIMIT 1
          ),
          'bestProteinDay', (
            SELECT jsonb_build_object('date', entry_date, 'proteinG', protein_g)
            FROM daily
            ORDER BY protein_g DESC, entry_date ASC
            LIMIT 1
          ),
          'bestCarbsDay', (
            SELECT jsonb_build_object('date', entry_date, 'carbsG', carbs_g)
            FROM daily
            ORDER BY carbs_g DESC, entry_date ASC
            LIMIT 1
          ),
          'mostActiveDay', (
            SELECT jsonb_build_object('date', entry_date, 'entryCount', entry_count)
            FROM daily
            ORDER BY entry_count DESC, entry_date ASC
            LIMIT 1
          )
        ) AS data
        FROM streak_summary
        "#,
    )
    .bind(user_id)
    .bind(today)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

fn row_to_app_user(row: PgRow) -> AppResult<AppUser> {
    Ok(AppUser {
        id: row.try_get("id")?,
        email: row.try_get("email")?,
        shoo_pairwise_sub: row.try_get("shoo_pairwise_sub")?,
        display_name: row.try_get("display_name")?,
        picture_url: row.try_get("picture_url")?,
        role: row.try_get("role")?,
        created_at: row.try_get::<DateTime<Utc>, _>("created_at")?,
        last_login_at: row.try_get::<DateTime<Utc>, _>("last_login_at")?,
        goal_calories_kcal: row.try_get("goal_calories_kcal")?,
        goal_protein_g: row.try_get("goal_protein_g")?,
        goal_carbs_g: row.try_get("goal_carbs_g")?,
        goal_fat_g: row.try_get("goal_fat_g")?,
        goal_weight_kg: row.try_get("goal_weight_kg")?,
        onboarding_completed_at: row.try_get("onboarding_completed_at")?,
        preferred_weight_unit: row.try_get("preferred_weight_unit")?,
    })
}

fn uuid_arg(args: &Value, key: &str) -> AppResult<Uuid> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::BadRequest(format!("{key} is required.")))
        .and_then(|value| {
            Uuid::parse_str(value)
                .map_err(|_| AppError::BadRequest(format!("{key} must be a UUID.")))
        })
}

/// Rejects a malformed payload without echoing serde's message, which names
/// struct fields and byte offsets.
fn invalid_payload(field: &'static str) -> impl Fn(serde_json::Error) -> AppError {
    move |error| {
        tracing::debug!(error = ?error, field, "rejected malformed rpc payload");
        AppError::BadRequest(format!("{field} is invalid."))
    }
}

fn string_arg(args: &Value, key: &str) -> AppResult<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::BadRequest(format!("{key} is required.")))
}

/// Rejects anything that is not a literal `YYYY-MM-DD` calendar date.
///
/// Postgres accepts `infinity`, `today` and `epoch` as `date` input, so an
/// unvalidated string can be stored and then fail to re-parse on every
/// subsequent read — permanently breaking the page that reads it.
pub(crate) fn ensure_date_string(value: &str) -> AppResult<()> {
    let bytes = value.as_bytes();
    let well_formed = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
        && NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok();

    if well_formed {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "Date must use YYYY-MM-DD.".to_string(),
        ))
    }
}

fn date_arg(args: &Value, key: &str) -> AppResult<String> {
    let value = string_arg(args, key)?;
    ensure_date_string(&value)?;
    Ok(value)
}

fn object_arg<'a>(args: &'a Value, key: &str) -> AppResult<&'a serde_json::Map<String, Value>> {
    args.get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::BadRequest(format!("{key} is required.")))
}

fn optional_object_arg<'a>(args: &'a Value, key: &str) -> &'a serde_json::Map<String, Value> {
    static EMPTY: std::sync::OnceLock<serde_json::Map<String, Value>> = std::sync::OnceLock::new();
    args.get(key)
        .and_then(Value::as_object)
        .unwrap_or_else(|| EMPTY.get_or_init(serde_json::Map::new))
}

/// Forced-failure injection for rollback tests.
///
/// Gated on an explicit cargo feature rather than `debug_assertions`: a
/// debug-profile deploy would otherwise expose fault injection to anyone
/// holding the internal secret.
fn test_fault_arg<'a>(args: &'a Value, kind: &str) -> Option<&'a serde_json::Map<String, Value>> {
    if !cfg!(any(test, feature = "test-faults")) {
        return None;
    }
    let fault = args.get("testFault")?.as_object()?;
    if fault.get("kind").and_then(Value::as_str) == Some(kind) {
        Some(fault)
    } else {
        None
    }
}

fn maybe_trigger_test_fault(
    fault: Option<&serde_json::Map<String, Value>>,
    call_number: usize,
) -> AppResult<()> {
    let Some(fault) = fault else {
        return Ok(());
    };
    let fail_on_call = fault.get("failOnCall").and_then(Value::as_u64).unwrap_or(1) as usize;
    if fail_on_call == call_number {
        let message = fault
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Forced backend test failure.");
        return Err(AppError::BadRequest(message.to_string()));
    }
    Ok(())
}

fn pagination(input: &serde_json::Map<String, Value>) -> (i64, i64, i64) {
    let page = input
        .get("page")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .max(1);
    let page_size = input
        .get("pageSize")
        .and_then(Value::as_i64)
        .unwrap_or(25)
        .clamp(1, 100);
    let offset = (page - 1) * page_size;
    (page, page_size, offset)
}

fn page_json(items: Vec<Value>, page: i64, page_size: i64, total_items: i32) -> Value {
    let total_items = i64::from(total_items);
    json!({
        "items": items,
        "pagination": {
            "page": page,
            "pageSize": page_size,
            "totalItems": total_items,
            "totalPages": if total_items == 0 { 0 } else { (total_items + page_size - 1) / page_size }
        }
    })
}

fn is_quantity_unit(value: &str) -> bool {
    matches!(value, "g" | "ml" | "serving" | "count")
}

fn trim_optional_string(input: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn required_string_with_message(
    input: &serde_json::Map<String, Value>,
    key: &str,
    message: &str,
) -> AppResult<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::BadRequest(message.to_string()))
}

fn normalize_positive_number(
    input: &serde_json::Map<String, Value>,
    key: &str,
    field_name: &str,
    fallback: f64,
) -> AppResult<f64> {
    let value = optional_f64(input, key).unwrap_or(fallback);
    if !value.is_finite() || value <= 0.0 {
        return Err(AppError::BadRequest(format!(
            "{field_name} must be a positive number."
        )));
    }
    if value > MAX_QUANTITY {
        return Err(AppError::BadRequest(format!(
            "{field_name} must be at most {MAX_QUANTITY}."
        )));
    }
    Ok(round2(value))
}

fn optional_positive_number(
    input: &serde_json::Map<String, Value>,
    key: &str,
    field_name: &str,
) -> AppResult<Option<f64>> {
    if matches!(input.get(key), None | Some(Value::Null)) {
        return Ok(None);
    }
    Ok(Some(normalize_positive_number(
        input, key, field_name, 1.0,
    )?))
}

fn normalize_quantity_unit(input: &serde_json::Map<String, Value>, key: &str) -> AppResult<String> {
    let unit = input.get(key).and_then(Value::as_str).unwrap_or("serving");
    if !is_quantity_unit(unit) {
        return Err(AppError::BadRequest(
            "Quantity unit is invalid.".to_string(),
        ));
    }
    Ok(unit.to_string())
}

fn normalize_macros(
    input: &serde_json::Map<String, Value>,
    protein_key: &str,
    carbs_key: &str,
    fat_key: &str,
    calories_key: &str,
) -> AppResult<MacroValues> {
    Ok(MacroValues {
        protein: round1(required_f64_bounded(input, protein_key, MAX_MACRO_GRAMS)?),
        carbs: round1(required_f64_bounded(input, carbs_key, MAX_MACRO_GRAMS)?),
        fat: round1(required_f64_bounded(input, fat_key, MAX_MACRO_GRAMS)?),
        calories: required_i32(input, calories_key)?,
    })
}

fn require_any_nutrition(macros: &MacroValues) -> AppResult<()> {
    if macros.protein > 0.0 || macros.carbs > 0.0 || macros.fat > 0.0 || macros.calories > 0 {
        return Ok(());
    }
    Err(AppError::BadRequest(
        "At least one macro or calorie value must be greater than zero.".to_string(),
    ))
}

fn validate_meal_components(
    label: &str,
    sort_order: i32,
    quantity: f64,
    unit: &str,
    serving_multiplier: f64,
    macros: &MacroValues,
    label_message: &str,
) -> AppResult<()> {
    if label.trim().is_empty() {
        return Err(AppError::BadRequest(label_message.to_string()));
    }
    if sort_order < 0 {
        return Err(AppError::BadRequest(
            "Sort order must be a non-negative integer.".to_string(),
        ));
    }
    if !quantity.is_finite() || quantity <= 0.0 {
        return Err(AppError::BadRequest(
            "Quantity must be a positive number.".to_string(),
        ));
    }
    if !is_quantity_unit(unit) {
        return Err(AppError::BadRequest(
            "Quantity unit is invalid.".to_string(),
        ));
    }
    if !serving_multiplier.is_finite() || serving_multiplier <= 0.0 {
        return Err(AppError::BadRequest(
            "Serving multiplier must be a positive number.".to_string(),
        ));
    }
    require_any_nutrition(macros)
}

fn normalize_meal_food_values(
    input: &serde_json::Map<String, Value>,
    sort_order: i32,
    label_message: &str,
) -> AppResult<MealFoodValues> {
    let values = MealFoodValues {
        product_id: optional_uuid(input, "productId")?,
        label: required_string_with_message(input, "label", label_message)?,
        quantity: normalize_positive_number(input, "quantity", "Quantity", 1.0)?,
        unit: normalize_quantity_unit(input, "unit")?,
        serving_multiplier: normalize_positive_number(
            input,
            "servingMultiplier",
            "Serving multiplier",
            1.0,
        )?,
        macros: normalize_macros(input, "proteinG", "carbsG", "fatG", "caloriesKcal")?,
    };
    validate_meal_components(
        &values.label,
        sort_order,
        values.quantity,
        &values.unit,
        values.serving_multiplier,
        &values.macros,
        label_message,
    )?;
    Ok(values)
}

fn normalize_food_product_input(
    input: &serde_json::Map<String, Value>,
    scope_fallback: &str,
) -> AppResult<FoodProductValues> {
    let scope = input
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or(scope_fallback);
    if !matches!(scope, "global" | "personal" | "legacy") {
        return Err(AppError::BadRequest(
            "Product scope is invalid.".to_string(),
        ));
    }
    let source = input
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("manual");
    if !matches!(
        source,
        "manual" | "barcode" | "ai_photo" | "legacy" | "recipe"
    ) {
        return Err(AppError::BadRequest(
            "Product source is invalid.".to_string(),
        ));
    }
    let source_confidence = optional_f64(input, "sourceConfidence").map(round2);
    if let Some(value) = source_confidence
        && (!value.is_finite() || !(0.0..=1.0).contains(&value))
    {
        return Err(AppError::BadRequest(
            "Source confidence must be between 0 and 1.".to_string(),
        ));
    }
    Ok(FoodProductValues {
        scope: scope.to_string(),
        source: source.to_string(),
        barcode: trim_optional_string(input, "barcode"),
        name: required_string_with_message(input, "name", "Product name is required.")?,
        brand: trim_optional_string(input, "brand").unwrap_or_default(),
        default_serving_quantity: normalize_positive_number(
            input,
            "defaultServingQuantity",
            "Default serving quantity",
            1.0,
        )?,
        default_serving_unit: normalize_quantity_unit(input, "defaultServingUnit")?,
        macros: normalize_macros(
            input,
            "proteinPer100",
            "carbsPer100",
            "fatPer100",
            "caloriesPer100",
        )?,
        serving_weight_g: optional_positive_number(input, "servingWeightG", "Serving weight")?,
        serving_volume_ml: optional_positive_number(input, "servingVolumeMl", "Serving volume")?,
        source_provider: trim_optional_string(input, "sourceProvider"),
        source_confidence,
        source_metadata: input
            .get("sourceMetadata")
            .cloned()
            .unwrap_or_else(|| json!({})),
        corrected_from_product_id: optional_uuid(input, "correctedFromProductId")?,
    })
}

fn normalize_weight_entry_input(
    input: &serde_json::Map<String, Value>,
) -> AppResult<WeightEntryValues> {
    // Rounded before the bound check: `weight_kg` lands in a `numeric(5, 2)`
    // column, so a value that only overflows *after* rounding (999.995) has to
    // be rejected too.
    let weight_kg = optional_f64(input, "weightKg")
        .map(round2)
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| AppError::BadRequest("Weight must be a positive number.".to_string()))?;
    if weight_kg >= 1000.0 {
        return Err(AppError::BadRequest(
            "Weight must be less than 1000 kg.".to_string(),
        ));
    }
    let body_fat_pct = optional_f64(input, "bodyFatPct");
    if let Some(value) = body_fat_pct
        && (!value.is_finite() || !(0.0..=100.0).contains(&value))
    {
        return Err(AppError::BadRequest(
            "Body fat percentage must be between 0 and 100.".to_string(),
        ));
    }
    Ok(WeightEntryValues {
        date: required_date(input, "date")?,
        weight_kg: round2(weight_kg),
        body_fat_pct: body_fat_pct.map(round1),
        notes: trim_optional_string(input, "notes"),
    })
}

fn required_string(input: &serde_json::Map<String, Value>, key: &str) -> AppResult<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::BadRequest(format!("{key} is required.")))
}

fn required_date(input: &serde_json::Map<String, Value>, key: &str) -> AppResult<String> {
    let value = required_string(input, key)?;
    ensure_date_string(&value)?;
    Ok(value)
}

fn optional_uuid(input: &serde_json::Map<String, Value>, key: &str) -> AppResult<Option<Uuid>> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.trim().is_empty() => Ok(None),
        Some(Value::String(value)) => Uuid::parse_str(value)
            .map(Some)
            .map_err(|_| AppError::BadRequest(format!("{key} must be a UUID."))),
        _ => Err(AppError::BadRequest(format!("{key} must be a UUID."))),
    }
}

fn optional_f64(input: &serde_json::Map<String, Value>, key: &str) -> Option<f64> {
    input
        .get(key)
        .and_then(|value| match value {
            Value::Number(number) => number.as_f64(),
            // `"inf"`/`"NaN"`/`"-inf"` all parse successfully into f64, so the
            // finiteness check below is what keeps them out.
            Value::String(value) => value.parse().ok(),
            _ => None,
        })
        .filter(|value: &f64| value.is_finite())
}

fn optional_i32(input: &serde_json::Map<String, Value>, key: &str) -> Option<i32> {
    input.get(key).and_then(|value| match value {
        Value::Number(number) => number.as_i64().and_then(|value| i32::try_from(value).ok()),
        Value::String(value) => value.parse().ok(),
        _ => None,
    })
}

/// Widest value a `numeric(6, 1)` column accepts. Anything larger reaches the
/// INSERT and comes back as a Postgres numeric-field-overflow — a 500 for what
/// is really a client input error.
pub(crate) const MAX_MACRO_GRAMS: f64 = 99_999.9;
/// Widest value a `numeric(8, 2)` column accepts.
pub(crate) const MAX_QUANTITY: f64 = 999_999.99;

fn required_f64(input: &serde_json::Map<String, Value>, key: &str) -> AppResult<f64> {
    optional_f64(input, key)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| AppError::BadRequest(format!("{key} must be a non-negative number.")))
}

fn required_f64_bounded(
    input: &serde_json::Map<String, Value>,
    key: &str,
    max: f64,
) -> AppResult<f64> {
    let value = required_f64(input, key)?;
    if value > max {
        return Err(AppError::BadRequest(format!(
            "{key} must be at most {max}."
        )));
    }
    Ok(value)
}

fn required_i32(input: &serde_json::Map<String, Value>, key: &str) -> AppResult<i32> {
    optional_i32(input, key)
        .filter(|value| *value >= 0)
        .ok_or_else(|| AppError::BadRequest(format!("{key} must be a non-negative integer.")))
}

fn required_f64_lossy(input: &serde_json::Map<String, Value>, key: &str) -> f64 {
    optional_f64(input, key).unwrap_or(0.0)
}

fn required_i32_lossy(input: &serde_json::Map<String, Value>, key: &str) -> i32 {
    optional_i32(input, key).unwrap_or(0)
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;
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

    async fn test_db() -> Option<TestDb> {
        test_db_with_connections(1).await
    }

    async fn test_db_with_connections(max_connections: u32) -> Option<TestDb> {
        let database_url = env::var("TEST_DATABASE_URL")
            .or_else(|_| env::var("DATABASE_URL"))
            .ok()?;
        let schema = format!("backend_test_{}", Uuid::new_v4().simple());
        let setup_pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await
            .ok()?;
        sqlx::query(&format!(r#"CREATE SCHEMA "{}""#, schema))
            .execute(&setup_pool)
            .await
            .ok()?;
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
            .ok()?;
        sqlx::raw_sql(SCHEMA_SQL).execute(&pool).await.ok()?;
        Some(TestDb { pool, schema })
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

    #[tokio::test]
    async fn ensure_default_meal_groups_creates_all_groups_idempotently() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
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

    #[tokio::test]
    async fn ensure_default_meal_groups_reactivates_a_soft_deleted_default() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
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

    #[tokio::test]
    async fn apply_day_template_resolves_exact_and_unambiguous_meal_group_labels() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
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

    #[tokio::test]
    async fn list_admin_barcode_products_applies_catalogue_filters_to_items_and_totals() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
        let alice_id =
            insert_test_user_with_email(&test_db.pool, "alice.submitter@example.test").await;
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

    #[tokio::test]
    async fn search_food_products_blank_query_returns_empty_array() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
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

    #[tokio::test]
    async fn search_food_products_matches_each_word_independently() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
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

    #[tokio::test]
    async fn search_food_products_prioritizes_corrected_and_personal_products() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
        let user_id = insert_test_user(&test_db.pool).await;
        let global_id =
            insert_test_food_product(&test_db.pool, None, "Alpha Yogurt", "Macro", None).await;
        let personal_id =
            insert_test_food_product(&test_db.pool, Some(user_id), "Beta Yogurt", "Macro", None)
                .await;
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

    #[tokio::test]
    async fn admin_user_detail_preserves_recent_activity_contracts() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
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

    #[tokio::test]
    async fn search_meal_entries_excludes_planned_and_skipped_entries() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
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
        let ids = results
            .as_array()
            .expect("search result should be array")
            .iter()
            .map(|item| item.get("id").and_then(Value::as_str).unwrap())
            .collect::<Vec<_>>();

        assert_eq!(ids, vec![eaten_id.to_string()]);
        test_db.cleanup().await;
    }

    #[tokio::test]
    async fn search_meal_entries_deduplicates_equivalent_historical_foods() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
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
        let ids = results
            .as_array()
            .expect("search result should be array")
            .iter()
            .map(|item| item.get("id").and_then(Value::as_str).unwrap())
            .collect::<Vec<_>>();

        assert_eq!(ids, vec![newest_id.to_string(), distinct_id.to_string()]);
        test_db.cleanup().await;
    }

    #[tokio::test]
    async fn search_meal_entries_hides_soft_deleted_product_id_but_keeps_macro_snapshot() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
        let user_id = insert_test_user(&test_db.pool).await;
        let product_id =
            insert_test_food_product(&test_db.pool, Some(user_id), "Deleted Protein", "", None)
                .await;
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

    #[tokio::test]
    async fn get_recent_quick_add_candidates_defaults_to_thirty_when_limit_is_omitted() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
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

    #[tokio::test]
    async fn leaderboard_handles_empty_grace_gaps_ties_and_large_history() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };

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

    #[tokio::test]
    async fn list_recent_meal_entries_excludes_planned_and_skipped_entries() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
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
        let ids = results
            .as_array()
            .expect("recent result should be array")
            .iter()
            .map(|item| item.get("id").and_then(Value::as_str).unwrap())
            .collect::<Vec<_>>();

        assert_eq!(ids, vec![eaten_id.to_string()]);
        test_db.cleanup().await;
    }

    #[tokio::test]
    async fn concurrent_owner_demotions_cannot_remove_last_owner() {
        let Some(test_db) = test_db_with_connections(4).await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
        let actor_id = insert_test_user_with_email(&test_db.pool, "owner-a@example.test").await;
        let other_owner_id =
            insert_test_user_with_email(&test_db.pool, "owner-b@example.test").await;
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

    #[tokio::test]
    async fn set_user_role_rolls_back_role_when_audit_insert_fails() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
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
        let audit_count: i64 =
            sqlx::query("SELECT count(*)::bigint AS count FROM admin_audit_events")
                .fetch_one(&test_db.pool)
                .await
                .expect("audit count should query")
                .try_get("count")
                .unwrap();
        assert_eq!(role, "user");
        assert_eq!(audit_count, 0);

        test_db.cleanup().await;
    }

    #[tokio::test]
    async fn create_admin_barcode_product_rolls_back_product_and_revision_when_audit_fails() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
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
        let product_count: i64 =
            sqlx::query("SELECT count(*)::bigint AS count FROM food_products WHERE barcode = $1")
                .bind(&barcode)
                .fetch_one(&test_db.pool)
                .await
                .expect("product count should query")
                .try_get("count")
                .unwrap();
        let revision_count: i64 =
            sqlx::query("SELECT count(*)::bigint AS count FROM food_product_revisions")
                .fetch_one(&test_db.pool)
                .await
                .expect("revision count should query")
                .try_get("count")
                .unwrap();
        assert_eq!(product_count, 0);
        assert_eq!(revision_count, 0);

        test_db.cleanup().await;
    }

    #[tokio::test]
    async fn update_admin_barcode_product_rolls_back_product_when_revision_fails() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
        let actor_id =
            insert_test_user_with_email(&test_db.pool, "admin-update@example.test").await;
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

    #[tokio::test]
    async fn delete_admin_barcode_product_rolls_back_product_when_audit_fails() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
        let actor_id =
            insert_test_user_with_email(&test_db.pool, "admin-delete@example.test").await;
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

    #[tokio::test]
    async fn save_barcode_food_product_rpc_creates_created_revision() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
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

    #[tokio::test]
    async fn save_barcode_food_product_rolls_back_product_when_created_revision_fails() {
        let Some(test_db) = test_db().await else {
            eprintln!(
                "skipping PostgreSQL integration test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
            return;
        };
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
        let product_count: i64 =
            sqlx::query("SELECT count(*)::bigint AS count FROM food_products WHERE barcode = $1")
                .bind(&barcode)
                .fetch_one(&test_db.pool)
                .await
                .expect("product count should query")
                .try_get("count")
                .unwrap();
        let revision_count: i64 =
            sqlx::query("SELECT count(*)::bigint AS count FROM food_product_revisions")
                .fetch_one(&test_db.pool)
                .await
                .expect("revision count should query")
                .try_get("count")
                .unwrap();

        assert_eq!(product_count, 0);
        assert_eq!(revision_count, 0);

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
    fn onboarding_weight_normalization_rejects_zero_and_post_rounding_overflow() {
        let weight = |value: Value| {
            serde_json::Map::from_iter([
                ("date".to_string(), json!("2026-01-15")),
                ("weightKg".to_string(), value),
            ])
        };

        assert!(normalize_weight_entry_input(&weight(json!(72.5))).is_ok());
        assert!(normalize_weight_entry_input(&weight(json!(0))).is_err());
        assert!(normalize_weight_entry_input(&weight(json!(-1))).is_err());
        assert!(normalize_weight_entry_input(&weight(json!(1e30))).is_err());
        // Rounds up into overflow for numeric(5, 2).
        assert!(normalize_weight_entry_input(&weight(json!(999.995))).is_err());
        // The date is validated on this path too.
        let mut infinity_date = weight(json!(72.5));
        infinity_date.insert("date".to_string(), json!("infinity"));
        assert!(normalize_weight_entry_input(&infinity_date).is_err());
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

        let too_many_terms = vec!["term"; MAX_SEARCH_TERMS + 1].join(" ");
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
    fn weight_validation_rejects_invalid_values_and_trims_notes() {
        let base = serde_json::Map::from_iter([
            ("date".to_string(), json!("2026-07-09")),
            ("weightKg".to_string(), json!(80.0)),
            ("bodyFatPct".to_string(), json!(20.0)),
            ("notes".to_string(), json!("  hello  ")),
        ]);
        let values = normalize_weight_entry_input(&base).expect("valid weight entry");
        assert_eq!(values.notes.as_deref(), Some("hello"));

        let mut zero = base.clone();
        zero.insert("weightKg".to_string(), json!(0));
        assert_eq!(
            bad_request_message(normalize_weight_entry_input(&zero)),
            "Weight must be a positive number."
        );

        let mut huge = base.clone();
        huge.insert("weightKg".to_string(), json!(1000));
        assert_eq!(
            bad_request_message(normalize_weight_entry_input(&huge)),
            "Weight must be less than 1000 kg."
        );

        let mut bad_body_fat = base;
        bad_body_fat.insert("bodyFatPct".to_string(), json!(101));
        assert_eq!(
            bad_request_message(normalize_weight_entry_input(&bad_body_fat)),
            "Body fat percentage must be between 0 and 100."
        );
    }

    #[test]
    fn only_admin_and_owner_roles_are_admin_actors() {
        assert!(is_admin_actor_role("admin"));
        assert!(is_admin_actor_role("owner"));
        assert!(!is_admin_actor_role("user"));
        assert!(!is_admin_actor_role(""));
    }

    #[test]
    fn api_token_scope_validation_rejects_empty_unknown_and_non_string_scopes() {
        assert_eq!(
            bad_request_message(normalize_api_token_scopes(Some(&json!([])))),
            "API token must include at least one scope."
        );
        assert_eq!(
            bad_request_message(normalize_api_token_scopes(Some(&json!([
                "read:daily",
                "admin:*"
            ])))),
            "API token scope is invalid."
        );
        assert_eq!(
            bad_request_message(normalize_api_token_scopes(Some(&json!(["read:daily", 42])))),
            "API token scope is invalid."
        );
    }

    #[test]
    fn api_token_scope_validation_dedupes_valid_scopes_in_order() {
        let scopes =
            normalize_api_token_scopes(Some(&json!(["read:daily", "write:daily", "read:daily"])))
                .expect("valid scopes should normalize");

        assert_eq!(scopes, vec!["read:daily", "write:daily"]);
    }

    #[test]
    fn api_token_expiry_validation_preserves_defaults_and_nulls() {
        let default = normalize_api_token_expiry(None)
            .expect("missing expiry should default")
            .expect("default expiry should be set");
        let days = default.signed_duration_since(Utc::now()).num_days();
        assert!((89..=90).contains(&days));

        assert!(
            normalize_api_token_expiry(Some(&Value::Null))
                .expect("null expiry should be accepted")
                .is_none()
        );
    }

    #[test]
    fn api_token_expiry_validation_rejects_invalid_strings() {
        assert_eq!(
            bad_request_message(normalize_api_token_expiry(Some(&json!("not-a-date")))),
            "API token expiry is invalid."
        );
    }

    #[test]
    fn expected_drizzle_migrations_match_repo_sql_files() {
        let expected = expected_drizzle_migrations().expect("journal should parse");
        let expected_tags = expected
            .iter()
            .map(|(tag, _)| tag.as_str())
            .collect::<HashSet<_>>();
        let drizzle_dir =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/db/drizzle");
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
}
