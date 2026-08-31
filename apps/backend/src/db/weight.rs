//! Weight-entry persistence and progress statistics.
//!
//! Extracted verbatim from `db.rs` (godfiles audit, step 3). The RPC
//! dispatch arms stay in `db.rs`; onboarding and admin queries call
//! `normalize_weight_entry_input` and `weight_entries_json_limited` here.

use super::{MAX_COLLECTION_ROWS, optional_f64, required_date, trim_optional_string};
use crate::errors::{AppError, AppResult};
use crate::shared::{round1, round2};
use chrono::{Duration, NaiveDate};
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub(super) struct WeightEntryValues {
    pub(super) date: String,
    pub(super) weight_kg: f64,
    pub(super) body_fat_pct: Option<f64>,
    pub(super) notes: Option<String>,
}

pub(super) async fn weight_entries_json(pool: &PgPool, user_id: Uuid) -> AppResult<Value> {
    weight_entries_json_limited(pool, user_id, MAX_COLLECTION_ROWS).await
}

/// PERF-03: the row set is selected most-recent-first so a limit keeps the
/// newest entries, then re-sorted ascending because every consumer charts the
/// series forwards in time.
pub(super) async fn weight_entries_json_limited(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
) -> AppResult<Value> {
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
        FROM (
          SELECT id, user_id, entry_date, weight_kg, body_fat_pct, notes
          FROM weight_entries
          WHERE user_id = $1
          ORDER BY entry_date DESC
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

pub(super) async fn weight_page_data_json(
    pool: &PgPool,
    user_id: Uuid,
    today: &str,
) -> AppResult<Value> {
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

pub(super) async fn create_weight_entry_json(
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

pub(super) async fn update_weight_entry_json(
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

pub(super) async fn weight_entry_by_id_json(
    pool: &PgPool,
    user_id: Uuid,
    entry_id: Uuid,
) -> AppResult<Value> {
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

pub(super) async fn delete_weight_entry_json(
    pool: &PgPool,
    user_id: Uuid,
    entry_id: Uuid,
) -> AppResult<Value> {
    let deleted =
        sqlx::query("DELETE FROM weight_entries WHERE user_id = $1 AND id = $2 RETURNING id")
            .bind(user_id)
            .bind(entry_id)
            .fetch_optional(pool)
            .await?
            .is_some();
    Ok(json!(deleted))
}

pub(super) fn normalize_weight_entry_input(
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
