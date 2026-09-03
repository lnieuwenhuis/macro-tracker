//! Gym schedule sharing: slots, per-date statuses, buddies and overlaps.
//! Buddy visibility is read-only; every write predicate carries the caller's ownership.

use super::{MAX_TEXT_FIELD_LENGTH, ensure_date_string, ensure_text_length};
use crate::errors::{AppError, AppResult};
use chrono::{NaiveDate, Utc};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row};
use std::collections::HashMap;
use uuid::Uuid;

const GYM_SLOT_STATUS_VALUES: &[&str] = &["going", "maybe", "skipped", "done"];
const GYM_MAX_SLOTS_PER_USER: i64 = 50;
const GYM_MAX_PENDING_OUTGOING_INVITES: i64 = 20;
const GYM_MAX_ACCEPTED_BUDDIES: i64 = 100;
/// Bounds how far a status write may be from today; the date-format check alone allows `9999-12-31`.
const GYM_STATUS_DATE_WINDOW_DAYS: i64 = 400;
const GYM_MAX_TITLE_LENGTH: usize = 100;
const GYM_MAX_OVERLAP_BUDDIES: usize = 20;
const GYM_MAX_OVERLAP_WINDOWS_PER_BUDDY: usize = 3;

/// Every cross-user read builds on this CTE; `LIMIT 120` sits above the cap of 100 so overshoot never drops a buddy.
macro_rules! gym_accepted_buddies_cte {
    () => {
        r#"
        accepted_buddies AS (
          SELECT
            b.id AS buddy_row_id,
            CASE
              WHEN b.requester_user_id = $1 THEN b.addressee_user_id
              ELSE b.requester_user_id
            END AS buddy_user_id
          FROM gym_buddies b
          WHERE b.status = 'accepted'
            AND (b.requester_user_id = $1 OR b.addressee_user_id = $1)
          ORDER BY b.created_at, b.id
          LIMIT 120
        )
        "#
    };
}

/// Slots occurring on `$2::date` for the caller ($1) and accepted buddies; requires the accepted_buddies CTE first.
macro_rules! gym_resolved_slots_cte {
    () => {
        r#"
        resolved_slots AS (
          SELECT
            s.id,
            s.user_id,
            s.title,
            s.description,
            s.recurrence,
            s.start_minute,
            s.end_minute,
            coalesce(st.status, 'going') AS status
          FROM gym_slots s
          LEFT JOIN gym_slot_statuses st
            ON st.slot_id = s.id AND st.status_date = $2::date
          WHERE (
              s.user_id = $1
              OR s.user_id IN (SELECT buddy_user_id FROM accepted_buddies)
            )
            AND (
              (s.recurrence = 'once' AND s.slot_date = $2::date)
              OR (s.recurrence = 'weekly' AND s.weekday = EXTRACT(ISODOW FROM $2::date)::int)
            )
        )
        "#
    };
}

/// Raw pairwise overlap rows (>=30 min), merged into windows by `gym_merge_overlaps`; buddy rows omit `description`.
macro_rules! gym_overlap_rows_sql {
    () => {
        concat!(
            "WITH ",
            gym_accepted_buddies_cte!(),
            ", ",
            gym_resolved_slots_cte!(),
            r#"
            , own AS (
              SELECT * FROM resolved_slots
              WHERE user_id = $1 AND status IN ('going', 'done', 'maybe')
            ),
            buddy AS (
              SELECT rs.*, coalesce(u.display_name, u.email) AS buddy_name
              FROM resolved_slots rs
              JOIN users u ON u.id = rs.user_id
              WHERE rs.user_id <> $1 AND rs.status IN ('going', 'done', 'maybe')
            )
            SELECT coalesce(jsonb_agg(
              jsonb_build_object(
                'buddyId', b.user_id,
                'buddyName', b.buddy_name,
                'startMinute', GREATEST(o.start_minute, b.start_minute),
                'endMinute', LEAST(o.end_minute, b.end_minute),
                'tentative', (o.status = 'maybe' OR b.status = 'maybe')
              )
              ORDER BY GREATEST(o.start_minute, b.start_minute), b.user_id, b.id, o.id
            ), '[]'::jsonb) AS data
            FROM own o
            JOIN buddy b
              ON GREATEST(o.start_minute, b.start_minute) + 30 <= LEAST(o.end_minute, b.end_minute)
            "#
        )
    };
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct GymSlotValues {
    pub(super) title: String,
    pub(super) description: Option<String>,
    pub(super) recurrence: String,
    pub(super) slot_date: Option<String>,
    pub(super) weekday: Option<i32>,
    pub(super) start_minute: i32,
    pub(super) end_minute: i32,
}

pub(super) fn ensure_gym_status(value: &str) -> AppResult<()> {
    if GYM_SLOT_STATUS_VALUES.contains(&value) {
        Ok(())
    } else {
        Err(AppError::BadRequest(
            "Status must be one of going, maybe, skipped or done.".to_string(),
        ))
    }
}

/// Excludes 0/O/1/I/L (read aloud and typed back); 31^8 ≈ 8.5e11 codes, unguessable unlike the email lookup path.
pub(super) const GYM_FRIEND_CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
pub(super) const GYM_FRIEND_CODE_LENGTH: usize = 8;

/// Uses UUIDv4 bytes for entropy, same idiom as `create_api_token_json`; modulo bias is irrelevant here.
pub(super) fn generate_gym_friend_code() -> String {
    Uuid::new_v4()
        .as_bytes()
        .iter()
        .take(GYM_FRIEND_CODE_LENGTH)
        .map(|byte| {
            GYM_FRIEND_CODE_ALPHABET[*byte as usize % GYM_FRIEND_CODE_ALPHABET.len()] as char
        })
        .collect()
}

pub(super) enum GymInviteIdentifier {
    Email(String),
    FriendCode(String),
}

pub(super) fn classify_gym_invite_identifier(raw: &str) -> AppResult<GymInviteIdentifier> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest(
            "Enter an email address or friend code.".to_string(),
        ));
    }
    ensure_text_length(trimmed, MAX_TEXT_FIELD_LENGTH, "Identifier")?;
    if trimmed.contains('@') {
        return Ok(GymInviteIdentifier::Email(trimmed.to_lowercase()));
    }
    let code: String = trimmed
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_uppercase())
        .collect();
    if code.is_empty() {
        return Err(AppError::BadRequest(
            "Enter an email address or friend code.".to_string(),
        ));
    }
    Ok(GymInviteIdentifier::FriendCode(code))
}

/// The guarded UPDATE settles concurrent first use on one winner; the unique index turns a race into a retry.
async fn ensure_gym_friend_code(pool: &PgPool, user_id: Uuid) -> AppResult<String> {
    let existing: Option<Option<String>> =
        sqlx::query_scalar("SELECT friend_code FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await?;
    let Some(existing) = existing else {
        return Err(AppError::NotFound("User not found.".to_string()));
    };
    if let Some(code) = existing {
        return Ok(code);
    }

    for _ in 0..5 {
        let candidate = generate_gym_friend_code();
        let updated = sqlx::query_scalar::<_, String>(
            "UPDATE users SET friend_code = $2 WHERE id = $1 AND friend_code IS NULL RETURNING friend_code",
        )
        .bind(user_id)
        .bind(&candidate)
        .fetch_optional(pool)
        .await;
        match updated {
            Ok(Some(code)) => return Ok(code),
            Ok(None) => {
                // A concurrent request won the race; read its code.
                let code: Option<String> =
                    sqlx::query_scalar("SELECT friend_code FROM users WHERE id = $1")
                        .bind(user_id)
                        .fetch_one(pool)
                        .await?;
                if let Some(code) = code {
                    return Ok(code);
                }
            }
            Err(sqlx::Error::Database(database_error))
                if database_error.code().as_deref() == Some("23505") => {}
            Err(error) => return Err(AppError::Sqlx(error)),
        }
    }
    Err(AppError::Anyhow(anyhow::anyhow!(
        "could not allocate a unique friend code after 5 attempts"
    )))
}

fn gym_minute(
    input: &serde_json::Map<String, Value>,
    key: &str,
    field_name: &str,
) -> AppResult<i32> {
    let value = input
        .get(key)
        .and_then(Value::as_i64)
        .ok_or_else(|| AppError::BadRequest(format!("{field_name} is required.")))?;
    // 1440 is a valid END ("until midnight"); start < end rules it out as a start.
    if !(0..=1440).contains(&value) {
        return Err(AppError::BadRequest(format!(
            "{field_name} must be between 0 and 1440 minutes."
        )));
    }
    Ok(value as i32)
}

pub(super) fn gym_slot_values(input: &serde_json::Map<String, Value>) -> AppResult<GymSlotValues> {
    let title = input
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Gym")
        .to_string();
    ensure_text_length(&title, GYM_MAX_TITLE_LENGTH, "Title")?;

    let description = input
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(description) = &description {
        ensure_text_length(description, MAX_TEXT_FIELD_LENGTH, "Description")?;
    }

    let recurrence = input
        .get("recurrence")
        .and_then(Value::as_str)
        .unwrap_or("once")
        .to_string();
    if !matches!(recurrence.as_str(), "once" | "weekly") {
        return Err(AppError::BadRequest(
            "Recurrence must be 'once' or 'weekly'.".to_string(),
        ));
    }

    let start_minute = gym_minute(input, "startMinute", "Start time")?;
    let end_minute = gym_minute(input, "endMinute", "End time")?;
    if start_minute >= end_minute {
        return Err(AppError::BadRequest(
            "A slot must start before it ends; overnight slots are not supported.".to_string(),
        ));
    }

    let (slot_date, weekday) = if recurrence == "once" {
        let date = input
            .get("slotDate")
            .and_then(Value::as_str)
            .ok_or_else(|| AppError::BadRequest("A one-off slot needs a date.".to_string()))?;
        ensure_date_string(date)?;
        (Some(date.to_string()), None)
    } else {
        let weekday = input
            .get("weekday")
            .and_then(Value::as_i64)
            .ok_or_else(|| AppError::BadRequest("A weekly slot needs a weekday.".to_string()))?;
        if !(1..=7).contains(&weekday) {
            return Err(AppError::BadRequest(
                "Weekday must be between 1 (Monday) and 7 (Sunday).".to_string(),
            ));
        }
        (None, Some(weekday as i32))
    };

    Ok(GymSlotValues {
        title,
        description,
        recurrence,
        slot_date,
        weekday,
        start_minute,
        end_minute,
    })
}

/// Serializes count-guarded cap checks; locks are always taken in ascending user-id order, before any row lock.
async fn gym_advisory_lock(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    mut user_ids: Vec<Uuid>,
) -> AppResult<()> {
    user_ids.sort();
    user_ids.dedup();
    for user_id in user_ids {
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('gym_user:' || $1::text))")
            .bind(user_id)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

/// Backstop for the pair-unique index; without it a duplicate invite race surfaces as a 500 instead of a Conflict.
fn gym_conflict_on_unique_violation(error: sqlx::Error, message: &str) -> AppError {
    if let sqlx::Error::Database(database_error) = &error
        && database_error.code().as_deref() == Some("23505")
    {
        return AppError::Conflict(message.to_string());
    }
    AppError::Sqlx(error)
}

async fn gym_ensure_accepted_capacity(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    user_id: Uuid,
) -> AppResult<()> {
    let accepted: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM gym_buddies WHERE status = 'accepted' AND (requester_user_id = $1 OR addressee_user_id = $1)",
    )
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await?;
    if accepted >= GYM_MAX_ACCEPTED_BUDDIES {
        return Err(AppError::Conflict(
            "The gym buddy limit has been reached.".to_string(),
        ));
    }
    Ok(())
}

pub(super) async fn create_gym_slot_json(
    pool: &PgPool,
    user_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let values = gym_slot_values(input)?;
    let mut tx = pool.begin().await?;
    gym_advisory_lock(&mut tx, vec![user_id]).await?;
    let row = sqlx::query(
        r#"
        INSERT INTO gym_slots (
          id, user_id, title, description, recurrence, slot_date, weekday, start_minute, end_minute
        )
        SELECT $2, $1, $3, $4, $5, $6::date, $7, $8, $9
        WHERE (SELECT count(*) FROM gym_slots WHERE user_id = $1) < $10
        RETURNING jsonb_build_object(
          'id', id,
          'title', title,
          'description', description,
          'recurrence', recurrence,
          'slotDate', slot_date,
          'weekday', weekday,
          'startMinute', start_minute,
          'endMinute', end_minute
        ) AS data
        "#,
    )
    .bind(user_id)
    .bind(Uuid::new_v4())
    .bind(&values.title)
    .bind(&values.description)
    .bind(&values.recurrence)
    .bind(&values.slot_date)
    .bind(values.weekday)
    .bind(values.start_minute)
    .bind(values.end_minute)
    .bind(GYM_MAX_SLOTS_PER_USER)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        return Err(AppError::Conflict(format!(
            "You can have at most {GYM_MAX_SLOTS_PER_USER} gym slots; delete one first."
        )));
    };
    let data: Value = row.try_get("data")?;
    tx.commit().await?;
    Ok(data)
}

pub(super) async fn update_gym_slot_json(
    pool: &PgPool,
    user_id: Uuid,
    slot_id: Uuid,
    input: &serde_json::Map<String, Value>,
) -> AppResult<Value> {
    let values = gym_slot_values(input)?;
    let mut tx = pool.begin().await?;
    let existing = sqlx::query(
        r#"
        SELECT recurrence, slot_date::text AS slot_date, weekday
        FROM gym_slots
        WHERE id = $2 AND user_id = $1
        FOR UPDATE
        "#,
    )
    .bind(user_id)
    .bind(slot_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(existing) = existing else {
        return Err(AppError::NotFound("Gym slot not found.".to_string()));
    };
    let existing_recurrence: String = existing.try_get("recurrence")?;
    if existing_recurrence != values.recurrence {
        return Err(AppError::BadRequest(
            "A slot's repeat kind can't be changed; delete it and create a new one.".to_string(),
        ));
    }
    let existing_date: Option<String> = existing.try_get("slot_date")?;
    let existing_weekday: Option<i32> = existing.try_get("weekday")?;

    let row = sqlx::query(
        r#"
        UPDATE gym_slots
        SET title = $3,
            description = $4,
            slot_date = $5::date,
            weekday = $6,
            start_minute = $7,
            end_minute = $8,
            updated_at = now()
        WHERE id = $2 AND user_id = $1
        RETURNING jsonb_build_object(
          'id', id,
          'title', title,
          'description', description,
          'recurrence', recurrence,
          'slotDate', slot_date,
          'weekday', weekday,
          'startMinute', start_minute,
          'endMinute', end_minute
        ) AS data
        "#,
    )
    .bind(user_id)
    .bind(slot_id)
    .bind(&values.title)
    .bind(&values.description)
    .bind(&values.slot_date)
    .bind(values.weekday)
    .bind(values.start_minute)
    .bind(values.end_minute)
    .fetch_one(&mut *tx)
    .await?;
    let data: Value = row.try_get("data")?;

    // Statuses are keyed to concrete dates; they must not survive a move or they'd resurrect if it moved back.
    if existing_date != values.slot_date || existing_weekday != values.weekday {
        sqlx::query("DELETE FROM gym_slot_statuses WHERE slot_id = $1")
            .bind(slot_id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(data)
}

pub(super) async fn delete_gym_slot_json(
    pool: &PgPool,
    user_id: Uuid,
    slot_id: Uuid,
) -> AppResult<Value> {
    let deleted = sqlx::query("DELETE FROM gym_slots WHERE id = $2 AND user_id = $1 RETURNING id")
        .bind(user_id)
        .bind(slot_id)
        .fetch_optional(pool)
        .await?
        .is_some();
    if !deleted {
        return Err(AppError::NotFound("Gym slot not found.".to_string()));
    }
    Ok(json!({ "deleted": true }))
}

pub(super) async fn set_gym_slot_status_json(
    pool: &PgPool,
    user_id: Uuid,
    slot_id: Uuid,
    date: &str,
    status: &str,
) -> AppResult<Value> {
    ensure_gym_status(status)?;
    let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| AppError::BadRequest("Date must use YYYY-MM-DD.".to_string()))?;
    let today = Utc::now().date_naive();
    if (parsed - today).num_days().abs() > GYM_STATUS_DATE_WINDOW_DAYS {
        return Err(AppError::BadRequest(
            "That date is too far away to set a gym status.".to_string(),
        ));
    }

    // Ownership and occurrence checks live inside the insert-from-select; buddy slot ids are visible to every client.
    let row = sqlx::query(
        r#"
        INSERT INTO gym_slot_statuses (id, slot_id, status_date, status)
        SELECT $1, s.id, $2::date, $3
        FROM gym_slots s
        WHERE s.id = $4 AND s.user_id = $5
          AND (
            (s.recurrence = 'once' AND s.slot_date = $2::date)
            OR (s.recurrence = 'weekly' AND s.weekday = EXTRACT(ISODOW FROM $2::date)::int)
          )
        ON CONFLICT (slot_id, status_date)
        DO UPDATE SET status = EXCLUDED.status, updated_at = now()
        RETURNING jsonb_build_object(
          'slotId', slot_id,
          'date', status_date,
          'status', status
        ) AS data
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(date)
    .bind(status)
    .bind(slot_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Err(AppError::NotFound(
            "Gym slot not found for that date.".to_string(),
        ));
    };
    Ok(row.try_get("data")?)
}

pub(super) async fn invite_gym_buddy_json(
    pool: &PgPool,
    user_id: Uuid,
    identifier: &str,
) -> AppResult<Value> {
    let identifier = classify_gym_invite_identifier(identifier)?;
    // The email path is an accepted account-existence oracle at this scale; the friend-code path is not (31^8 random).
    let (stored_identifier, target_id): (String, Option<Uuid>) = match &identifier {
        GymInviteIdentifier::Email(email) => (
            email.clone(),
            sqlx::query_scalar("SELECT id FROM users WHERE email = $1")
                .bind(email)
                .fetch_optional(pool)
                .await?,
        ),
        GymInviteIdentifier::FriendCode(code) => (
            code.clone(),
            sqlx::query_scalar("SELECT id FROM users WHERE friend_code = $1")
                .bind(code)
                .fetch_optional(pool)
                .await?,
        ),
    };
    let Some(target_id) = target_id else {
        return Err(AppError::NotFound(match identifier {
            GymInviteIdentifier::Email(_) => {
                "No user with that email is on Macro Tracker.".to_string()
            }
            GymInviteIdentifier::FriendCode(_) => "No user with that friend code.".to_string(),
        }));
    };
    if target_id == user_id {
        return Err(AppError::BadRequest(
            "You can't invite yourself.".to_string(),
        ));
    }

    let mut tx = pool.begin().await?;
    gym_advisory_lock(&mut tx, vec![user_id, target_id]).await?;
    let existing = sqlx::query(
        r#"
        SELECT id, requester_user_id, status
        FROM gym_buddies
        WHERE LEAST(requester_user_id, addressee_user_id) = LEAST($1, $2)
          AND GREATEST(requester_user_id, addressee_user_id) = GREATEST($1, $2)
        FOR UPDATE
        "#,
    )
    .bind(user_id)
    .bind(target_id)
    .fetch_optional(&mut *tx)
    .await?;

    match existing {
        None => {
            let pending_outgoing: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM gym_buddies WHERE requester_user_id = $1 AND status = 'pending'",
            )
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;
            if pending_outgoing >= GYM_MAX_PENDING_OUTGOING_INVITES {
                return Err(AppError::Conflict(
                    "You have too many pending invites; cancel one first.".to_string(),
                ));
            }
            let row = sqlx::query(
                r#"
                INSERT INTO gym_buddies (id, requester_user_id, addressee_user_id, invite_identifier)
                VALUES ($1, $2, $3, $4)
                RETURNING jsonb_build_object('id', id, 'result', 'invited') AS data
                "#,
            )
            .bind(Uuid::new_v4())
            .bind(user_id)
            .bind(target_id)
            .bind(&stored_identifier)
            .fetch_one(&mut *tx)
            .await
            .map_err(|error| {
                gym_conflict_on_unique_violation(
                    error,
                    "You already have an invite with this user.",
                )
            })?;
            let data: Value = row.try_get("data")?;
            tx.commit().await?;
            Ok(data)
        }
        Some(row) => {
            let buddy_row_id: Uuid = row.try_get("id")?;
            let requester_user_id: Uuid = row.try_get("requester_user_id")?;
            let status: String = row.try_get("status")?;
            match status.as_str() {
                "pending" if requester_user_id == user_id => Err(AppError::Conflict(
                    "You already invited this user.".to_string(),
                )),
                // The other user already invited us; two people trying to pair up should not get a confusing conflict.
                "pending" => {
                    gym_ensure_accepted_capacity(&mut tx, user_id).await?;
                    gym_ensure_accepted_capacity(&mut tx, target_id).await?;
                    sqlx::query(
                        "UPDATE gym_buddies SET status = 'accepted', updated_at = now() WHERE id = $1 AND status = 'pending'",
                    )
                    .bind(buddy_row_id)
                    .execute(&mut *tx)
                    .await?;
                    tx.commit().await?;
                    Ok(json!({ "id": buddy_row_id, "result": "accepted" }))
                }
                "accepted" => Err(AppError::Conflict(
                    "You're already gym buddies with this user.".to_string(),
                )),
                // Neutral on purpose: a declined row is a block, and the copy must not reveal that (or who) declined.
                _ => Err(AppError::Conflict(
                    "You can't invite this user right now.".to_string(),
                )),
            }
        }
    }
}

pub(super) async fn respond_gym_buddy_invite_json(
    pool: &PgPool,
    user_id: Uuid,
    buddy_id: Uuid,
    accept: bool,
) -> AppResult<Value> {
    if !accept {
        // Decline keeps the row as a durable block; only the decliner can remove it later (see remove_gym_buddy_json).
        let declined = sqlx::query(
            "UPDATE gym_buddies SET status = 'declined', updated_at = now() WHERE id = $2 AND addressee_user_id = $1 AND status = 'pending' RETURNING id",
        )
        .bind(user_id)
        .bind(buddy_id)
        .fetch_optional(pool)
        .await?
        .is_some();
        if !declined {
            return Err(AppError::NotFound(
                "This invite is no longer available.".to_string(),
            ));
        }
        return Ok(json!({ "status": "declined" }));
    }

    let mut tx = pool.begin().await?;
    // Plain read (no FOR UPDATE): party ids are immutable once a row exists; advisory locks must precede any row lock.
    let row = sqlx::query(
        "SELECT requester_user_id, addressee_user_id FROM gym_buddies WHERE id = $2 AND addressee_user_id = $1 AND status = 'pending'",
    )
    .bind(user_id)
    .bind(buddy_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        return Err(AppError::NotFound(
            "This invite is no longer available.".to_string(),
        ));
    };
    let requester_user_id: Uuid = row.try_get("requester_user_id")?;
    gym_advisory_lock(&mut tx, vec![user_id, requester_user_id]).await?;
    gym_ensure_accepted_capacity(&mut tx, user_id).await?;
    gym_ensure_accepted_capacity(&mut tx, requester_user_id).await?;
    // The guarded UPDATE re-checks ownership and state under the locks, so a race lands on 0 rows, not a lost update.
    let accepted = sqlx::query(
        "UPDATE gym_buddies SET status = 'accepted', updated_at = now() WHERE id = $2 AND addressee_user_id = $1 AND status = 'pending' RETURNING id",
    )
    .bind(user_id)
    .bind(buddy_id)
    .fetch_optional(&mut *tx)
    .await?
    .is_some();
    if !accepted {
        return Err(AppError::NotFound(
            "This invite is no longer available.".to_string(),
        ));
    }
    tx.commit().await?;
    Ok(json!({ "status": "accepted" }))
}

pub(super) async fn remove_gym_buddy_json(
    pool: &PgPool,
    user_id: Uuid,
    buddy_id: Uuid,
) -> AppResult<Value> {
    // Split by status: a symmetric predicate lets a blocked requester delete the declined row via a stale "Cancel".
    let removed = sqlx::query(
        r#"
        DELETE FROM gym_buddies
        WHERE id = $2
          AND (
            (status = 'pending' AND requester_user_id = $1)
            OR (status = 'accepted' AND (requester_user_id = $1 OR addressee_user_id = $1))
            OR (status = 'declined' AND addressee_user_id = $1)
          )
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(buddy_id)
    .fetch_optional(pool)
    .await?
    .is_some();
    if !removed {
        return Err(AppError::NotFound(
            "This invite is no longer available.".to_string(),
        ));
    }
    Ok(json!({ "removed": true }))
}

/// Merges raw overlap rows into at most `GYM_MAX_OVERLAP_WINDOWS_PER_BUDDY` per buddy, confirmed/tentative separately.
pub(super) fn gym_merge_overlaps(rows: &[Value]) -> Value {
    fn merge_windows(mut windows: Vec<(i64, i64)>) -> Vec<(i64, i64)> {
        windows.sort_unstable();
        let mut merged: Vec<(i64, i64)> = Vec::new();
        for (start, end) in windows {
            match merged.last_mut() {
                Some(last) if start <= last.1 => last.1 = last.1.max(end),
                _ => merged.push((start, end)),
            }
        }
        merged
    }

    struct BuddyOverlaps {
        name: String,
        confirmed: Vec<(i64, i64)>,
        tentative: Vec<(i64, i64)>,
    }

    let mut order: Vec<String> = Vec::new();
    let mut buddies: HashMap<String, BuddyOverlaps> = HashMap::new();
    for row in rows {
        let Some(buddy_id) = row.get("buddyId").and_then(Value::as_str) else {
            continue;
        };
        let (Some(start), Some(end)) = (
            row.get("startMinute").and_then(Value::as_i64),
            row.get("endMinute").and_then(Value::as_i64),
        ) else {
            continue;
        };
        let tentative = row
            .get("tentative")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let entry = buddies.entry(buddy_id.to_string()).or_insert_with(|| {
            order.push(buddy_id.to_string());
            BuddyOverlaps {
                name: row
                    .get("buddyName")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                confirmed: Vec::new(),
                tentative: Vec::new(),
            }
        });
        if tentative {
            entry.tentative.push((start, end));
        } else {
            entry.confirmed.push((start, end));
        }
    }

    let mut entries: Vec<Value> = Vec::new();
    for buddy_id in order {
        let Some(buddy) = buddies.remove(&buddy_id) else {
            continue;
        };
        let confirmed = merge_windows(buddy.confirmed);
        let tentative = merge_windows(buddy.tentative);
        let mut windows: Vec<Value> = confirmed
            .iter()
            .map(|(start, end)| json!({ "startMinute": start, "endMinute": end, "tentative": false }))
            .chain(
                tentative
                    .iter()
                    .map(|(start, end)| json!({ "startMinute": start, "endMinute": end, "tentative": true })),
            )
            .collect();
        windows.sort_by_key(|window| {
            window
                .get("startMinute")
                .and_then(Value::as_i64)
                .unwrap_or(0)
        });
        windows.truncate(GYM_MAX_OVERLAP_WINDOWS_PER_BUDDY);
        if windows.is_empty() {
            continue;
        }
        entries.push(json!({
            "buddy": { "id": buddy_id, "name": buddy.name },
            "windows": windows,
            "tentative": confirmed.is_empty(),
        }));
    }
    // Raw rows arrive ordered by overlap start, so `order` already ranks buddies by their earliest window.
    entries.truncate(GYM_MAX_OVERLAP_BUDDIES);
    Value::Array(entries)
}

async fn gym_overlap_entries(pool: &PgPool, user_id: Uuid, date: &str) -> AppResult<Value> {
    let row = sqlx::query(gym_overlap_rows_sql!())
        .bind(user_id)
        .bind(date)
        .fetch_one(pool)
        .await?;
    let raw: Value = row.try_get("data")?;
    let rows = raw.as_array().cloned().unwrap_or_default();
    Ok(gym_merge_overlaps(&rows))
}

pub(super) async fn get_gym_page_data_json(
    pool: &PgPool,
    user_id: Uuid,
    date: &str,
) -> AppResult<Value> {
    let friend_code = ensure_gym_friend_code(pool, user_id).await?;
    let day_row = sqlx::query(concat!(
        "WITH ",
        gym_accepted_buddies_cte!(),
        ", ",
        gym_resolved_slots_cte!(),
        r#"
        SELECT jsonb_build_object(
          'slots', coalesce((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', s.id,
                'title', s.title,
                'description', s.description,
                'recurrence', s.recurrence,
                'slotDate', s.slot_date,
                'weekday', s.weekday,
                'startMinute', s.start_minute,
                'endMinute', s.end_minute
              )
              ORDER BY (s.recurrence = 'weekly') DESC, s.weekday, s.slot_date DESC, s.start_minute, s.id
            )
            FROM gym_slots s
            WHERE s.user_id = $1
          ), '[]'::jsonb),
          'own', coalesce((
            SELECT jsonb_agg(
              jsonb_build_object(
                'id', rs.id,
                'title', rs.title,
                'description', rs.description,
                'recurrence', rs.recurrence,
                'startMinute', rs.start_minute,
                'endMinute', rs.end_minute,
                'status', rs.status
              )
              ORDER BY rs.start_minute, rs.id
            )
            FROM resolved_slots rs
            WHERE rs.user_id = $1
          ), '[]'::jsonb),
          'buddies', coalesce((
            SELECT jsonb_agg(grouped.entry ORDER BY grouped.name, grouped.buddy_user_id)
            FROM (
              SELECT
                coalesce(u.display_name, u.email) AS name,
                ab.buddy_user_id,
                jsonb_build_object(
                  'user', jsonb_build_object('id', u.id, 'name', coalesce(u.display_name, u.email)),
                  'slots', coalesce(jsonb_agg(
                    jsonb_build_object(
                      'id', rs.id,
                      'title', rs.title,
                      'recurrence', rs.recurrence,
                      'startMinute', rs.start_minute,
                      'endMinute', rs.end_minute,
                      'status', rs.status
                    )
                    ORDER BY rs.start_minute, rs.id
                  ) FILTER (WHERE rs.id IS NOT NULL), '[]'::jsonb)
                ) AS entry
              FROM accepted_buddies ab
              JOIN users u ON u.id = ab.buddy_user_id
              LEFT JOIN resolved_slots rs ON rs.user_id = ab.buddy_user_id
              GROUP BY u.id, u.display_name, u.email, ab.buddy_user_id
            ) grouped
          ), '[]'::jsonb)
        ) AS data
        "#
    ))
    .bind(user_id)
    .bind(date)
    .fetch_one(pool)
    .await?;
    let day: Value = day_row.try_get("data")?;

    let buddies_row = sqlx::query(concat!(
        "WITH ",
        gym_accepted_buddies_cte!(),
        r#"
        SELECT jsonb_build_object(
          'accepted', coalesce((
            SELECT jsonb_agg(entry.value ORDER BY entry.created_at, entry.id)
            FROM (
              SELECT b.created_at, b.id, jsonb_build_object(
                'id', b.id,
                'user', jsonb_build_object('id', u.id, 'name', coalesce(u.display_name, u.email))
              ) AS value
              FROM accepted_buddies ab
              JOIN gym_buddies b ON b.id = ab.buddy_row_id
              JOIN users u ON u.id = ab.buddy_user_id
            ) entry
          ), '[]'::jsonb),
          'pendingIncoming', coalesce((
            SELECT jsonb_agg(entry.value ORDER BY entry.created_at, entry.id)
            FROM (
              SELECT b.created_at, b.id, jsonb_build_object(
                'id', b.id,
                'user', jsonb_build_object('id', u.id, 'name', coalesce(u.display_name, u.email))
              ) AS value
              FROM gym_buddies b
              JOIN users u ON u.id = b.requester_user_id
              WHERE b.addressee_user_id = $1 AND b.status = 'pending'
              ORDER BY b.created_at, b.id
              LIMIT 50
            ) entry
          ), '[]'::jsonb),
          'pendingOutgoing', coalesce((
            SELECT jsonb_agg(entry.value ORDER BY entry.created_at, entry.id)
            FROM (
              SELECT b.created_at, b.id, jsonb_build_object(
                'id', b.id,
                'identifier', coalesce(b.invite_identifier, u.email)
              ) AS value
              FROM gym_buddies b
              JOIN users u ON u.id = b.addressee_user_id
              WHERE b.requester_user_id = $1 AND b.status = 'pending'
              ORDER BY b.created_at, b.id
              LIMIT 50
            ) entry
          ), '[]'::jsonb),
          'declined', coalesce((
            SELECT jsonb_agg(entry.value ORDER BY entry.created_at, entry.id)
            FROM (
              SELECT b.created_at, b.id, jsonb_build_object(
                'id', b.id,
                'user', jsonb_build_object('id', u.id, 'name', coalesce(u.display_name, u.email))
              ) AS value
              FROM gym_buddies b
              JOIN users u ON u.id = b.requester_user_id
              WHERE b.addressee_user_id = $1 AND b.status = 'declined'
              ORDER BY b.created_at, b.id
              LIMIT 50
            ) entry
          ), '[]'::jsonb)
        ) AS data
        "#
    ))
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    let buddies: Value = buddies_row.try_get("data")?;

    let overlaps = gym_overlap_entries(pool, user_id, date).await?;

    Ok(json!({
        "date": date,
        "friendCode": friend_code,
        "slots": day.get("slots").cloned().unwrap_or_else(|| json!([])),
        "day": {
            "own": day.get("own").cloned().unwrap_or_else(|| json!([])),
            "buddies": day.get("buddies").cloned().unwrap_or_else(|| json!([])),
        },
        "buddies": buddies,
        "overlaps": overlaps,
    }))
}

pub(super) async fn get_gym_home_summary_json(
    pool: &PgPool,
    user_id: Uuid,
    date: &str,
) -> AppResult<Value> {
    // One cheap probe; `/` fires several RPCs against a small pool, so the no-buddies case must stay near-free.
    let probe = sqlx::query(
        r#"
        SELECT
          EXISTS(
            SELECT 1 FROM gym_buddies
            WHERE status = 'accepted' AND (requester_user_id = $1 OR addressee_user_id = $1)
          ) AS has_buddies,
          (
            SELECT count(*) FROM gym_buddies
            WHERE addressee_user_id = $1 AND status = 'pending'
          ) AS pending_count
        "#,
    )
    .bind(user_id)
    .fetch_one(pool)
    .await?;
    let has_buddies: bool = probe.try_get("has_buddies")?;
    let pending_count: i64 = probe.try_get("pending_count")?;
    let pending_count = pending_count.min(99);

    if !has_buddies {
        return Ok(json!({ "overlaps": [], "pendingInviteCount": pending_count }));
    }

    let overlaps = gym_overlap_entries(pool, user_id, date).await?;
    Ok(json!({ "overlaps": overlaps, "pendingInviteCount": pending_count }))
}
