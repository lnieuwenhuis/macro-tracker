//! API-01: public-only continuation support for the capped collections.
//!
//! The public API capped templates, recipes and weight entries at
//! `MAX_COLLECTION_ROWS`, and `/stats` capped its two chart series at 1000
//! rows, all without any way to tell a partial list from a complete one.
//!
//! These entry points are additive. A request without `limit`/`cursor` returns
//! exactly the rows the legacy queries returned (same cap, same ordering, plus
//! `id DESC` as a final tie-break), and reports whether the cap bit. A request
//! with `limit` and/or `cursor` walks the same keyset stably so every row is
//! returned exactly once. Internal session RPCs keep using the legacy array
//! builders in `db.rs` and `db::weight`; nothing in this module is reachable
//! through the internal RPC surface.

use super::{MAX_COLLECTION_ROWS, StatsPageData};
use crate::errors::{AppError, AppResult};
use base64ct::{Base64UrlUnpadded, Encoding};
use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use serde_json::{Map, Value, json};
use sqlx::{PgPool, Row, postgres::PgRow};
use uuid::Uuid;

/// Opt-in page size bounds. The legacy (no-parameter) reads keep the larger
/// `MAX_COLLECTION_ROWS` cap; `limit` is only accepted for the opt-in envelope.
pub(crate) const MIN_PAGE_LIMIT: i64 = 1;
pub(crate) const MAX_PAGE_LIMIT: i64 = 1_000;
pub(crate) const DEFAULT_PAGE_LIMIT: i64 = 1_000;
/// The cap the legacy response still applies when the client sends no page parameters.
pub(crate) const LEGACY_COLLECTION_LIMIT: i64 = MAX_COLLECTION_ROWS;
/// Both `/stats` chart series are built from the newest 1000 rows.
pub(crate) const STATS_SERIES_LIMIT: i64 = 1_000;

/// A decoded, per-resource keyset. Cursors carry the values of the row they
/// continue after, so a page is `(order tuple) < (cursor tuple)`.
struct KeysetCursor {
    updated_at: String,
    created_at: String,
    id: Uuid,
}

struct DateCursor {
    date: String,
    id: Uuid,
}

/// One capped collection read plus its truthful truncation metadata.
pub(crate) struct CollectionPage {
    /// The JSON array in the legacy order; identical to the legacy response when no page was requested.
    pub(crate) items: Value,
    /// `Some` only when more rows exist beyond this page.
    pub(crate) next_cursor: Option<String>,
    /// The cap that produced this page (legacy cap or the requested `limit`).
    pub(crate) limit: i64,
    pub(crate) returned: i64,
    pub(crate) truncated: bool,
}

pub(crate) struct SeriesWindow {
    pub(crate) limit: i64,
    pub(crate) count: i64,
    pub(crate) truncated: bool,
}

/// `/stats` picks the newest 1000 rows of each chart series and keeps
/// full-history aggregates; the windows make that bound explicit.
pub(crate) struct StatsPage {
    pub(crate) data: Value,
    pub(crate) daily_totals: SeriesWindow,
    pub(crate) smoothed_weight_trend: SeriesWindow,
}

const CURSOR_VERSION: i64 = 1;
const MAX_CURSOR_BYTES: usize = 512;

pub(crate) async fn templates_page_json(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
    cursor: Option<&str>,
) -> AppResult<CollectionPage> {
    let keyset = decode_keyset_cursor(cursor, user_id)?;
    let fetch_limit = page_fetch_limit(limit)?;
    let rows = sqlx::query(
        r#"
        WITH visible_templates AS (
          SELECT id, user_id, type, label, notes, created_at, updated_at
          FROM meal_templates
          WHERE user_id = $1
            AND deleted_at IS NULL
            AND (
              $2::timestamptz IS NULL
              OR (updated_at, created_at, id) < ($2::timestamptz, $3::timestamptz, $4::uuid)
            )
          ORDER BY updated_at DESC, created_at DESC, id DESC
          LIMIT $5
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
        SELECT
          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
          id,
          jsonb_build_object(
            'id', mt.id,
            'userId', mt.user_id,
            'type', mt.type,
            'label', mt.label,
            'notes', mt.notes,
            'items', coalesce(item_data.items, '[]'::jsonb),
            'createdAt', mt.created_at,
            'updatedAt', mt.updated_at
          ) AS item
        FROM visible_templates mt
        LEFT JOIN item_data ON item_data.template_id = mt.id
        ORDER BY mt.updated_at DESC, mt.created_at DESC, mt.id DESC
        "#,
    )
    .bind(user_id)
    .bind(keyset.as_ref().map(|cursor| cursor.updated_at.as_str()))
    .bind(keyset.as_ref().map(|cursor| cursor.created_at.as_str()))
    .bind(keyset.as_ref().map(|cursor| cursor.id))
    .bind(fetch_limit)
    .fetch_all(pool)
    .await?;

    let next_cursor = keyset_next_cursor(&rows, limit, |row| {
        Ok(encode_cursor(&json!({
            "v": CURSOR_VERSION,
            "u": user_id.to_string(),
            "t": row.try_get::<String, _>("updated_at")?,
            "c": row.try_get::<String, _>("created_at")?,
            "i": row.try_get::<Uuid, _>("id")?.to_string(),
        }))?)
    })?;
    collection_page(rows, limit, next_cursor)
}

pub(crate) async fn recipes_page_json(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
    cursor: Option<&str>,
) -> AppResult<CollectionPage> {
    let keyset = decode_keyset_cursor(cursor, user_id)?;
    let fetch_limit = page_fetch_limit(limit)?;
    let rows = sqlx::query(
        r#"
        WITH visible_recipes AS (
          SELECT id, user_id, label, portions, total_cooked_weight_g, created_at, updated_at
          FROM recipes
          WHERE user_id = $1
            AND (
              $2::timestamptz IS NULL
              OR (updated_at, created_at, id) < ($2::timestamptz, $3::timestamptz, $4::uuid)
            )
          ORDER BY updated_at DESC, created_at DESC, id DESC
          LIMIT $5
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
        SELECT
          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
          id,
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
          ) AS item
        FROM visible_recipes r
        LEFT JOIN ingredient_data ON ingredient_data.recipe_id = r.id
        ORDER BY r.updated_at DESC, r.created_at DESC, r.id DESC
        "#,
    )
    .bind(user_id)
    .bind(keyset.as_ref().map(|cursor| cursor.updated_at.as_str()))
    .bind(keyset.as_ref().map(|cursor| cursor.created_at.as_str()))
    .bind(keyset.as_ref().map(|cursor| cursor.id))
    .bind(fetch_limit)
    .fetch_all(pool)
    .await?;

    let next_cursor = keyset_next_cursor(&rows, limit, |row| {
        Ok(encode_cursor(&json!({
            "v": CURSOR_VERSION,
            "u": user_id.to_string(),
            "t": row.try_get::<String, _>("updated_at")?,
            "c": row.try_get::<String, _>("created_at")?,
            "i": row.try_get::<Uuid, _>("id")?.to_string(),
        }))?)
    })?;
    collection_page(rows, limit, next_cursor)
}

/// Weight entries continue older-first: the keyset matching the legacy query is
/// `(entry_date DESC, id DESC)`, and each page is re-sorted ascending so the
/// body stays byte-compatible with the chart order the endpoint always used.
pub(crate) async fn weight_entries_page_json(
    pool: &PgPool,
    user_id: Uuid,
    limit: i64,
    cursor: Option<&str>,
) -> AppResult<CollectionPage> {
    let keyset = decode_date_cursor(cursor, user_id)?;
    let fetch_limit = page_fetch_limit(limit)?;
    let rows = sqlx::query(
        r#"
        SELECT
          to_char(recent.entry_date, 'YYYY-MM-DD') AS entry_date,
          recent.id,
          jsonb_build_object(
            'id', recent.id,
            'userId', recent.user_id,
            'date', recent.entry_date,
            'weightKg', recent.weight_kg::float8,
            'bodyFatPct', recent.body_fat_pct::float8,
            'notes', recent.notes
          ) AS item
        FROM (
          SELECT id, user_id, entry_date, weight_kg, body_fat_pct, notes
          FROM weight_entries
          WHERE user_id = $1
            AND ($2::date IS NULL OR (entry_date, id) < ($2::date, $3::uuid))
          ORDER BY entry_date DESC, id DESC
          LIMIT $4
        ) recent
        ORDER BY recent.entry_date DESC, recent.id DESC
        "#,
    )
    .bind(user_id)
    .bind(keyset.as_ref().map(|cursor| cursor.date.as_str()))
    .bind(keyset.as_ref().map(|cursor| cursor.id))
    .bind(fetch_limit)
    .fetch_all(pool)
    .await?;

    let next_cursor = keyset_next_cursor(&rows, limit, |row| {
        Ok(encode_cursor(&json!({
            "v": CURSOR_VERSION,
            "u": user_id.to_string(),
            "d": row.try_get::<String, _>("entry_date")?,
            "i": row.try_get::<Uuid, _>("id")?.to_string(),
        }))?)
    })?;
    let mut page = collection_page(rows, limit, next_cursor)?;
    if let Value::Array(items) = &mut page.items {
        items.reverse();
    }
    Ok(page)
}

pub(crate) async fn stats_page_json(
    pool: &PgPool,
    user_id: Uuid,
    today: &str,
) -> AppResult<StatsPage> {
    let page: StatsPageData = super::stats_page_data_json(pool, user_id, today).await?;
    Ok(StatsPage {
        data: page.data,
        daily_totals: series_window(page.daily_totals_available),
        smoothed_weight_trend: series_window(page.smoothed_weight_available),
    })
}

fn series_window(available: i64) -> SeriesWindow {
    SeriesWindow {
        limit: STATS_SERIES_LIMIT,
        count: available.min(STATS_SERIES_LIMIT),
        truncated: available > STATS_SERIES_LIMIT,
    }
}

/// Fetches one row past the cap so truncation is proven by the row set itself.
fn page_fetch_limit(limit: i64) -> AppResult<i64> {
    if !(MIN_PAGE_LIMIT..=LEGACY_COLLECTION_LIMIT).contains(&limit) {
        return Err(AppError::BadRequest("limit is out of range.".to_string()));
    }
    Ok(limit + 1)
}

fn collection_page(
    rows: Vec<PgRow>,
    limit: i64,
    next_cursor: Option<String>,
) -> AppResult<CollectionPage> {
    let returned = rows.len().min(limit as usize);
    let mut items = Vec::with_capacity(returned);
    for row in rows.iter().take(returned) {
        items.push(row.try_get::<Value, _>("item")?);
    }
    Ok(CollectionPage {
        items: Value::Array(items),
        truncated: next_cursor.is_some(),
        next_cursor,
        limit,
        returned: returned as i64,
    })
}

/// Builds the continuation cursor from the last returned row when (and only
/// when) the fetch saw one more row than the page keeps.
fn keyset_next_cursor(
    rows: &[PgRow],
    limit: i64,
    encode: impl FnOnce(&PgRow) -> AppResult<String>,
) -> AppResult<Option<String>> {
    if rows.len() as i64 <= limit {
        return Ok(None);
    }
    let last_kept = rows
        .get(usize::try_from(limit - 1).expect("limit is positive"))
        .ok_or_else(|| AppError::BadRequest("limit is out of range.".to_string()))?;
    Ok(Some(encode(last_kept)?))
}

fn decode_keyset_cursor(cursor: Option<&str>, user_id: Uuid) -> AppResult<Option<KeysetCursor>> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let payload = decode_cursor(cursor, user_id)?;
    Ok(Some(KeysetCursor {
        updated_at: cursor_timestamp(&payload, "t")?,
        created_at: cursor_timestamp(&payload, "c")?,
        id: cursor_uuid(&payload, "i")?,
    }))
}

fn decode_date_cursor(cursor: Option<&str>, user_id: Uuid) -> AppResult<Option<DateCursor>> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let payload = decode_cursor(cursor, user_id)?;
    Ok(Some(DateCursor {
        date: cursor_date(&payload, "d")?,
        id: cursor_uuid(&payload, "i")?,
    }))
}

fn invalid_cursor() -> AppError {
    AppError::BadRequest("cursor is invalid.".to_string())
}

/// Decodes the opaque base64url payload and pins it to the requesting user,
/// so a cursor from another account can never address that account's rows.
fn decode_cursor(cursor: &str, user_id: Uuid) -> AppResult<Map<String, Value>> {
    if cursor.is_empty() || cursor.len() > MAX_CURSOR_BYTES * 2 {
        return Err(invalid_cursor());
    }
    let bytes = Base64UrlUnpadded::decode_vec(cursor).map_err(|_| invalid_cursor())?;
    if bytes.len() > MAX_CURSOR_BYTES {
        return Err(invalid_cursor());
    }
    let payload: Value = serde_json::from_slice(&bytes).map_err(|_| invalid_cursor())?;
    let payload = payload.as_object().ok_or_else(invalid_cursor)?;
    if payload.get("v").and_then(Value::as_i64) != Some(CURSOR_VERSION) {
        return Err(invalid_cursor());
    }
    let owner = user_id.to_string();
    if payload.get("u").and_then(Value::as_str) != Some(owner.as_str()) {
        return Err(invalid_cursor());
    }
    Ok(payload.clone())
}

fn encode_cursor(payload: &Value) -> AppResult<String> {
    Ok(Base64UrlUnpadded::encode_string(&serde_json::to_vec(
        payload,
    )?))
}

fn cursor_timestamp(payload: &Map<String, Value>, key: &str) -> AppResult<String> {
    let raw = payload
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(invalid_cursor)?;
    let parsed: DateTime<Utc> = raw.parse::<DateTime<Utc>>().map_err(|_| invalid_cursor())?;
    Ok(parsed.to_rfc3339_opts(SecondsFormat::Micros, true))
}

fn cursor_date(payload: &Map<String, Value>, key: &str) -> AppResult<String> {
    let raw = payload
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(invalid_cursor)?;
    NaiveDate::parse_from_str(raw, "%Y-%m-%d")
        .map(|date| date.format("%Y-%m-%d").to_string())
        .map_err(|_| invalid_cursor())
}

fn cursor_uuid(payload: &Map<String, Value>, key: &str) -> AppResult<Uuid> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(invalid_cursor)
        .and_then(|raw| Uuid::parse_str(raw).map_err(|_| invalid_cursor()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keyset_payload(user_id: Uuid, updated_at: &str, created_at: &str) -> Value {
        json!({
            "v": CURSOR_VERSION,
            "u": user_id.to_string(),
            "t": updated_at,
            "c": created_at,
            "i": Uuid::new_v4().to_string(),
        })
    }

    #[test]
    fn malformed_cursors_are_rejected_before_any_query() {
        let user_id = Uuid::new_v4();
        for cursor in [
            "",
            "not base64!!",
            &Base64UrlUnpadded::encode_string(b"not json"),
            &encode_cursor(&json!({ "v": 2, "u": user_id.to_string(), "t": "2026-01-01T00:00:00Z", "c": "2026-01-01T00:00:00Z", "i": Uuid::new_v4().to_string() })).unwrap(),
            &encode_cursor(&json!({ "v": 1, "u": user_id.to_string(), "t": "2026-01-01T00:00:00Z" })).unwrap(),
        ] {
            assert!(
                matches!(
                    decode_keyset_cursor(Some(cursor), user_id),
                    Err(AppError::BadRequest(_))
                ),
                "cursor {cursor:?} should be rejected"
            );
        }
    }

    #[test]
    fn cursors_are_bound_to_the_requesting_user() {
        let owner = Uuid::new_v4();
        let cursor = encode_cursor(&keyset_payload(
            owner,
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:00:00Z",
        ))
        .expect("cursor encodes");

        assert!(decode_keyset_cursor(Some(&cursor), owner).is_ok());
        assert!(matches!(
            decode_keyset_cursor(Some(&cursor), Uuid::new_v4()),
            Err(AppError::BadRequest(_))
        ));
    }

    #[test]
    fn cursor_timestamps_are_canonicalized_to_utc_microseconds() {
        let user_id = Uuid::new_v4();
        let cursor = encode_cursor(&keyset_payload(
            user_id,
            "2026-01-02T03:04:05+02:00",
            "2026-01-02T00:00:00.5Z",
        ))
        .expect("cursor encodes");
        let decoded = decode_keyset_cursor(Some(&cursor), user_id)
            .expect("cursor decodes")
            .expect("cursor is present");

        assert_eq!(decoded.updated_at, "2026-01-02T01:04:05.000000Z");
        assert_eq!(decoded.created_at, "2026-01-02T00:00:00.500000Z");
    }

    #[test]
    fn cursor_dates_must_be_iso_days() {
        let user_id = Uuid::new_v4();
        let cursor = encode_cursor(&json!({
            "v": CURSOR_VERSION,
            "u": user_id.to_string(),
            "d": "2026-13-40",
            "i": Uuid::new_v4().to_string(),
        }))
        .expect("cursor encodes");

        assert!(matches!(
            decode_date_cursor(Some(&cursor), user_id),
            Err(AppError::BadRequest(_))
        ));
    }

    #[test]
    fn fetch_limit_keeps_the_legacy_cap_reachable_and_the_opt_in_bounds_small() {
        assert_eq!(page_fetch_limit(MIN_PAGE_LIMIT).expect("valid"), 2);
        assert_eq!(
            page_fetch_limit(LEGACY_COLLECTION_LIMIT).expect("valid"),
            LEGACY_COLLECTION_LIMIT + 1
        );
        for limit in [0, -1, LEGACY_COLLECTION_LIMIT + 1] {
            assert!(
                matches!(page_fetch_limit(limit), Err(AppError::BadRequest(_))),
                "limit {limit} should be rejected"
            );
        }
    }
}
