use crate::{
    errors::{AppError, AppResult},
    shared::{round1, round2},
    types::{AppUser, MacroGoals, ShooProfile},
};
use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, postgres::PgRow};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

mod api_tokens;
mod gym;
mod healthkit;
mod sql;
mod weight;

pub use api_tokens::authenticate_api_token;

type PgQuery<'q> = sqlx::query::Query<'q, Postgres, sqlx::postgres::PgArguments>;

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

impl FoodProductValues {
    fn bind_columns<'q>(&'q self, query: PgQuery<'q>) -> PgQuery<'q> {
        query
            .bind(&self.source)
            .bind(self.barcode.as_deref())
            .bind(&self.name)
            .bind(&self.brand)
            .bind(self.default_serving_quantity)
            .bind(&self.default_serving_unit)
            .bind(self.macros.protein)
            .bind(self.macros.carbs)
            .bind(self.macros.fat)
            .bind(self.macros.calories)
            .bind(self.serving_weight_g)
            .bind(self.serving_volume_ml)
    }

    fn bind_provenance<'q>(&'q self, query: PgQuery<'q>, submitted_by: Uuid) -> PgQuery<'q> {
        query
            .bind(Some(submitted_by))
            .bind(self.source_provider.as_deref())
            .bind(self.source_confidence)
            .bind(&self.source_metadata)
            .bind(self.corrected_from_product_id)
    }
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

const DRIZZLE_MIGRATION_JOURNAL: &str =
    include_str!("../../../packages/db/drizzle/meta/_journal.json");
const DEFAULT_MEAL_GROUP_LABELS: [&str; 4] = ["Breakfast", "Lunch", "Dinner", "Snack"];

/// The streak computation, shared verbatim by `stats_page_data_json` and
/// `leaderboard_json`.
///
/// BUG-01: the Summary page hardcoded `'currentStreak', 0` while the real
/// gaps-and-islands query lived only in the leaderboard, so every user's Summary
/// permanently read `0🔥 / Best: 0 days` even though five tests asserted correct
/// streaks — against the other consumer. Expanding one literal into both
/// queries keeps them from drifting again; a `macro_rules!` rather than a
/// `const` so each query stays a single compile-time string literal and the
/// "no `format!` into SQL" invariant holds.
///
/// Contract: the caller supplies a preceding CTE named `streak_days` with one
/// row per date the user logged an eaten entry, and binds `$2` to the reference
/// date.
macro_rules! streak_summary_ctes {
    () => {
        r#"
        dated_islands AS (
          SELECT
            entry_date,
            entry_date - row_number() OVER (ORDER BY entry_date)::int AS island
          FROM streak_days
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
              WHEN start_date <= $2::date AND end_date >= $2::date THEN ($2::date - start_date) + 1
              WHEN end_date = $2::date - 1 THEN streak_length
            END), 0)::int AS current_streak,
            coalesce(max(streak_length), 0)::int AS longest_streak
          FROM streaks
        )
        "#
    };
}
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
    "gym_slots",
    "gym_slot_statuses",
    "gym_buddies",
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
    .fetch_optional(executor)
    .await?
    // LOW-A3: an unknown user id used to surface as `RowNotFound` from
    // `fetch_one`, i.e. a 500 for what is plainly a 404.
    .ok_or_else(|| AppError::NotFound("User not found.".to_string()))?;

    row_to_app_user(row)
}

/// The `email` claim in a Shoo ID token is not proof of address ownership —
/// there is no `email_verified` claim to lean on. Refusing the login keeps a
/// token minted for one subject from ever reaching another subject's row. The
/// message deliberately does not echo the address back, so it cannot be used to
/// probe which addresses are registered.
fn account_identity_conflict() -> AppError {
    AppError::Conflict(
        "This email address is already linked to a different sign-in identity. Sign in with the original identity instead.".to_string(),
    )
}

/// Turns a `23505` unique violation into a 409 with a caller-actionable
/// message. Everything else keeps its original classification, so a genuine
/// database fault is still logged and reported as a 500.
fn map_unique_violation(message: &'static str) -> impl Fn(sqlx::Error) -> AppError {
    move |error| {
        if let sqlx::Error::Database(db_error) = &error
            && db_error.code().as_deref() == Some("23505")
        {
            return AppError::Conflict(message.to_string());
        }
        AppError::Sqlx(error)
    }
}

/// A `users_email_key` duplicate means another account already holds the
/// address. That is the same conflict as the pre-check below, reached through a
/// concurrent login rather than a stale read, so it gets the same 409 instead of
/// a generic 500.
fn map_user_email_conflict(error: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db_error) = &error
        && db_error.code().as_deref() == Some("23505")
        && db_error.constraint() == Some("users_email_key")
    {
        return account_identity_conflict();
    }
    AppError::Sqlx(error)
}

pub async fn upsert_user_from_shoo_profile(
    pool: &PgPool,
    profile: &ShooProfile,
) -> AppResult<AppUser> {
    let user_id = Uuid::new_v4();
    // SEC-03: match on `shoo_pairwise_sub` ONLY. The previous
    // `shoo_pairwise_sub = $1 OR email = $2` also matched by address and then
    // unconditionally overwrote `shoo_pairwise_sub`, so a token whose `email`
    // claim named a victim rebound the victim's row — meals, weights, goals and
    // `role` included — to the attacker's subject. Changing the address on an
    // already-matched subject is still allowed; adopting somebody else's
    // address never is.
    if let Some(existing) = sqlx::query("SELECT id FROM users WHERE shoo_pairwise_sub = $1 LIMIT 1")
        .bind(&profile.pairwise_sub)
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
        .await
        .map_err(map_user_email_conflict)?;

        return row_to_app_user(row);
    }

    // Unknown subject. If the address is already attached to some other
    // subject, refuse rather than create a second account that would then fail
    // the unique index anyway.
    if sqlx::query("SELECT 1 FROM users WHERE email = $1 LIMIT 1")
        .bind(&profile.email)
        .fetch_optional(pool)
        .await?
        .is_some()
    {
        return Err(account_identity_conflict());
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
    .await
    .map_err(map_user_email_conflict)?;

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
            && (!value.is_finite() || !(0.0..=MAX_MACRO_GRAMS).contains(&value))
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
            if !rounded.is_finite() || !(0.0..1000.0).contains(&rounded) {
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
        FROM (
          SELECT id, user_id, label, sort_order, is_default
          FROM meal_groups
          WHERE user_id = $1 AND deleted_at IS NULL
          ORDER BY sort_order, label
          LIMIT $2
        ) groups
        "#,
        &[JsonBind::Uuid(user_id), JsonBind::I64(MAX_COLLECTION_ROWS)],
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
        Some(Value::Object(weight)) => Some(weight::normalize_weight_entry_input(weight)?),
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
        // API-07: the onboarding starter template is the third write path into
        // meal_templates.type and was the one that skipped validation. Migration
        // 0016 adds a CHECK on this column, so an unvalidated value would now
        // surface as a raw 23514 -> 500 instead of a 400.
        .bind(normalize_template_type(template)?)
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
            api_tokens::create_api_token_json(pool, user_id, input).await
        }
        "listApiTokens" => {
            let user_id = uuid_arg(&args, "userId")?;
            api_tokens::list_api_tokens_json(pool, user_id).await
        }
        "revokeApiToken" => {
            let user_id = uuid_arg(&args, "userId")?;
            let token_id = uuid_arg(&args, "tokenId")?;
            api_tokens::revoke_api_token_json(pool, user_id, token_id).await
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
            // PERF-01: this used to load the account's whole template
            // collection and linear-scan it. The indexed by-id helper already
            // existed for exactly this.
            match template_by_id_json(pool, user_id, template_id).await {
                Ok(template) => Ok(template),
                Err(AppError::NotFound(_)) => Ok(Value::Null),
                Err(error) => Err(error),
            }
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
            // PERF-01: as above — the indexed helper replaces a full-collection
            // load plus linear scan.
            match recipe_by_id_json(pool, user_id, recipe_id).await {
                Ok(recipe) => Ok(recipe),
                Err(AppError::NotFound(_)) => Ok(Value::Null),
                Err(error) => Err(error),
            }
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
            weight::weight_entries_json(pool, user_id).await
        }
        // Fetches one row instead of the account's whole weight history, which
        // the PATCH handler used to load and linear-scan.
        "getWeightEntryById" => {
            let user_id = uuid_arg(&args, "userId")?;
            let entry_id = uuid_arg(&args, "entryId")?;
            weight::weight_entry_by_id_json(pool, user_id, entry_id).await
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
            weight::weight_page_data_json(pool, user_id, &selected_date).await
        }
        "createWeightEntry" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            weight::create_weight_entry_json(pool, user_id, input, true).await
        }
        "createWeightEntryNoOverwrite" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            weight::create_weight_entry_json(pool, user_id, input, false).await
        }
        "updateWeightEntry" => {
            let user_id = uuid_arg(&args, "userId")?;
            let entry_id = uuid_arg(&args, "entryId")?;
            let input = object_arg(&args, "input")?;
            weight::update_weight_entry_json(pool, user_id, entry_id, input).await
        }
        "deleteWeightEntry" => {
            let user_id = uuid_arg(&args, "userId")?;
            let entry_id = uuid_arg(&args, "entryId")?;
            weight::delete_weight_entry_json(pool, user_id, entry_id).await
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
        "getHealthkitSyncEntries" => {
            let user_id = uuid_arg(&args, "userId")?;
            let days = args
                .get("days")
                .and_then(Value::as_i64)
                .unwrap_or(7)
                .clamp(1, 30) as i32;
            let limit = args
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(100)
                .clamp(1, 200) as i32;
            healthkit::healthkit_sync_entries_json(pool, user_id, days, limit).await
        }
        "ackHealthkitSyncEntries" => {
            let user_id = uuid_arg(&args, "userId")?;
            let ids = args
                .get("entryIds")
                .and_then(Value::as_array)
                .ok_or_else(|| AppError::BadRequest("entryIds is required.".to_string()))?;
            if ids.len() > 500 {
                return Err(AppError::BadRequest(
                    "entryIds must contain at most 500 IDs.".to_string(),
                ));
            }
            let entry_ids = ids
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .ok_or_else(|| {
                            AppError::BadRequest("entryIds must contain strings.".to_string())
                        })
                        .and_then(|value| {
                            Uuid::parse_str(value).map_err(|_| {
                                AppError::BadRequest("entryIds must contain UUIDs.".to_string())
                            })
                        })
                })
                .collect::<AppResult<Vec<_>>>()?;
            healthkit::ack_healthkit_sync_entries_json(pool, user_id, entry_ids).await
        }
        "createGymSlot" => {
            let user_id = uuid_arg(&args, "userId")?;
            let input = object_arg(&args, "input")?;
            gym::create_gym_slot_json(pool, user_id, input).await
        }
        "updateGymSlot" => {
            let user_id = uuid_arg(&args, "userId")?;
            let slot_id = uuid_arg(&args, "slotId")?;
            let input = object_arg(&args, "input")?;
            gym::update_gym_slot_json(pool, user_id, slot_id, input).await
        }
        "deleteGymSlot" => {
            let user_id = uuid_arg(&args, "userId")?;
            let slot_id = uuid_arg(&args, "slotId")?;
            gym::delete_gym_slot_json(pool, user_id, slot_id).await
        }
        "setGymSlotStatus" => {
            let user_id = uuid_arg(&args, "userId")?;
            let slot_id = uuid_arg(&args, "slotId")?;
            let date = date_arg(&args, "date")?;
            let status = string_arg(&args, "status")?;
            gym::set_gym_slot_status_json(pool, user_id, slot_id, &date, &status).await
        }
        "inviteGymBuddy" => {
            let user_id = uuid_arg(&args, "userId")?;
            // `identifier` (email or friend code) with an `email` fallback so
            // a not-yet-redeployed web service keeps working during the skew
            // window between the two services' deploys.
            let identifier =
                string_arg(&args, "identifier").or_else(|_| string_arg(&args, "email"))?;
            gym::invite_gym_buddy_json(pool, user_id, &identifier).await
        }
        "respondGymBuddyInvite" => {
            let user_id = uuid_arg(&args, "userId")?;
            let buddy_id = uuid_arg(&args, "buddyId")?;
            let accept = args
                .get("accept")
                .and_then(Value::as_bool)
                .ok_or_else(|| AppError::BadRequest("accept is required.".to_string()))?;
            gym::respond_gym_buddy_invite_json(pool, user_id, buddy_id, accept).await
        }
        "removeGymBuddy" => {
            let user_id = uuid_arg(&args, "userId")?;
            let buddy_id = uuid_arg(&args, "buddyId")?;
            gym::remove_gym_buddy_json(pool, user_id, buddy_id).await
        }
        "getGymPageData" => {
            let user_id = uuid_arg(&args, "userId")?;
            let date = date_arg(&args, "date")?;
            gym::get_gym_page_data_json(pool, user_id, &date).await
        }
        "getGymHomeSummary" => {
            let user_id = uuid_arg(&args, "userId")?;
            let date = date_arg(&args, "date")?;
            gym::get_gym_home_summary_json(pool, user_id, &date).await
        }
        _ => Err(AppError::NotFound(format!(
            "Unknown backend operation: {op}"
        ))),
    }
}

enum JsonBind {
    Uuid(Uuid),
    I64(i64),
}

async fn query_json(pool: &PgPool, sql: &str, binds: &[JsonBind]) -> AppResult<Value> {
    let mut query = sqlx::query(sql);
    for bind in binds {
        match bind {
            JsonBind::Uuid(value) => {
                query = query.bind(*value);
            }
            JsonBind::I64(value) => {
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
            coalesce(sum(calories_kcal) FILTER (WHERE status = 'eaten'), 0)::bigint AS calories_kcal,
            coalesce(sum(protein_g) FILTER (WHERE status = 'planned'), 0)::float8 AS planned_protein_g,
            coalesce(sum(carbs_g) FILTER (WHERE status = 'planned'), 0)::float8 AS planned_carbs_g,
            coalesce(sum(fat_g) FILTER (WHERE status = 'planned'), 0)::float8 AS planned_fat_g,
            coalesce(sum(calories_kcal) FILTER (WHERE status = 'planned'), 0)::bigint AS planned_calories_kcal,
            coalesce(sum(protein_g) FILTER (WHERE status = 'skipped'), 0)::float8 AS skipped_protein_g,
            coalesce(sum(carbs_g) FILTER (WHERE status = 'skipped'), 0)::float8 AS skipped_carbs_g,
            coalesce(sum(fat_g) FILTER (WHERE status = 'skipped'), 0)::float8 AS skipped_fat_g,
            coalesce(sum(calories_kcal) FILTER (WHERE status = 'skipped'), 0)::bigint AS skipped_calories_kcal
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

/// PERF-03: collection reads had no ceiling at all. `getAdminUserDetail`
/// loaded a user's entire recipe/template/weight history and then kept ten of
/// each in Rust, and `ensure_date_string` permits years 0001-9999, so one
/// account can hold millions of weight rows. Limits now live in SQL: the
/// database sorts and stops, instead of shipping the whole history over the
/// wire so Rust can throw it away.
const MAX_COLLECTION_ROWS: i64 = 5_000;
const ADMIN_DETAIL_ROWS: i64 = 10;

async fn templates_json(pool: &PgPool, user_id: Uuid) -> AppResult<Value> {
    templates_json_filtered(pool, user_id, None, MAX_COLLECTION_ROWS).await
}

/// Shared shape for the template list and single-template reads. Passing a
/// `template_id` narrows both the outer select and the item aggregation to one
/// row, so by-id lookups stay indexed instead of building the whole collection.
async fn templates_json_filtered(
    pool: &PgPool,
    user_id: Uuid,
    template_id: Option<Uuid>,
    limit: i64,
) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        WITH visible_templates AS (
          SELECT id, user_id, type, label, notes, created_at, updated_at
          FROM meal_templates
          WHERE user_id = $1
            AND deleted_at IS NULL
            AND ($2::uuid IS NULL OR id = $2::uuid)
          -- Same ordering as the outer aggregate, so the limit keeps the rows a
          -- caller would have kept anyway.
          ORDER BY updated_at DESC, created_at DESC
          LIMIT $3
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
    .bind(limit)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn recipes_json(pool: &PgPool, user_id: Uuid) -> AppResult<Value> {
    recipes_json_filtered(pool, user_id, None, MAX_COLLECTION_ROWS).await
}

/// Shared shape for the recipe list and single-recipe reads. See
/// [`templates_json_filtered`] for why the id filter lives in SQL.
async fn recipes_json_filtered(
    pool: &PgPool,
    user_id: Uuid,
    recipe_id: Option<Uuid>,
    limit: i64,
) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        WITH visible_recipes AS (
          SELECT id, user_id, label, portions, total_cooked_weight_g, created_at, updated_at
          FROM recipes
          WHERE user_id = $1
            AND ($2::uuid IS NULL OR id = $2::uuid)
          ORDER BY updated_at DESC, created_at DESC
          LIMIT $3
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
            coalesce(sum(calories_kcal), 0)::bigint AS calories_kcal
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
    .bind(limit)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn search_food_products_json(pool: &PgPool, user_id: Uuid, query: &str) -> AppResult<Value> {
    let Some(patterns) = accepted_search_patterns(query)? else {
        return Ok(Value::Array(Vec::new()));
    };
    let sql = format!(
        r#"
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
          {fields}
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
        fields = sql::food_product_fields("")
    );
    let row = sqlx::query(&sql)
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

/// `None` means the query yielded no usable terms, which both searches answer
/// with an empty array instead of a round trip.
fn accepted_search_patterns(query: &str) -> AppResult<Option<Vec<String>>> {
    validate_search_query(query)?;
    let patterns = search_like_patterns(query);
    Ok((!patterns.is_empty()).then_some(patterns))
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
    let sql = format!(
        r#"
        SELECT jsonb_build_object(
          {fields}
        ) AS data
        FROM food_products
        WHERE id = $2
          AND deleted_at IS NULL
          AND (owner_user_id = $1 OR owner_user_id IS NULL)
        "#,
        fields = sql::food_product_fields("")
    );
    let row = sqlx::query(&sql)
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

impl NormalizedMealEntry {
    fn bind_columns<'q>(&'q self, query: PgQuery<'q>) -> PgQuery<'q> {
        query
            .bind(&self.date)
            .bind(self.meal_group_id)
            .bind(&self.status)
            .bind(self.product_id)
            .bind(&self.label)
            .bind(self.sort_order)
            .bind(self.quantity)
            .bind(&self.unit)
            .bind(self.serving_multiplier)
            .bind(self.macros.protein)
            .bind(self.macros.carbs)
            .bind(self.macros.fat)
            .bind(self.macros.calories)
            .bind(self.client_mutation_id.as_deref())
    }
}

/// PERF-02: everything `normalize_meal_input` would otherwise fetch once *per
/// entry*. `applyTemplateToDate` normalizes a whole template in a loop, so a
/// 30-item template cost ~95 round trips — one meal-group check and one product
/// fetch per item, both for ids it had already resolved and access-checked in
/// bulk moments earlier. A caller that has done that work up front passes it in
/// here; callers that have not use `Default` and behave exactly as before.
#[derive(Default)]
struct MealInputContext {
    /// Meal-group ids already proven to belong to `user_id`.
    trusted_meal_group_ids: HashSet<Uuid>,
    /// Products already loaded through the same visibility predicate that
    /// `food_product_json_by_id` applies.
    products: HashMap<Uuid, Value>,
}

async fn normalize_meal_input(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
    default_sort_order: i32,
    recalculate_product_macros: bool,
) -> AppResult<NormalizedMealEntry> {
    normalize_meal_input_with_context(
        pool,
        user_id,
        input,
        default_sort_order,
        recalculate_product_macros,
        &MealInputContext::default(),
    )
    .await
}

async fn normalize_meal_input_with_context(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
    default_sort_order: i32,
    recalculate_product_macros: bool,
    context: &MealInputContext,
) -> AppResult<NormalizedMealEntry> {
    let date = required_date(input, "date")?;
    let meal_group_id = optional_uuid(input, "mealGroupId")?;
    if !meal_group_id.is_some_and(|id| context.trusted_meal_group_ids.contains(&id)) {
        assert_meal_group_access(pool, user_id, meal_group_id).await?;
    }
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
        let product = match context.products.get(&product_id) {
            Some(product) => product.clone(),
            None => food_product_json_by_id(pool, user_id, product_id)
                .await?
                .ok_or_else(|| AppError::NotFound("Food product not found.".to_string()))?,
        };
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
    let inserted = entry
        .bind_columns(sqlx::query(sql::INSERT_MEAL_ENTRY).bind(id).bind(user_id))
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

    let update = sqlx::query(
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
    .bind(entry_id);
    entry
        .bind_columns(update)
        .execute(pool)
        .await
        // LOW-B1: a duplicate clientMutationId is a client-visible collision, not a fault.
        .map_err(map_unique_violation(
            "That clientMutationId is already used by another meal entry.",
        ))?;

    meal_entry_json(pool, user_id, entry_id).await
}

async fn meal_entry_json(pool: &PgPool, user_id: Uuid, entry_id: Uuid) -> AppResult<Value> {
    let sql = format!(
        r#"
        SELECT jsonb_build_object(
          {fields}
        ) AS data
        FROM meal_entries me
        LEFT JOIN food_products fp
          ON fp.id = me.product_id
          AND fp.deleted_at IS NULL
          AND (fp.owner_user_id = me.user_id OR fp.owner_user_id IS NULL)
        WHERE me.user_id = $1 AND me.id = $2
        "#,
        fields = sql::meal_entry_fields("me.")
    );
    let row = sqlx::query(&sql)
        .bind(user_id)
        .bind(entry_id)
        .fetch_optional(pool)
        .await?;
    Ok(row
        .ok_or_else(|| AppError::NotFound("Meal entry not found.".to_string()))?
        .try_get("data")?)
}

/// `WITH ORDINALITY` preserves the caller's id order across the batch read.
async fn meal_entries_json_by_ids(
    pool: &PgPool,
    user_id: Uuid,
    entry_ids: &[Uuid],
) -> AppResult<Value> {
    if entry_ids.is_empty() {
        return Ok(Value::Array(Vec::new()));
    }

    let sql = format!(
        r#"
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
          {fields}
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
        fields = sql::meal_entry_fields("me.")
    );
    let row = sqlx::query(&sql)
        .bind(user_id)
        .bind(entry_ids)
        .fetch_one(pool)
        .await?;

    Ok(row.try_get("data")?)
}

/// API-07: the OpenAPI spec documents `template.type` as `["meal", "day"]`, but
/// the handler only did `required_string` and the column is bare `text` with no
/// CHECK — so `{"type": "anything"}` was stored and returned, breaking every
/// consumer that switches on it.
fn normalize_template_type(input: &serde_json::Map<String, Value>) -> AppResult<String> {
    let template_type = required_string(input, "type")?;
    if !matches!(template_type.as_str(), "meal" | "day") {
        return Err(AppError::BadRequest(
            "Template type must be either \"meal\" or \"day\".".to_string(),
        ));
    }
    Ok(template_type)
}

fn template_items(input: &serde_json::Map<String, Value>) -> AppResult<&Vec<Value>> {
    let items = input
        .get("items")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
        .ok_or_else(|| {
            AppError::BadRequest("A template must include at least one item.".to_string())
        })?;
    ensure_collection_size(items, "items")?;
    Ok(items)
}

async fn create_template_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let template_id = Uuid::new_v4();
    let template_type = normalize_template_type(input)?;
    let label = required_string(input, "label")?;
    let notes = optional_free_text(input, "notes", "notes")?;
    let items = template_items(input)?;
    validate_item_product_access(pool, user_id, items).await?;
    let mut tx = pool.begin().await?;
    sqlx::query(
        "INSERT INTO meal_templates (id, user_id, type, label, notes, updated_at) VALUES ($1, $2, $3, $4, $5, now())",
    )
    .bind(template_id)
    .bind(user_id)
    .bind(template_type)
    .bind(label)
    .bind(notes.as_deref())
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
    let template_type = normalize_template_type(input)?;
    let label = required_string(input, "label")?;
    let notes = optional_free_text(input, "notes", "notes")?;
    let items = template_items(input)?;
    validate_item_product_access(pool, user_id, items).await?;
    let mut tx = pool.begin().await?;
    let updated = sqlx::query(
        "UPDATE meal_templates SET type = $3, label = $4, notes = $5, updated_at = now() WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL RETURNING id",
    )
    .bind(user_id)
    .bind(template_id)
    .bind(template_type)
    .bind(label)
    .bind(notes.as_deref())
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

    let query = sqlx::query(
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
    );
    let query = rows
        .bind_ids(query.bind(template_id))
        .bind(&rows.meal_group_labels);
    rows.bind_values(query).execute(&mut **tx).await?;

    Ok(())
}

/// Column-major staging buffer for a multi-row `unnest` insert.
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

    fn bind_ids<'q>(&'q self, query: PgQuery<'q>) -> PgQuery<'q> {
        query.bind(&self.ids).bind(&self.product_ids)
    }

    fn bind_values<'q>(&'q self, query: PgQuery<'q>) -> PgQuery<'q> {
        query
            .bind(&self.sort_orders)
            .bind(&self.labels)
            .bind(&self.quantities)
            .bind(&self.units)
            .bind(&self.serving_multipliers)
            .bind(&self.proteins)
            .bind(&self.carbs)
            .bind(&self.fats)
            .bind(&self.calories)
    }
}

/// PERF-02: prefetches a template's products under `food_product_json_by_id`'s visibility rule.
async fn food_products_json_by_ids(
    pool: &PgPool,
    user_id: Uuid,
    product_ids: &[Uuid],
) -> AppResult<HashMap<Uuid, Value>> {
    if product_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let sql = format!(
        r#"
        SELECT
          id,
          jsonb_build_object(
          {fields}
          ) AS data
        FROM food_products
        WHERE id = ANY($2::uuid[])
          AND deleted_at IS NULL
          AND (owner_user_id = $1 OR owner_user_id IS NULL)
        "#,
        fields = sql::food_product_fields("")
    );
    let rows = sqlx::query(&sql)
        .bind(user_id)
        .bind(product_ids)
        .fetch_all(pool)
        .await?;

    let mut products = HashMap::with_capacity(rows.len());
    for row in rows {
        products.insert(
            row.try_get::<Uuid, _>("id")?,
            row.try_get::<Value, _>("data")?,
        );
    }
    Ok(products)
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
    first_json_item(templates_json_filtered(pool, user_id, Some(template_id), 1).await?)
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

    /// Every id `resolve` can hand back. All of them came from a query filtered
    /// on `user_id`, so they need no further access check (PERF-02).
    fn resolvable_ids(&self) -> HashSet<Uuid> {
        self.exact
            .values()
            .chain(self.case_insensitive.values())
            .filter(|(_, count)| *count == 1)
            .map(|(id, _)| *id)
            .collect()
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

    // PERF-02: resolve the per-item lookups once instead of once per item.
    // `meal_groups` was loaded with `WHERE user_id = $1 AND deleted_at IS NULL`,
    // so every id it can return is already proven to belong to this user — the
    // per-item `assert_meal_group_access` was a provably redundant round trip.
    // The products were already access-checked in bulk by
    // `validate_item_product_access` just above, so one batched read replaces
    // the per-item fetch.
    let mut product_ids = Vec::new();
    for item in items {
        let item = item
            .as_object()
            .ok_or_else(|| AppError::BadRequest("Template item must be an object.".to_string()))?;
        if let Some(product_id) = optional_uuid(item, "productId")? {
            product_ids.push(product_id);
        }
    }
    let context = MealInputContext {
        trusted_meal_group_ids: meal_groups.resolvable_ids(),
        products: food_products_json_by_ids(pool, user_id, &product_ids).await?,
    };

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
            normalize_meal_input_with_context(
                pool,
                user_id,
                &meal,
                next_sort_order + index as i32,
                true,
                &context,
            )
            .await?,
        );
    }

    let mut tx = pool.begin().await?;
    let mut created_ids = Vec::new();
    for (index, entry) in normalized.into_iter().enumerate() {
        maybe_trigger_test_fault(test_fault, index + 1)?;
        let id = Uuid::new_v4();
        let inserted = entry
            .bind_columns(sqlx::query(sql::INSERT_MEAL_ENTRY).bind(id).bind(user_id))
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
    let insert = format!(
        r#"{columns}
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, now()
        )
        "#,
        columns = sql::INSERT_FOOD_PRODUCT_COLUMNS
    );
    let query = sqlx::query(&insert)
        .bind(product_id)
        .bind(if personal { Some(user_id) } else { None })
        .bind(&normalized.scope);
    normalized
        .bind_provenance(normalized.bind_columns(query), user_id)
        .execute(pool)
        .await
        .map_err(map_active_barcode_conflict)?;
    let product = food_product_json_by_id(pool, user_id, product_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Food product not found.".to_string()))?;
    Ok(product)
}

/// DATA-07: `active_global_barcode_exists` is a check-then-insert. Under READ
/// COMMITTED two concurrent submissions both see no row, and
/// `food_products_active_global_barcode_key` rejects the loser with `23505` —
/// which reached the caller as a 500 rather than the 400 the pre-check already
/// produces for the sequential case. Same message either way, so the two
/// outcomes are indistinguishable to the client.
fn map_active_barcode_conflict(error: sqlx::Error) -> AppError {
    if let sqlx::Error::Database(db_error) = &error
        && db_error.code().as_deref() == Some("23505")
        && db_error.constraint() == Some("food_products_active_global_barcode_key")
    {
        return AppError::BadRequest("That barcode already exists.".to_string());
    }
    AppError::Sqlx(error)
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
    let sql = format!(
        r#"
        SELECT jsonb_build_object(
          {fields}
        ) AS data
        FROM food_products
        WHERE owner_user_id IS NULL
          AND source = 'barcode'
          AND deleted_at IS NULL
          AND barcode = $1
        ORDER BY updated_at DESC
        LIMIT 1
        "#,
        fields = sql::food_product_fields("")
    );
    let row = sqlx::query(&sql)
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

    let insert = format!(
        r#"{columns}
        VALUES (
          $1, NULL, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now()
        )
        "#,
        columns = sql::INSERT_FOOD_PRODUCT_COLUMNS
    );
    let query = sqlx::query(&insert)
        .bind(product_id)
        .bind(&normalized.scope);
    normalized
        .bind_provenance(normalized.bind_columns(query), user_id)
        .execute(&mut *executor)
        .await
        .map_err(map_active_barcode_conflict)?;

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
        // DATA-05: this used to be a hand-rolled copy that escaped `%` and `_`
        // but not the backslash, while the SQL still declares `ESCAPE '\'` — so
        // searching for `100\%` produced a trailing wildcard and wrong results.
        .map(|value| format!("%{}%", escape_like_pattern(value)));
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
            recipes_json_filtered(pool, user_id, None, ADMIN_DETAIL_ROWS),
            templates_json_filtered(pool, user_id, None, ADMIN_DETAIL_ROWS),
            weight::weight_entries_json_limited(pool, user_id, ADMIN_DETAIL_ROWS),
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
        // PERF-03: the limit is applied in SQL now; `rev()` still stands
        // because `recentWeights` is contracted as newest-first while the
        // series itself is stored ascending.
        "recentWeights": recent_weights.as_array().cloned().unwrap_or_default().into_iter().rev().collect::<Vec<_>>(),
        "recentRecipes": recent_recipes,
        "recentTemplates": recent_templates,
        "recentBarcodeSubmissions": recent_barcodes
    }))
}

async fn recent_barcode_submissions_json(
    pool: &PgPool,
    user_id: Uuid,
    limit: i32,
) -> AppResult<Value> {
    let sql = format!(
        r#"
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
          {fields}
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
        fields = sql::food_product_fields("")
    );
    let row = sqlx::query(&sql)
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
    // Second offset computation (DATA-06); shares the clamp with `pagination`.
    let offset = page_offset(page, page_size);
    let sql = format!(
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
          {fields},
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
        fields = sql::food_product_fields("fp.")
    );
    let rows = sqlx::query(&sql)
        .bind(page_size)
        .bind(offset)
        .bind(review_queue)
        .bind(filters.q_pattern.as_deref())
        .bind(filters.status.as_str())
        .bind(filters.submitter_pattern.as_deref())
        .fetch_all(pool)
        .await?;
    // PERF-04: only the review queue needs the rollups; the count is the same either way.
    let total_row = if review_queue {
        sqlx::query(
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
        .await?
    } else {
        sqlx::query(
            r#"
            SELECT count(*)::int AS total
            FROM food_products fp
            LEFT JOIN users submitter ON submitter.id = fp.submitted_by_user_id
            WHERE fp.owner_user_id IS NULL
              AND fp.source = 'barcode'
              AND (
                $1::text IS NULL
                OR fp.barcode ILIKE $1 ESCAPE '\'
                OR fp.name ILIKE $1 ESCAPE '\'
                OR fp.brand ILIKE $1 ESCAPE '\'
              )
              AND (
                $2 = 'all'
                OR ($2 = 'active' AND fp.deleted_at IS NULL)
                OR ($2 = 'deleted' AND fp.deleted_at IS NOT NULL)
              )
              AND ($3::text IS NULL OR submitter.email ILIKE $3 ESCAPE '\')
            "#,
        )
        .bind(filters.q_pattern.as_deref())
        .bind(filters.status.as_str())
        .bind(filters.submitter_pattern.as_deref())
        .fetch_one(pool)
        .await?
    };
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
    let sql = format!(
        r#"
        SELECT jsonb_build_object(
          {fields}
        ) AS data
        FROM food_products
        WHERE id = $1 AND owner_user_id IS NULL AND source = 'barcode'
        "#,
        fields = sql::food_product_fields("")
    );
    let row = sqlx::query(&sql)
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
    .await
    .map_err(map_active_barcode_conflict)?
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
    let sql = format!(
        r#"
        SELECT jsonb_build_object(
          {fields}
        ) AS data
        FROM admin_audit_events ae
        LEFT JOIN users u ON u.id = ae.actor_user_id
        WHERE ($3::text IS NULL OR ae.target_type = $3)
          AND ($4::text IS NULL OR ae.target_id = $4)
        ORDER BY ae.created_at DESC
        LIMIT $1 OFFSET $2
        "#,
        fields = sql::admin_audit_event_fields()
    );
    let rows = sqlx::query(&sql)
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
    let sql = format!(
        r#"
        SELECT jsonb_build_object(
          {fields}
        ) AS data
        FROM admin_audit_events ae
        LEFT JOIN users u ON u.id = ae.actor_user_id
        WHERE ae.id = $1
        "#,
        fields = sql::admin_audit_event_fields()
    );
    let row = sqlx::query(&sql)
        .bind(event_id)
        .fetch_optional(pool)
        .await?;
    Ok(row
        .map(|row| row.try_get("data"))
        .transpose()?
        .unwrap_or(Value::Null))
}

async fn update_food_product_json(
    pool: &PgPool,
    user_id: Uuid,
    product_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let mut normalized = normalize_food_product_input(input, "personal")?;
    normalized.scope = "personal".to_string();
    let update = sqlx::query(
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
    .bind(product_id);
    let updated = normalized
        .bind_columns(update)
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
    ensure_collection_size(ingredients, "ingredients")?;

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
        // Per item so an injected fault aborts at the same ingredient it would in production.
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

    let query = sqlx::query(
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
    );
    let query = rows.bind_ids(query.bind(recipe_id));
    rows.bind_values(query).execute(&mut **tx).await?;

    Ok(())
}

async fn recipe_by_id_json(pool: &PgPool, user_id: Uuid, recipe_id: Uuid) -> AppResult<Value> {
    first_json_item(recipes_json_filtered(pool, user_id, Some(recipe_id), 1).await?)
        .ok_or_else(|| AppError::NotFound("Recipe not found.".to_string()))
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
    let Some(patterns) = accepted_search_patterns(query)? else {
        return Ok(Value::Array(Vec::new()));
    };
    let sql = format!(
        r#"
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
          {fields}
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
        fields = sql::meal_entry_fields("matches.")
    );
    let row = sqlx::query(&sql)
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
    let sql = format!(
        r#"
        -- DATA-08: this was the one meal-JSON shape that did not mask
        -- soft-deleted products. It handed clients a `productId` that 404s on
        -- lookup and always reported a null `sourceLabel`; the other four
        -- blocks join exactly like this.
        SELECT coalesce(jsonb_agg(
          jsonb_build_object(
          {fields}
          )
          ORDER BY recent.entry_date DESC, recent.sort_order ASC, recent.created_at DESC, recent.id
        ), '[]'::jsonb) AS data
        FROM (
          SELECT *
          FROM meal_entries
          WHERE user_id = $1 AND (NOT $3::bool OR status = 'eaten')
          ORDER BY entry_date DESC, sort_order ASC, created_at DESC, id
          LIMIT $2
        ) recent
        LEFT JOIN food_products fp
          ON fp.id = recent.product_id
          AND fp.deleted_at IS NULL
          AND (fp.owner_user_id = recent.user_id OR fp.owner_user_id IS NULL)
        "#,
        fields = sql::meal_entry_fields("recent.")
    );
    let row = sqlx::query(&sql)
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
            sum(calories_kcal)::bigint AS calories_kcal,
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
              'caloriesKcal', CASE WHEN logged_days = 0 THEN 0 ELSE round(calories_kcal / logged_days)::bigint END
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
    let row = sqlx::query(concat!(
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
            coalesce(sum(calories_kcal) FILTER (WHERE status = 'eaten'), 0)::bigint AS calories_kcal,
            coalesce(sum(protein_g) FILTER (WHERE status = 'planned' AND entry_date <= $2::date), 0)::float8 AS planned_protein_g,
            coalesce(sum(carbs_g) FILTER (WHERE status = 'planned' AND entry_date <= $2::date), 0)::float8 AS planned_carbs_g,
            coalesce(sum(fat_g) FILTER (WHERE status = 'planned' AND entry_date <= $2::date), 0)::float8 AS planned_fat_g,
            coalesce(sum(calories_kcal) FILTER (WHERE status = 'planned' AND entry_date <= $2::date), 0)::bigint AS planned_calories_kcal
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
            coalesce(sum(calories_kcal), 0)::bigint AS total_calories_kcal
          FROM eaten_days
        ),
        rolling_7 AS (
          SELECT
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(protein_g) / count(*))::numeric, 1)::float8 END AS protein_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(carbs_g) / count(*))::numeric, 1)::float8 END AS carbs_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(fat_g) / count(*))::numeric, 1)::float8 END AS fat_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round(sum(calories_kcal)::numeric / count(*))::bigint END AS calories_kcal
          FROM eaten_days
          WHERE entry_date >= $2::date - interval '6 days' AND entry_date <= $2::date
        ),
        rolling_30 AS (
          SELECT
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(protein_g) / count(*))::numeric, 1)::float8 END AS protein_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(carbs_g) / count(*))::numeric, 1)::float8 END AS carbs_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round((sum(fat_g) / count(*))::numeric, 1)::float8 END AS fat_g,
            CASE WHEN count(*) = 0 THEN 0 ELSE round(sum(calories_kcal)::numeric / count(*))::bigint END AS calories_kcal
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
              ELSE round(avg(abs(eaten_days.calories_kcal - user_goals.goal_calories_kcal)))::bigint
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
              ELSE round((totals.total_calories_kcal::float8 / totals.total_days_tracked) - user_goals.goal_calories_kcal)::bigint
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
            -- PERF-03: `ensure_date_string` accepts years 0001-9999, so this
            -- window function could run over millions of rows for one account
            -- and emit a JSON object for every one of them. The chart only ever
            -- draws a bounded series.
            FROM (
              SELECT entry_date, weight_kg
              FROM weight_entries
              WHERE user_id = $1
              ORDER BY entry_date DESC
              LIMIT 1000
            ) bounded_weights
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
          -- PERF-03: one JSON object per day ever logged, unbounded. The
          -- aggregates above still run over the full history; only this
          -- per-day payload is capped.
          FROM (
            SELECT * FROM daily ORDER BY entry_date DESC LIMIT 1000
          ) bounded_daily
        ),
        -- Same date set the leaderboard streaks over: one row per date with an
        -- eaten entry. `daily` above also carries planned-only dates, which must
        -- not count towards a streak.
        streak_days AS (
          SELECT DISTINCT entry_date
          FROM meal_entries
          WHERE user_id = $1 AND status = 'eaten'
        ),
        "#,
        streak_summary_ctes!(),
        r#"
        SELECT jsonb_build_object(
          'allDailyTotals', daily_totals.all_daily_totals,
          'totalDaysTracked', totals.total_days_tracked,
          'currentStreak', streak_summary.current_streak,
          'longestStreak', streak_summary.longest_streak,
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
        CROSS JOIN streak_summary
        LEFT JOIN best_calorie_day ON true
        LEFT JOIN latest_weight ON true
        "#,
    ))
    .bind(user_id)
    .bind(today)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

async fn leaderboard_json(pool: &PgPool, user_id: Uuid, reference_date: &str) -> AppResult<Value> {
    let today = NaiveDate::parse_from_str(reference_date, "%Y-%m-%d")
        .map_err(|_| AppError::BadRequest("referenceDate must be YYYY-MM-DD.".to_string()))?;
    let row = sqlx::query(concat!(
        r#"
        WITH daily AS (
          SELECT
            entry_date,
            round(sum(calories_kcal)::numeric)::bigint AS calories_kcal,
            round(sum(protein_g)::numeric, 1)::float8 AS protein_g,
            round(sum(carbs_g)::numeric, 1)::float8 AS carbs_g,
            count(*)::int AS entry_count
          FROM meal_entries
          WHERE user_id = $1 AND status = 'eaten'
          GROUP BY entry_date
        ),
        streak_days AS (
          SELECT entry_date FROM daily
        ),
        "#,
        streak_summary_ctes!(),
        r#"
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
    ))
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

/// DATA-06: `page` comes straight from the request. Unclamped,
/// `(page - 1) * page_size` overflowed `i64` — a panic in debug, and in release
/// a negative value that Postgres rejects with `OFFSET must not be negative`,
/// i.e. a 500. A page this deep is meaningless for every paginated view here.
const MAX_PAGE: i64 = 100_000;

fn page_offset(page: i64, page_size: i64) -> i64 {
    page.clamp(1, MAX_PAGE)
        .saturating_sub(1)
        .saturating_mul(page_size)
}

fn pagination(input: &serde_json::Map<String, Value>) -> (i64, i64, i64) {
    let page = input
        .get("page")
        .and_then(Value::as_i64)
        .unwrap_or(1)
        .clamp(1, MAX_PAGE);
    let page_size = input
        .get("pageSize")
        .and_then(Value::as_i64)
        .unwrap_or(25)
        .clamp(1, 100);
    (page, page_size, page_offset(page, page_size))
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

/// API-10: nothing capped the length of any string reaching a `text` column, so
/// a `write:daily` token could store a ~2 MB `label` on every meal entry and a
/// ~2 MB `notes` on every template — bounded only by the HTTP body limit.
/// Names, labels and codes are never prose, so they get the tighter cap;
/// free-text fields get the looser one.
const MAX_TEXT_FIELD_LENGTH: usize = 500;
const MAX_FREE_TEXT_LENGTH: usize = 2_000;
/// `items` / `ingredients` were only checked for non-emptiness, so one request
/// could ask for thousands of rows.
const MAX_COLLECTION_ITEMS: usize = 200;

/// Counted in `char`s rather than bytes: the columns are `text`, so the limit
/// users care about is characters, and a byte limit would silently reject
/// shorter non-ASCII input.
fn ensure_text_length(value: &str, max: usize, field_name: &str) -> AppResult<()> {
    if value.chars().count() > max {
        return Err(AppError::BadRequest(format!(
            "{field_name} must be at most {max} characters."
        )));
    }
    Ok(())
}

fn ensure_collection_size(items: &[Value], field_name: &str) -> AppResult<()> {
    if items.len() > MAX_COLLECTION_ITEMS {
        return Err(AppError::BadRequest(format!(
            "{field_name} must contain at most {MAX_COLLECTION_ITEMS} entries."
        )));
    }
    Ok(())
}

/// Free-text fields (`notes`) accept more than a label but are still bounded.
fn optional_free_text(
    input: &serde_json::Map<String, Value>,
    key: &str,
    field_name: &str,
) -> AppResult<Option<String>> {
    let Some(value) = input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    ensure_text_length(value, MAX_FREE_TEXT_LENGTH, field_name)?;
    Ok(Some(value.to_string()))
}

fn trim_optional_string(input: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        // Truncation rather than rejection: several callers use this for
        // optional filter/search arguments where a hard error would be worse
        // than a clamp, and the persisted callers (`brand`, `barcode`,
        // `sourceProvider`) are all short by nature.
        .map(|value| value.chars().take(MAX_TEXT_FIELD_LENGTH).collect())
}

fn required_string_with_message(
    input: &serde_json::Map<String, Value>,
    key: &str,
    message: &str,
) -> AppResult<String> {
    let value = input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest(message.to_string()))?;
    ensure_text_length(value, MAX_TEXT_FIELD_LENGTH, key)?;
    Ok(value.to_string())
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
        // DATA-03: calories used to be the one unbounded macro, which let a
        // day's `sum(calories_kcal)` overflow the aggregate cast and 500 every
        // summary/stats/leaderboard read for that account.
        calories: required_i32_bounded(input, calories_key, MAX_CALORIES_KCAL)?,
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

/// The single enforcement point for every value that reaches a `meal_entries` /
/// `meal_template_items` / `recipe_ingredients` numeric column.
///
/// DATA-01: the manual path bounded its inputs on the way in
/// (`normalize_positive_number`, `required_f64_bounded`), but the product-linked
/// path built its values from the product row and the raw request and only
/// checked finite/positive here — so `quantity: 1e12` reached the INSERT and
/// came back as a Postgres `22003`, i.e. a 500 for what is a client error. The
/// bounds live here rather than being copied into the product path so the two
/// cannot drift apart again.
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
    if quantity > MAX_QUANTITY {
        return Err(AppError::BadRequest(format!(
            "Quantity must be at most {MAX_QUANTITY}."
        )));
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
    if serving_multiplier > MAX_QUANTITY {
        return Err(AppError::BadRequest(format!(
            "Serving multiplier must be at most {MAX_QUANTITY}."
        )));
    }
    for (field_name, value) in [
        ("Protein", macros.protein),
        ("Carbs", macros.carbs),
        ("Fat", macros.fat),
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(AppError::BadRequest(format!(
                "{field_name} must be a non-negative number."
            )));
        }
        if value > MAX_MACRO_GRAMS {
            return Err(AppError::BadRequest(format!(
                "{field_name} must be at most {MAX_MACRO_GRAMS}."
            )));
        }
    }
    if macros.calories < 0 {
        return Err(AppError::BadRequest(
            "Calories must be a non-negative integer.".to_string(),
        ));
    }
    if macros.calories > MAX_CALORIES_KCAL {
        return Err(AppError::BadRequest(format!(
            "Calories must be at most {MAX_CALORIES_KCAL}."
        )));
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

/// DATA-09: `sourceMetadata` was taken verbatim from the request and stored as
/// `jsonb` with no shape or size validation — the barcode path builds it
/// server-side, but `createPersonalFoodProduct` let a caller persist an
/// arbitrarily large and deeply nested document per product, bounded only by the
/// HTTP body limit. Only a flat object of scalars is accepted, which is all any
/// producer in this codebase writes.
const MAX_SOURCE_METADATA_KEYS: usize = 32;

fn normalize_source_metadata(input: &serde_json::Map<String, Value>) -> AppResult<Value> {
    let Some(value) = input.get("sourceMetadata") else {
        return Ok(json!({}));
    };
    if value.is_null() {
        return Ok(json!({}));
    }
    let Some(object) = value.as_object() else {
        return Err(AppError::BadRequest(
            "sourceMetadata must be an object.".to_string(),
        ));
    };
    if object.len() > MAX_SOURCE_METADATA_KEYS {
        return Err(AppError::BadRequest(format!(
            "sourceMetadata must have at most {MAX_SOURCE_METADATA_KEYS} keys."
        )));
    }
    for (key, entry) in object {
        ensure_text_length(key, MAX_TEXT_FIELD_LENGTH, "sourceMetadata keys")?;
        match entry {
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
            Value::String(text) => {
                ensure_text_length(text, MAX_TEXT_FIELD_LENGTH, "sourceMetadata values")?;
            }
            Value::Array(_) | Value::Object(_) => {
                return Err(AppError::BadRequest(
                    "sourceMetadata values must be strings, numbers, booleans or null.".to_string(),
                ));
            }
        }
    }
    Ok(value.clone())
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
        source_metadata: normalize_source_metadata(input)?,
        corrected_from_product_id: optional_uuid(input, "correctedFromProductId")?,
    })
}

fn required_string(input: &serde_json::Map<String, Value>, key: &str) -> AppResult<String> {
    let value = input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::BadRequest(format!("{key} is required.")))?;
    ensure_text_length(value, MAX_TEXT_FIELD_LENGTH, key)?;
    Ok(value.to_string())
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
/// Calories land in an `integer` column, so a single row cannot overflow — but
/// `sum(calories_kcal)` across a day could, and the shared barcode catalogue
/// publishes `calories_per_100` to every account. Capping a single value at the
/// same order of magnitude as [`MAX_MACRO_GRAMS`] keeps both honest; no real
/// food comes close.
pub(crate) const MAX_CALORIES_KCAL: i32 = 99_999;

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

fn required_i32_bounded(
    input: &serde_json::Map<String, Value>,
    key: &str,
    max: i32,
) -> AppResult<i32> {
    let value = required_i32(input, key)?;
    if value > max {
        return Err(AppError::BadRequest(format!(
            "{key} must be at most {max}."
        )));
    }
    Ok(value)
}

fn required_f64_lossy(input: &serde_json::Map<String, Value>, key: &str) -> f64 {
    optional_f64(input, key).unwrap_or(0.0)
}

fn required_i32_lossy(input: &serde_json::Map<String, Value>, key: &str) -> i32 {
    optional_i32(input, key).unwrap_or(0)
}

#[cfg(test)]
mod tests;
