//! HealthKit sync queue: pending eaten-entry projection and acknowledgement.

use crate::errors::AppResult;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// Pending eaten entries not yet acked, oldest first; an acked entry never re-enters (avoids double-counting samples).
/// Day window and row limit bound a first-ever sync; backfills clamp to 18:00 UTC (right day west of UTC+6).
pub(super) async fn healthkit_sync_entries_json(
    pool: &PgPool,
    user_id: Uuid,
    days: i32,
    limit: i32,
) -> AppResult<Value> {
    let row = sqlx::query(
        r#"
        WITH pending AS (
          SELECT
            id,
            entry_date,
            label,
            protein_g,
            carbs_g,
            fat_g,
            calories_kcal,
            created_at,
            -- Clamp the sample timestamp into the entry's day; HealthKit rejects future-dated samples.
            GREATEST(
              LEAST(
                updated_at,
                (entry_date::timestamp + interval '18 hours') AT TIME ZONE 'UTC'
              ),
              entry_date::timestamp AT TIME ZONE 'UTC'
            ) AS sample_time,
            count(*) OVER () AS pending_total
          FROM meal_entries
          WHERE user_id = $1
            AND status = 'eaten'
            AND healthkit_synced_at IS NULL
            AND entry_date <= (now() AT TIME ZONE 'UTC')::date
            AND entry_date >= (now() AT TIME ZONE 'UTC')::date - $2
          ORDER BY entry_date, created_at, id
          LIMIT $3
        )
        SELECT jsonb_build_object(
          'entries', coalesce(jsonb_agg(
            jsonb_build_object(
              'id', id,
              'date', entry_date,
              'label', label,
              'proteinG', round(protein_g::numeric, 1)::float8,
              'carbsG', round(carbs_g::numeric, 1)::float8,
              'fatG', round(fat_g::numeric, 1)::float8,
              'caloriesKcal', calories_kcal,
              'sampleTime', to_char(sample_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            )
            ORDER BY entry_date, created_at, id
          ), '[]'::jsonb),
          'pendingTotal', coalesce(max(pending_total), 0)
        ) AS data
        FROM pending
        "#,
    )
    .bind(user_id)
    .bind(days)
    .bind(limit)
    .fetch_one(pool)
    .await?;
    Ok(row.try_get("data")?)
}

pub(super) async fn ack_healthkit_sync_entries_json(
    pool: &PgPool,
    user_id: Uuid,
    entry_ids: Vec<Uuid>,
) -> AppResult<Value> {
    if entry_ids.is_empty() {
        return Ok(json!({ "acked": 0 }));
    }
    let result = sqlx::query(
        r#"
        UPDATE meal_entries
        SET healthkit_synced_at = now()
        WHERE user_id = $1 AND id = ANY($2) AND healthkit_synced_at IS NULL
        "#,
    )
    .bind(user_id)
    .bind(&entry_ids)
    .execute(pool)
    .await?;
    Ok(json!({ "acked": result.rows_affected() }))
}
