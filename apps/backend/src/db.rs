use crate::{
    errors::{AppError, AppResult},
    types::{AppUser, MacroGoals, ShooProfile},
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgRow};
use uuid::Uuid;

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

pub async fn bootstrap_schema(pool: &PgPool) -> AppResult<()> {
    sqlx::raw_sql(SCHEMA_SQL).execute(pool).await?;
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
    .fetch_one(pool)
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

pub async fn save_user_goals(pool: &PgPool, user_id: Uuid, goals: MacroGoals) -> AppResult<()> {
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
    sqlx::query(
        r#"
        UPDATE api_tokens
        SET last_used_at = now()
        WHERE id = $1
          AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')
        "#,
    )
    .bind(id)
    .execute(pool)
    .await?;
    let refreshed = sqlx::query(
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
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_one(pool)
    .await?;
    let record = api_token_row_json(&refreshed)?;
    Ok(json!({ "ok": true, "token": record }))
}

pub async fn ensure_default_meal_groups(pool: &PgPool, user_id: Uuid) -> AppResult<()> {
    let labels = ["Breakfast", "Lunch", "Dinner", "Snack"];
    for (index, label) in labels.iter().enumerate() {
        let id = Uuid::new_v5(
            &Uuid::NAMESPACE_URL,
            format!("macro-tracker:meal-group:{user_id}:{label}").as_bytes(),
        );
        sqlx::query(
            r#"
            INSERT INTO meal_groups (id, user_id, label, sort_order, is_default)
            VALUES ($1, $2, $3, $4, true)
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(id)
        .bind(user_id)
        .bind(label)
        .bind(index as i32)
        .execute(pool)
        .await?;
    }
    Ok(())
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
    .map_err(|error| AppError::BadRequest(error.to_string()))?;
    let goal_weight_kg = match input.get("goalWeightKg") {
        None | Some(Value::Null) => None,
        Some(value) => value
            .as_f64()
            .filter(|weight| weight.is_finite() && *weight >= 0.0)
            .ok_or_else(|| {
                AppError::BadRequest("goalWeightKg must be a non-negative number.".to_string())
            })
            .map(Some)?,
    };
    let current_weight = match input.get("currentWeight") {
        None | Some(Value::Null) => None,
        Some(Value::Object(weight)) => Some(weight.clone()),
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
        .bind(required_string(weight, "date")?)
        .bind(required_f64(weight, "weightKg")?)
        .bind(optional_f64(weight, "bodyFatPct"))
        .bind(weight.get("notes").and_then(Value::as_str))
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

    for (index, label) in ["Breakfast", "Lunch", "Dinner", "Snack"].iter().enumerate() {
        let id = Uuid::new_v5(
            &Uuid::NAMESPACE_URL,
            format!("macro-tracker:meal-group:{user_id}:{label}").as_bytes(),
        );
        sqlx::query(
            r#"
            INSERT INTO meal_groups (id, user_id, label, sort_order, is_default)
            VALUES ($1, $2, $3, $4, true)
            ON CONFLICT (id) DO NOTHING
            "#,
        )
        .bind(id)
        .bind(user_id)
        .bind(label)
        .bind(index as i32)
        .execute(&mut *tx)
        .await?;
    }

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
            .map_err(|error| AppError::BadRequest(error.to_string()))?;
            Ok(serde_json::to_value(
                upsert_user_from_shoo_profile(pool, &profile).await?,
            )?)
        }
        "getUserById" => {
            let user_id = uuid_arg(&args, "userId")?;
            Ok(serde_json::to_value(get_user_by_id(pool, user_id).await?)?)
        }
        "ensureUserRole" => {
            let user_id = uuid_arg(&args, "userId")?;
            let role = string_arg(&args, "role")?;
            if !matches!(role.as_str(), "user" | "admin" | "owner") {
                return Err(AppError::BadRequest("User role is invalid.".to_string()));
            }
            Ok(serde_json::to_value(
                ensure_user_role(pool, user_id, &role).await?,
            )?)
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
            .map_err(|error| AppError::BadRequest(error.to_string()))?;
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
            for (index, id) in ordered_ids.iter().enumerate() {
                sqlx::query(
                    "UPDATE meal_groups SET sort_order = $3, updated_at = now() WHERE user_id = $1 AND id = $2",
                )
                .bind(user_id)
                .bind(id)
                .bind(index as i32)
                .execute(&mut *tx)
                .await?;
            }
            tx.commit().await?;
            ensure_default_meal_groups(pool, user_id).await?;
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
        "getDailySummary" => {
            let user_id = uuid_arg(&args, "userId")?;
            let date = string_arg(&args, "date")?;
            ensure_default_meal_groups(pool, user_id).await?;
            daily_summary_json(pool, user_id, &date).await
        }
        "getDashboardData" => {
            let user_id = uuid_arg(&args, "userId")?;
            let selected_date =
                string_arg(&args, "selectedDate").or_else(|_| string_arg(&args, "date"))?;
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
            let goal = args.get("goalWeightKg").and_then(Value::as_f64);
            sqlx::query("UPDATE users SET goal_weight_kg = $2 WHERE id = $1")
                .bind(user_id)
                .bind(goal)
                .execute(pool)
                .await?;
            Ok(json!(null))
        }
        "getWeightPageData" => {
            let user_id = uuid_arg(&args, "userId")?;
            let selected_date = string_arg(&args, "selectedDate")?;
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
                .unwrap_or(20)
                .clamp(1, 100) as i32;
            recent_quick_add_json(pool, user_id, limit).await
        }
        "listRecentMealEntries" => {
            let user_id = uuid_arg(&args, "userId")?;
            let limit = args
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(200)
                .clamp(1, 500) as i32;
            list_recent_meal_entries_json(pool, user_id, limit).await
        }
        "getRecentDailyOverviews" => {
            let user_id = uuid_arg(&args, "userId")?;
            let days = args
                .get("days")
                .and_then(Value::as_i64)
                .unwrap_or(7)
                .clamp(1, 90) as i32;
            recent_daily_overviews_json(pool, user_id, days).await
        }
        "searchMealEntries" => {
            let user_id = uuid_arg(&args, "userId")?;
            let query = string_arg(&args, "query")?;
            search_meal_entries_json(pool, user_id, &query).await
        }
        "getPeriodAverages" => {
            let user_id = uuid_arg(&args, "userId")?;
            let selected_date =
                string_arg(&args, "selectedDate").or_else(|_| string_arg(&args, "date"))?;
            period_averages_json(pool, user_id, &selected_date).await
        }
        "getStatsPageData" => {
            let user_id = uuid_arg(&args, "userId")?;
            let today = string_arg(&args, "today")
                .or_else(|_| string_arg(&args, "referenceDate"))
                .unwrap_or_else(|_| Utc::now().date_naive().to_string());
            stats_page_data_json(pool, user_id, &today).await
        }
        "getLeaderboardStats" => {
            let user_id = uuid_arg(&args, "userId")?;
            leaderboard_json(pool, user_id).await
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
            save_barcode_food_product_json(pool, user_id, input).await
        }
        "getAdminDashboardData" => admin_dashboard_json(pool).await,
        "getAdminUserHealthSummary" => admin_user_health_summary_json(pool).await,
        "listAdminUsers" => {
            let input = optional_object_arg(&args, "input");
            list_admin_users_json(pool, input).await
        }
        "getAdminUserDetail" => {
            let user_id = uuid_arg(&args, "userId")?;
            get_admin_user_detail_json(pool, user_id).await
        }
        "setUserRole" => {
            let actor_user_id = uuid_arg(&args, "actorUserId")?;
            let target_user_id = uuid_arg(&args, "targetUserId")?;
            let next_role = string_arg(&args, "nextRole")?;
            set_user_role_json(pool, actor_user_id, target_user_id, &next_role).await
        }
        "listAdminBarcodeProducts" => {
            let input = optional_object_arg(&args, "input");
            list_admin_barcode_products_json(pool, input, false).await
        }
        "listAdminBarcodeReviewQueue" => {
            let input = optional_object_arg(&args, "input");
            list_admin_barcode_products_json(pool, input, true).await
        }
        "getAdminBarcodeProductById" => {
            let product_id = uuid_arg(&args, "barcodeProductId")?;
            Ok(admin_food_product_by_id_json(pool, product_id)
                .await?
                .unwrap_or(Value::Null))
        }
        "createAdminBarcodeProduct" => {
            let actor_user_id = uuid_arg(&args, "actorUserId")?;
            let input = object_arg(&args, "input")?;
            create_admin_barcode_product_json(pool, actor_user_id, input).await
        }
        "updateAdminBarcodeProduct" => {
            let actor_user_id = uuid_arg(&args, "actorUserId")?;
            let product_id = uuid_arg(&args, "barcodeProductId")?;
            let input = object_arg(&args, "input")?;
            update_admin_barcode_product_json(pool, actor_user_id, product_id, input).await
        }
        "softDeleteAdminBarcodeProduct" => {
            let actor_user_id = uuid_arg(&args, "actorUserId")?;
            let product_id = uuid_arg(&args, "barcodeProductId")?;
            set_admin_barcode_deleted_json(pool, actor_user_id, product_id, true).await
        }
        "restoreAdminBarcodeProduct" => {
            let actor_user_id = uuid_arg(&args, "actorUserId")?;
            let product_id = uuid_arg(&args, "barcodeProductId")?;
            set_admin_barcode_deleted_json(pool, actor_user_id, product_id, false).await
        }
        "listAdminAuditEvents" => {
            let input = optional_object_arg(&args, "input");
            list_admin_audit_events_json(pool, input).await
        }
        "getAdminAuditEventById" => {
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
        WITH meals AS (
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
          FROM meal_entries me
          LEFT JOIN meal_groups mg ON mg.id = me.meal_group_id
          LEFT JOIN food_products fp
            ON fp.id = me.product_id
            AND fp.deleted_at IS NULL
            AND (fp.owner_user_id = me.user_id OR fp.owner_user_id IS NULL)
          WHERE me.user_id = $1 AND me.entry_date = $2::date
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
          FROM meal_entries
          WHERE user_id = $1 AND entry_date = $2::date
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
    let row = sqlx::query(
        r#"
        WITH item_data AS (
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
        FROM meal_templates mt
        LEFT JOIN item_data ON item_data.template_id = mt.id
        WHERE mt.user_id = $1 AND mt.deleted_at IS NULL
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn recipes_json(pool: &PgPool, user_id: Uuid) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        WITH ingredient_data AS (
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
        FROM recipes r
        LEFT JOIN ingredient_data ON ingredient_data.recipe_id = r.id
        WHERE r.user_id = $1
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn search_food_products_json(pool: &PgPool, user_id: Uuid, query: &str) -> AppResult<Value> {
    let pattern = format!("%{}%", query.trim().replace('%', "\\%").replace('_', "\\_"));
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
            CASE WHEN lower(name) = lower($2) THEN 0 ELSE 1 END,
            updated_at DESC
        ), '[]'::jsonb) AS data
        FROM (
          SELECT *
          FROM food_products
          WHERE
            deleted_at IS NULL
            AND (owner_user_id = $1 OR owner_user_id IS NULL)
            AND (
              name ILIKE $2 ESCAPE '\'
              OR brand ILIKE $2 ESCAPE '\'
              OR barcode ILIKE $2 ESCAPE '\'
            )
          LIMIT 20
        ) products
        "#,
    )
    .bind(user_id)
    .bind(pattern)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
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
    .fetch_optional(pool)
    .await?;

    row.map(|row| row.try_get("data"))
        .transpose()
        .map_err(Into::into)
}

async fn assert_food_product_access(
    pool: &PgPool,
    user_id: Uuid,
    product_id: Option<Uuid>,
) -> AppResult<()> {
    let Some(product_id) = product_id else {
        return Ok(());
    };
    if food_product_json_by_id(pool, user_id, product_id)
        .await?
        .is_some()
    {
        Ok(())
    } else {
        Err(AppError::NotFound("Food product not found.".to_string()))
    }
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

async fn normalize_meal_input(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
    default_sort_order: i32,
    recalculate_product_macros: bool,
) -> AppResult<(
    String,
    Option<Uuid>,
    String,
    Option<Uuid>,
    String,
    i32,
    f64,
    String,
    f64,
    f64,
    f64,
    f64,
    i32,
    Option<String>,
)> {
    let date = required_string(input, "date")?;
    let meal_group_id = optional_uuid(input, "mealGroupId")?;
    assert_meal_group_access(pool, user_id, meal_group_id).await?;
    let product_id = optional_uuid(input, "productId")?;
    let sort_order = optional_i32(input, "sortOrder").unwrap_or(default_sort_order);
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
            .filter(|label| !label.trim().is_empty())
            .map(str::to_string)
            .unwrap_or(product_label);
        return Ok((
            date,
            meal_group_id,
            status,
            Some(product_id),
            label,
            sort_order,
            quantity,
            unit,
            serving_multiplier,
            protein,
            carbs,
            fat,
            calories,
            client_mutation_id,
        ));
    }

    Ok((
        date,
        meal_group_id,
        status,
        product_id,
        required_string(input, "label")?,
        sort_order,
        optional_f64(input, "quantity").unwrap_or(1.0),
        input
            .get("unit")
            .and_then(Value::as_str)
            .unwrap_or("serving")
            .to_string(),
        optional_f64(input, "servingMultiplier").unwrap_or(1.0),
        required_f64(input, "proteinG")?,
        required_f64(input, "carbsG")?,
        required_f64(input, "fatG")?,
        required_i32(input, "caloriesKcal")?,
        client_mutation_id,
    ))
}

async fn create_meal_entry_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let date = required_string(input, "date")?;
    let row = sqlx::query(
        "SELECT coalesce(max(sort_order), -1) + 1 AS sort_order FROM meal_entries WHERE user_id = $1 AND entry_date = $2::date",
    )
    .bind(user_id)
    .bind(&date)
    .fetch_one(pool)
    .await?;
    let next_sort_order: i32 = row.try_get("sort_order")?;
    let (
        date,
        meal_group_id,
        status,
        product_id,
        label,
        sort_order,
        quantity,
        unit,
        serving_multiplier,
        protein,
        carbs,
        fat,
        calories,
        client_mutation_id,
    ) = normalize_meal_input(pool, user_id, input, next_sort_order, true).await?;

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
    .bind(date)
    .bind(meal_group_id)
    .bind(status)
    .bind(product_id)
    .bind(label)
    .bind(sort_order)
    .bind(quantity)
    .bind(unit)
    .bind(serving_multiplier)
    .bind(protein)
    .bind(carbs)
    .bind(fat)
    .bind(calories)
    .bind(client_mutation_id.as_deref())
    .fetch_optional(pool)
    .await?;

    if let Some(row) = inserted {
        let created_id: Uuid = row.try_get("id")?;
        return meal_entry_json(pool, user_id, created_id).await;
    }

    if let Some(client_mutation_id) = client_mutation_id {
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
    let (
        date,
        meal_group_id,
        status,
        product_id,
        label,
        sort_order,
        quantity,
        unit,
        serving_multiplier,
        protein,
        carbs,
        fat,
        calories,
        client_mutation_id,
    ) = normalize_meal_input(pool, user_id, merged_obj, 0, recalculate_product_macros).await?;

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
    .bind(date)
    .bind(meal_group_id)
    .bind(status)
    .bind(product_id)
    .bind(label)
    .bind(sort_order)
    .bind(quantity)
    .bind(unit)
    .bind(serving_multiplier)
    .bind(protein)
    .bind(carbs)
    .bind(fat)
    .bind(calories)
    .bind(client_mutation_id.as_deref())
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
    for (index, item) in items.iter().enumerate() {
        let item = item
            .as_object()
            .ok_or_else(|| AppError::BadRequest("Template item must be an object.".to_string()))?;
        sqlx::query(
            r#"
            INSERT INTO meal_template_items (
              id, template_id, product_id, meal_group_label, sort_order, label,
              quantity, unit, serving_multiplier, protein_g, carbs_g, fat_g, calories_kcal
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(template_id)
        .bind(optional_uuid(item, "productId")?)
        .bind(item.get("mealGroupLabel").and_then(Value::as_str))
        .bind(index as i32)
        .bind(required_string(item, "label")?)
        .bind(optional_f64(item, "quantity").unwrap_or(1.0))
        .bind(
            item.get("unit")
                .and_then(Value::as_str)
                .unwrap_or("serving"),
        )
        .bind(optional_f64(item, "servingMultiplier").unwrap_or(1.0))
        .bind(required_f64(item, "proteinG")?)
        .bind(required_f64(item, "carbsG")?)
        .bind(required_f64(item, "fatG")?)
        .bind(required_i32(item, "caloriesKcal")?)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn validate_item_product_access(
    pool: &PgPool,
    user_id: Uuid,
    items: &[Value],
) -> AppResult<()> {
    for item in items {
        let item = item
            .as_object()
            .ok_or_else(|| AppError::BadRequest("Item must be an object.".to_string()))?;
        assert_food_product_access(pool, user_id, optional_uuid(item, "productId")?).await?;
    }
    Ok(())
}

async fn template_by_id_json(pool: &PgPool, user_id: Uuid, template_id: Uuid) -> AppResult<Value> {
    let all = templates_json(pool, user_id).await?;
    all.as_array()
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("id").and_then(Value::as_str) == Some(&template_id.to_string())
            })
        })
        .cloned()
        .ok_or_else(|| AppError::NotFound("Template not found.".to_string()))
}

async fn apply_template_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
    test_fault: Option<&serde_json::Map<String, Value>>,
) -> AppResult<Value> {
    let template_id = optional_uuid(input, "templateId")?
        .ok_or_else(|| AppError::BadRequest("templateId is required.".to_string()))?;
    let date = required_string(input, "date")?;
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
        meal.insert("date".to_string(), Value::String(date.clone()));
        meal.insert("status".to_string(), Value::String(status.clone()));
        normalized.push(
            normalize_meal_input(pool, user_id, &meal, next_sort_order + index as i32, true)
                .await?,
        );
    }

    let mut tx = pool.begin().await?;
    let mut created_ids = Vec::new();
    for (index, meal) in normalized.into_iter().enumerate() {
        maybe_trigger_test_fault(test_fault, index + 1)?;
        let (
            date,
            meal_group_id,
            status,
            product_id,
            label,
            sort_order,
            quantity,
            unit,
            serving_multiplier,
            protein,
            carbs,
            fat,
            calories,
            client_mutation_id,
        ) = meal;
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
        .bind(date)
        .bind(meal_group_id)
        .bind(status)
        .bind(product_id)
        .bind(label)
        .bind(sort_order)
        .bind(quantity)
        .bind(unit)
        .bind(serving_multiplier)
        .bind(protein)
        .bind(carbs)
        .bind(fat)
        .bind(calories)
        .bind(client_mutation_id.as_deref())
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(row) = inserted {
            created_ids.push(row.try_get::<Uuid, _>("id")?);
        } else if let Some(client_mutation_id) = client_mutation_id {
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

    let mut created = Vec::new();
    for id in created_ids {
        created.push(meal_entry_json(pool, user_id, id).await?);
    }
    Ok(Value::Array(created))
}

async fn create_template_from_date_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let date = required_string(input, "date")?;
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
            if let Some(meal_group_id) = meal.get("mealGroupId").and_then(Value::as_str) {
                if let Some(label) = group_label_by_id.get(meal_group_id) {
                    item.insert("mealGroupLabel".to_string(), Value::String(label.clone()));
                }
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
    let requested_scope = input
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or(if personal { "personal" } else { "global" });
    if !matches!(requested_scope, "global" | "personal" | "legacy") {
        return Err(AppError::BadRequest(
            "Product scope is invalid.".to_string(),
        ));
    }
    let scope = if personal { "personal" } else { "global" };
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
    let default_serving_unit = input
        .get("defaultServingUnit")
        .and_then(Value::as_str)
        .unwrap_or("serving");
    if !matches!(default_serving_unit, "g" | "ml" | "serving" | "count") {
        return Err(AppError::BadRequest(
            "Quantity unit is invalid.".to_string(),
        ));
    }
    let barcode = input
        .get("barcode")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if !personal
        && source == "barcode"
        && let Some(barcode) = barcode.as_deref()
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
    .bind(scope)
    .bind(source)
    .bind(barcode.as_deref())
    .bind(required_string(input, "name")?)
    .bind(input.get("brand").and_then(Value::as_str).unwrap_or(""))
    .bind(optional_f64(input, "defaultServingQuantity").unwrap_or(1.0))
    .bind(default_serving_unit)
    .bind(required_f64(input, "proteinPer100")?)
    .bind(required_f64(input, "carbsPer100")?)
    .bind(required_f64(input, "fatPer100")?)
    .bind(required_i32(input, "caloriesPer100")?)
    .bind(optional_f64(input, "servingWeightG"))
    .bind(optional_f64(input, "servingVolumeMl"))
    .bind(Some(user_id))
    .bind(input.get("sourceProvider").and_then(Value::as_str))
    .bind(optional_f64(input, "sourceConfidence"))
    .bind(
        input
            .get("sourceMetadata")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )
    .bind(optional_uuid(input, "correctedFromProductId")?)
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
    .fetch_optional(pool)
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

async fn save_barcode_food_product_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let barcode = required_string(input, "barcode")?;
    let name = required_string(input, "name")?;
    let brands = input.get("brands").and_then(Value::as_str).unwrap_or("");
    let serving_size_g = optional_f64(input, "servingSizeG");
    let product_input = serde_json::Map::from_iter([
        ("barcode".to_string(), Value::String(barcode)),
        ("name".to_string(), Value::String(name)),
        ("brand".to_string(), Value::String(brands.to_string())),
        (
            "defaultServingQuantity".to_string(),
            json!(serving_size_g.unwrap_or(100.0)),
        ),
        (
            "defaultServingUnit".to_string(),
            Value::String("g".to_string()),
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
            serving_size_g.map_or(Value::Null, |value| json!(value)),
        ),
        ("servingVolumeMl".to_string(), Value::Null),
        ("source".to_string(), Value::String("barcode".to_string())),
        (
            "sourceProvider".to_string(),
            Value::String("community".to_string()),
        ),
        (
            "sourceMetadata".to_string(),
            json!({ "servingSizeG": serving_size_g }),
        ),
    ]);
    create_food_product_json(pool, user_id, &product_input, false).await
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
        admin_food_products_json(pool, 1, 5, false).await?["items"].clone();
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
    if let Some(role) = role {
        if !matches!(role, "user" | "admin" | "owner") {
            return Err(AppError::BadRequest("User role is invalid.".to_string()));
        }
    }
    let activity = input
        .get("activity")
        .and_then(Value::as_str)
        .filter(|value| *value != "all");
    if let Some(activity) = activity {
        if !matches!(activity, "active7" | "inactive7" | "inactive30") {
            return Err(AppError::BadRequest(
                "User activity filter is invalid.".to_string(),
            ));
        }
    }
    let health = input
        .get("health")
        .and_then(Value::as_str)
        .filter(|value| *value != "all");
    if let Some(health) = health {
        if !matches!(
            health,
            "onboarded_no_logs" | "no_goals" | "no_weight_entries" | "heavy_barcode_submitters"
        ) {
            return Err(AppError::BadRequest(
                "User health filter is invalid.".to_string(),
            ));
        }
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
    let recent_recipes = recipes_json(pool, user_id).await?;
    let recent_templates = templates_json(pool, user_id).await?;
    Ok(json!({
        "user": user,
        "goals": get_user_goals(pool, user_id).await?,
        "counts": {
            "mealEntries": counts.try_get::<i32, _>("meal_entries")?,
            "weightEntries": counts.try_get::<i32, _>("weight_entries")?,
            "recipes": counts.try_get::<i32, _>("recipes")?,
            "templates": counts.try_get::<i32, _>("templates")?,
            "barcodeSubmissions": counts.try_get::<i32, _>("barcode_submissions")?
        },
        "recentMeals": list_recent_meal_entries_json(pool, user_id, 10).await?,
        "recentWeights": weight_entries_json(pool, user_id).await?,
        "recentRecipes": recent_recipes.as_array().cloned().unwrap_or_default().into_iter().take(10).collect::<Vec<_>>(),
        "recentTemplates": recent_templates.as_array().cloned().unwrap_or_default().into_iter().take(10).collect::<Vec<_>>(),
        "recentBarcodeSubmissions": search_food_products_json(pool, user_id, "").await?
    }))
}

async fn set_user_role_json(
    pool: &PgPool,
    actor_user_id: Uuid,
    target_user_id: Uuid,
    next_role: &str,
) -> AppResult<Value> {
    if !matches!(next_role, "user" | "admin" | "owner") {
        return Err(AppError::BadRequest("User role is invalid.".to_string()));
    }
    let actor = get_user_by_id(pool, actor_user_id)
        .await?
        .ok_or_else(|| AppError::Forbidden("Actor user not found.".to_string()))?;
    if actor.role != "owner" {
        return Err(AppError::Forbidden(
            "Only owners can change user roles.".to_string(),
        ));
    }
    let target = get_user_by_id(pool, target_user_id)
        .await?
        .ok_or_else(|| AppError::NotFound("User not found.".to_string()))?;
    if target.role == next_role {
        return Ok(serde_json::to_value(target)?);
    }
    if target.role == "owner" && next_role != "owner" {
        let row = sqlx::query("SELECT count(*)::int AS total FROM users WHERE role = 'owner'")
            .fetch_one(pool)
            .await?;
        let owner_count: i32 = row.try_get("total")?;
        if owner_count <= 1 {
            return Err(AppError::BadRequest(
                "You cannot demote the last owner.".to_string(),
            ));
        }
    }
    let user = ensure_user_role(pool, target_user_id, next_role).await?;
    insert_admin_audit_event(
        pool,
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
    Ok(serde_json::to_value(user)?)
}

async fn list_admin_barcode_products_json(
    pool: &PgPool,
    input: &serde_json::Map<String, Value>,
    review_queue: bool,
) -> AppResult<Value> {
    let (page, page_size, _offset) = pagination(input);
    admin_food_products_json(pool, page, page_size, review_queue).await
}

async fn admin_food_products_json(
    pool: &PgPool,
    page: i64,
    page_size: i64,
    review_queue: bool,
) -> AppResult<Value> {
    let offset = (page - 1) * page_size;
    let rows = sqlx::query(
        r#"
        WITH barcode_products AS (
          SELECT
            fp.*,
            nullif(regexp_replace(lower(trim(fp.name)), '\s+', ' ', 'g'), '') AS review_name
          FROM food_products fp
          WHERE fp.owner_user_id IS NULL AND fp.source = 'barcode'
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
    .fetch_all(pool)
    .await?;
    let total_row = sqlx::query(
        r#"
        WITH barcode_products AS (
          SELECT
            fp.*,
            nullif(regexp_replace(lower(trim(fp.name)), '\s+', ' ', 'g'), '') AS review_name
          FROM food_products fp
          WHERE fp.owner_user_id IS NULL AND fp.source = 'barcode'
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
    .fetch_optional(pool)
    .await?;
    row.map(|row| row.try_get("data"))
        .transpose()
        .map_err(Into::into)
}

async fn create_admin_barcode_product_json(
    pool: &PgPool,
    actor_user_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let product = save_barcode_food_product_json(pool, actor_user_id, input).await?;
    let product_id = product
        .get("id")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| AppError::BadRequest("Created product id is invalid.".to_string()))?;
    insert_food_product_revision(
        pool,
        product_id,
        Some(actor_user_id),
        "created",
        product.clone(),
    )
    .await?;
    insert_admin_audit_event(
        pool,
        actor_user_id,
        "admin",
        "barcode.created",
        "food_product",
        product_id,
        json!({
            "barcode": product.get("barcode").cloned().unwrap_or(Value::Null),
            "name": product.get("name").cloned().unwrap_or(Value::Null)
        }),
    )
    .await?;
    Ok(product)
}

async fn update_admin_barcode_product_json(
    pool: &PgPool,
    actor_user_id: Uuid,
    product_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let before = admin_food_product_by_id_json(pool, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Barcode product not found.".to_string()))?;
    let barcode = required_string(input, "barcode")?;
    if active_global_barcode_exists(pool, &barcode, Some(product_id)).await? {
        return Err(AppError::BadRequest(
            "That barcode already exists.".to_string(),
        ));
    }
    let name = required_string(input, "name")?;
    let brand = input.get("brands").and_then(Value::as_str).unwrap_or("");
    let serving_size_g = optional_f64(input, "servingSizeG");
    let protein_g = required_f64(input, "proteinG")?;
    let carbs_g = required_f64(input, "carbsG")?;
    let fat_g = required_f64(input, "fatG")?;
    let calories_kcal = required_i32(input, "caloriesKcal")?;
    let updated = sqlx::query(
        r#"
        UPDATE food_products
        SET
          barcode = $2,
          name = $3,
          brand = $4,
          default_serving_quantity = coalesce($5, default_serving_quantity),
          default_serving_unit = 'g',
          protein_per_100 = $6,
          carbs_per_100 = $7,
          fat_per_100 = $8,
          calories_per_100 = $9,
          serving_weight_g = $5,
          updated_at = now()
        WHERE id = $1 AND owner_user_id IS NULL AND source = 'barcode'
        RETURNING id
        "#,
    )
    .bind(product_id)
    .bind(&barcode)
    .bind(&name)
    .bind(brand)
    .bind(serving_size_g)
    .bind(protein_g)
    .bind(carbs_g)
    .bind(fat_g)
    .bind(calories_kcal)
    .fetch_optional(pool)
    .await?
    .is_some();
    if !updated {
        return Err(AppError::NotFound("Barcode product not found.".to_string()));
    }
    let product = admin_food_product_by_id_json(pool, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Barcode product not found.".to_string()))?;
    insert_food_product_revision(
        pool,
        product_id,
        Some(actor_user_id),
        "updated",
        product.clone(),
    )
    .await?;
    insert_admin_audit_event(
        pool,
        actor_user_id,
        "admin",
        "barcode.updated",
        "food_product",
        product_id,
        json!({
            "before": before,
            "after": product
        }),
    )
    .await?;
    admin_food_product_by_id_json(pool, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Barcode product not found.".to_string()))
}

async fn set_admin_barcode_deleted_json(
    pool: &PgPool,
    actor_user_id: Uuid,
    product_id: Uuid,
    deleted: bool,
) -> AppResult<Value> {
    let existing = admin_food_product_by_id_json(pool, product_id)
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
        && active_global_barcode_exists(pool, barcode, Some(product_id)).await?
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
    .bind(actor_user_id)
    .bind(product_id)
    .bind(deleted)
    .fetch_optional(pool)
    .await?;
    if row.is_none() {
        return Err(AppError::NotFound("Barcode product not found.".to_string()));
    }
    let product = admin_food_product_by_id_json(pool, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Barcode product not found.".to_string()))?;
    insert_food_product_revision(
        pool,
        product_id,
        Some(actor_user_id),
        if deleted { "deleted" } else { "restored" },
        product,
    )
    .await?;
    insert_admin_audit_event(
        pool,
        actor_user_id,
        "admin",
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
    admin_food_product_by_id_json(pool, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Barcode product not found.".to_string()))
}

async fn insert_food_product_revision(
    pool: &PgPool,
    product_id: Uuid,
    actor_user_id: Option<Uuid>,
    action: &str,
    snapshot: Value,
) -> AppResult<()> {
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
    .execute(pool)
    .await?;
    Ok(())
}

async fn insert_admin_audit_event(
    pool: &PgPool,
    actor_user_id: Uuid,
    actor_role: &str,
    action: &str,
    target_type: &str,
    target_id: Uuid,
    details: Value,
) -> AppResult<()> {
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
    .execute(pool)
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
    let scopes = input
        .get("scopes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let token_secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token = format!("mtk_v1_{token_secret}");
    let token_hash = hash_token(&token);
    let token_prefix = format!("mtk_v1_{}", &token_hash[..12]);
    let expires_at = match input.get("expiresAt") {
        Some(Value::Null) => None,
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => Some((Utc::now() + chrono::Duration::days(90)).to_rfc3339()),
    };
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
    .bind(Value::Array(scopes))
    .bind(expires_at)
    .fetch_one(pool)
    .await?;
    Ok(json!({
        "token": token,
        "record": api_token_row_json(&row)?
    }))
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
    .bind(
        input
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("manual"),
    )
    .bind(input.get("barcode").and_then(Value::as_str))
    .bind(required_string(input, "name")?)
    .bind(input.get("brand").and_then(Value::as_str).unwrap_or(""))
    .bind(optional_f64(input, "defaultServingQuantity").unwrap_or(1.0))
    .bind(
        input
            .get("defaultServingUnit")
            .and_then(Value::as_str)
            .unwrap_or("serving"),
    )
    .bind(required_f64(input, "proteinPer100")?)
    .bind(required_f64(input, "carbsPer100")?)
    .bind(required_f64(input, "fatPer100")?)
    .bind(required_i32(input, "caloriesPer100")?)
    .bind(optional_f64(input, "servingWeightG"))
    .bind(optional_f64(input, "servingVolumeMl"))
    .fetch_optional(pool)
    .await?
    .is_some();
    if !updated {
        return Err(AppError::NotFound("Food product not found.".to_string()));
    }
    Ok(food_product_json_by_id(pool, user_id, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Food product not found.".to_string()))?)
}

async fn create_recipe_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
    test_fault: Option<&serde_json::Map<String, Value>>,
) -> AppResult<Value> {
    let recipe_id = Uuid::new_v4();
    let label = required_string(input, "label")?;
    let portions = optional_i32(input, "portions").unwrap_or(1).max(1);
    let total_cooked_weight_g = optional_f64(input, "totalCookedWeightG");
    let ingredients = input
        .get("ingredients")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::BadRequest("A recipe must have at least one ingredient.".to_string())
        })?;
    if ingredients.is_empty() {
        return Err(AppError::BadRequest(
            "A recipe must have at least one ingredient.".to_string(),
        ));
    }
    validate_item_product_access(pool, user_id, ingredients).await?;
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO recipes (id, user_id, label, portions, total_cooked_weight_g, updated_at) VALUES ($1, $2, $3, $4, $5, now())",
    )
    .bind(recipe_id)
    .bind(user_id)
    .bind(label)
    .bind(portions)
    .bind(total_cooked_weight_g)
    .execute(&mut *tx)
    .await?;
    insert_recipe_ingredients(&mut tx, recipe_id, ingredients, test_fault).await?;
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
    let label = required_string(input, "label")?;
    let portions = optional_i32(input, "portions").unwrap_or(1).max(1);
    let total_cooked_weight_g = optional_f64(input, "totalCookedWeightG");
    let ingredients = input
        .get("ingredients")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::BadRequest("A recipe must have at least one ingredient.".to_string())
        })?;
    if ingredients.is_empty() {
        return Err(AppError::BadRequest(
            "A recipe must have at least one ingredient.".to_string(),
        ));
    }
    validate_item_product_access(pool, user_id, ingredients).await?;
    let mut tx = pool.begin().await?;
    let updated = sqlx::query(
        "UPDATE recipes SET label = $3, portions = $4, total_cooked_weight_g = $5, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING id",
    )
    .bind(user_id)
    .bind(recipe_id)
    .bind(label)
    .bind(portions)
    .bind(total_cooked_weight_g)
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
    insert_recipe_ingredients(&mut tx, recipe_id, ingredients, test_fault).await?;
    tx.commit().await?;
    recipe_by_id_json(pool, user_id, recipe_id).await
}

async fn insert_recipe_ingredients(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    recipe_id: Uuid,
    ingredients: &[Value],
    test_fault: Option<&serde_json::Map<String, Value>>,
) -> AppResult<()> {
    for (index, ingredient) in ingredients.iter().enumerate() {
        maybe_trigger_test_fault(test_fault, index + 1)?;
        let ingredient = ingredient.as_object().ok_or_else(|| {
            AppError::BadRequest("Recipe ingredient must be an object.".to_string())
        })?;
        sqlx::query(
            r#"
            INSERT INTO recipe_ingredients (
              id, recipe_id, product_id, sort_order, label, quantity, unit,
              serving_multiplier, protein_g, carbs_g, fat_g, calories_kcal
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(recipe_id)
        .bind(optional_uuid(ingredient, "productId")?)
        .bind(index as i32)
        .bind(required_string(ingredient, "label")?)
        .bind(optional_f64(ingredient, "quantity").unwrap_or(1.0))
        .bind(
            ingredient
                .get("unit")
                .and_then(Value::as_str)
                .unwrap_or("serving"),
        )
        .bind(optional_f64(ingredient, "servingMultiplier").unwrap_or(1.0))
        .bind(required_f64(ingredient, "proteinG")?)
        .bind(required_f64(ingredient, "carbsG")?)
        .bind(required_f64(ingredient, "fatG")?)
        .bind(required_i32(ingredient, "caloriesKcal")?)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn recipe_by_id_json(pool: &PgPool, user_id: Uuid, recipe_id: Uuid) -> AppResult<Value> {
    let all = recipes_json(pool, user_id).await?;
    all.as_array()
        .and_then(|items| {
            items.iter().find(|item| {
                item.get("id").and_then(Value::as_str) == Some(recipe_id.to_string().as_str())
            })
        })
        .cloned()
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
    let date = required_string(input, "date")?;
    let weight_kg = required_f64(input, "weightKg")?;
    let body_fat_pct = optional_f64(input, "bodyFatPct");
    let notes = input.get("notes").and_then(Value::as_str);
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
        .bind(date)
        .bind(weight_kg)
        .bind(body_fat_pct)
        .bind(notes)
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
        .bind(date)
        .bind(weight_kg)
        .bind(body_fat_pct)
        .bind(notes)
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
    .bind(required_string(input, "date")?)
    .bind(required_f64(input, "weightKg")?)
    .bind(optional_f64(input, "bodyFatPct"))
    .bind(input.get("notes").and_then(Value::as_str))
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
            floor(extract(hour from created_at) / 3)::int AS bucket,
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

async fn search_meal_entries_json(pool: &PgPool, user_id: Uuid, query: &str) -> AppResult<Value> {
    let pattern = format!("%{}%", query.trim().replace('%', "\\%").replace('_', "\\_"));
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
          ORDER BY entry_date DESC, created_at DESC
        ), '[]'::jsonb) AS data
        FROM (
          SELECT *
          FROM meal_entries
          WHERE user_id = $1 AND label ILIKE $2 ESCAPE '\'
          LIMIT 30
        ) matches
        "#,
    )
    .bind(user_id)
    .bind(pattern)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn list_recent_meal_entries_json(
    pool: &PgPool,
    user_id: Uuid,
    limit: i32,
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
          ORDER BY entry_date DESC, created_at DESC, id
        ), '[]'::jsonb) AS data
        FROM (
          SELECT *
          FROM meal_entries
          WHERE user_id = $1
          ORDER BY entry_date DESC, created_at DESC, id
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

async fn recent_daily_overviews_json(pool: &PgPool, user_id: Uuid, days: i32) -> AppResult<Value> {
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
          WHERE user_id = $1 AND status = 'eaten'
          GROUP BY entry_date
          ORDER BY entry_date DESC
          LIMIT $2
        ) daily
        "#,
    )
    .bind(user_id)
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
        eaten AS (
          SELECT
            entry_date,
            sum(protein_g)::float8 AS protein_g,
            sum(carbs_g)::float8 AS carbs_g,
            sum(fat_g)::float8 AS fat_g,
            sum(calories_kcal)::int AS calories_kcal
          FROM meal_entries
          WHERE user_id = $1 AND status = 'eaten'
          GROUP BY entry_date
        ),
        planned AS (
          SELECT
            entry_date,
            sum(protein_g)::float8 AS protein_g,
            sum(carbs_g)::float8 AS carbs_g,
            sum(fat_g)::float8 AS fat_g,
            sum(calories_kcal)::int AS calories_kcal
          FROM meal_entries
          WHERE user_id = $1 AND status = 'planned'
            AND entry_date <= $2::date
          GROUP BY entry_date
        ),
        dates AS (
          SELECT entry_date FROM eaten
          UNION
          SELECT entry_date FROM planned
        ),
        daily AS (
          SELECT
            dates.entry_date,
            coalesce(eaten.protein_g, 0) AS protein_g,
            coalesce(eaten.carbs_g, 0) AS carbs_g,
            coalesce(eaten.fat_g, 0) AS fat_g,
            coalesce(eaten.calories_kcal, 0) AS calories_kcal,
            coalesce(planned.protein_g, 0) AS planned_protein_g,
            coalesce(planned.carbs_g, 0) AS planned_carbs_g,
            coalesce(planned.fat_g, 0) AS planned_fat_g,
            coalesce(planned.calories_kcal, 0) AS planned_calories_kcal
          FROM dates
          LEFT JOIN eaten ON eaten.entry_date = dates.entry_date
          LEFT JOIN planned ON planned.entry_date = dates.entry_date
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
        rolling AS (
          SELECT
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(protein_g) / count(*))::numeric, 1)::float8 END AS protein_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(carbs_g) / count(*))::numeric, 1)::float8 END AS carbs_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(fat_g) / count(*))::numeric, 1)::float8 END AS fat_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round(sum(calories_kcal)::numeric / count(*))::int END AS calories_kcal
          FROM eaten_days
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
          'bestCalorieDay', NULL,
          'topLabels', '[]'::jsonb,
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
          'macroConsistency', jsonb_build_object('calorieAvgAbsoluteDeviation', NULL, 'score', NULL),
          'rollingAverages', jsonb_build_object(
            'days7', jsonb_build_object('proteinG', rolling.protein_g, 'carbsG', rolling.carbs_g, 'fatG', rolling.fat_g, 'caloriesKcal', rolling.calories_kcal),
            'days30', jsonb_build_object('proteinG', rolling.protein_g, 'carbsG', rolling.carbs_g, 'fatG', rolling.fat_g, 'caloriesKcal', rolling.calories_kcal)
          ),
          'estimatedEnergyBalance', jsonb_build_object('averageDailyDeltaKcal', NULL, 'estimatedWeeklyWeightChangeKg', NULL),
          'proteinPerKg', NULL,
          'smoothedWeightTrend', '[]'::jsonb,
          'plannedAdherence', jsonb_build_object('plannedCount', 0, 'eatenCount', 0, 'skippedCount', 0, 'adherencePct', NULL)
        ) AS data
        FROM totals, rolling, goal_hits, user_goals, daily_totals
        "#,
    )
    .bind(user_id)
    .bind(today)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn leaderboard_json(pool: &PgPool, user_id: Uuid) -> AppResult<Value> {
    let today = Utc::now().date_naive().to_string();
    let stats = stats_page_data_json(pool, user_id, &today).await?;
    Ok(json!({
        "bestCalorieDay": stats.get("bestCalorieDay").cloned().unwrap_or(Value::Null),
        "currentStreak": stats.get("currentStreak").cloned().unwrap_or(json!(0)),
        "longestStreak": stats.get("longestStreak").cloned().unwrap_or(json!(0)),
        "topLabels": stats.get("topLabels").cloned().unwrap_or_else(|| json!([]))
    }))
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

fn string_arg(args: &Value, key: &str) -> AppResult<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| AppError::BadRequest(format!("{key} is required.")))
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

fn test_fault_arg<'a>(args: &'a Value, kind: &str) -> Option<&'a serde_json::Map<String, Value>> {
    if !cfg!(debug_assertions) {
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

fn required_string(input: &serde_json::Map<String, Value>, key: &str) -> AppResult<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::BadRequest(format!("{key} is required.")))
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
    input.get(key).and_then(|value| match value {
        Value::Number(number) => number.as_f64(),
        Value::String(value) => value.parse().ok(),
        _ => None,
    })
}

fn optional_i32(input: &serde_json::Map<String, Value>, key: &str) -> Option<i32> {
    input.get(key).and_then(|value| match value {
        Value::Number(number) => number.as_i64().map(|value| value as i32),
        Value::String(value) => value.parse().ok(),
        _ => None,
    })
}

fn required_f64(input: &serde_json::Map<String, Value>, key: &str) -> AppResult<f64> {
    optional_f64(input, key)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| AppError::BadRequest(format!("{key} must be a non-negative number.")))
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
