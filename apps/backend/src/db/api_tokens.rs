//! API-token persistence: creation, listing, revocation and authentication.
//!
//! Extracted verbatim from `db.rs` (godfiles audit, step 3 canary). The RPC
//! dispatch arms stay in `db.rs`; `authenticate_api_token` is re-exported
//! there so callers keep the `db::authenticate_api_token` path.

use super::{MAX_COLLECTION_ROWS, required_string};
use crate::errors::{AppError, AppResult};
use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row, postgres::PgRow};
use std::collections::HashSet;
use uuid::Uuid;

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

pub(super) async fn revoke_api_token_json(
    pool: &PgPool,
    user_id: Uuid,
    token_id: Uuid,
) -> AppResult<Value> {
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

pub(super) async fn create_api_token_json(
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

pub(super) fn normalize_api_token_scopes(scopes: Option<&Value>) -> AppResult<Vec<String>> {
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

pub(super) fn normalize_api_token_expiry(
    expires_at: Option<&Value>,
) -> AppResult<Option<DateTime<Utc>>> {
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

pub(super) async fn list_api_tokens_json(pool: &PgPool, user_id: Uuid) -> AppResult<Value> {
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
        LIMIT $2
        "#,
    )
    .bind(user_id)
    .bind(MAX_COLLECTION_ROWS)
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
