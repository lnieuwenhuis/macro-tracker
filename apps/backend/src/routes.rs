use crate::{
    AppState, auth,
    auth::InternalAuth,
    db,
    errors::{AppError, AppResult},
    types::{InternalRpcRequest, ok},
};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn internal_router() -> Router<AppState> {
    Router::new()
        .route("/rpc", post(internal_rpc))
        .route("/session/current", get(current_session))
        .route("/auth/shoo/verify", post(verify_shoo))
}

pub async fn health(State(state): State<AppState>) -> (StatusCode, Json<Value>) {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await
    {
        Ok(1) => (StatusCode::OK, Json(serde_json::json!({ "ok": true }))),
        Ok(_) => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "ok": false, "error": "database readiness check failed" })),
        ),
        Err(error) => {
            tracing::warn!(error = ?error, "database readiness check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(
                    serde_json::json!({ "ok": false, "error": "database readiness check failed" }),
                ),
            )
        }
    }
}

/// Ops that need the backend's own configuration to decide what is allowed, so
/// they cannot live in `db::rpc_json` (which only sees the pool).
///
/// `ensureUserRole` used to sit on the generic RPC surface taking a
/// caller-supplied role — an arbitrary role-assignment primitive. Both
/// replacements below decide the resulting role from server-side config
/// instead of from the request.
async fn config_scoped_rpc(state: &AppState, op: &str, args: &Value) -> AppResult<Option<Value>> {
    match op {
        "reconcileConfiguredOwner" => {
            let user_id = rpc_uuid(args, "userId")?;
            let user = db::get_user_by_id(&state.db, user_id)
                .await?
                .ok_or_else(|| AppError::NotFound("User not found.".to_string()))?;
            let user = auth::reconcile_configured_owner(state, user).await?;
            Ok(Some(serde_json::to_value(user)?))
        }
        "ensureUserRoleForTesting" => {
            if !state.config.enable_test_routes {
                return Err(AppError::Forbidden(
                    "Test routes are not enabled on this backend.".to_string(),
                ));
            }
            let user_id = rpc_uuid(args, "userId")?;
            let role = args
                .get("role")
                .and_then(Value::as_str)
                .filter(|role| matches!(*role, "user" | "admin" | "owner"))
                .ok_or_else(|| AppError::BadRequest("User role is invalid.".to_string()))?;
            Ok(Some(serde_json::to_value(
                db::ensure_user_role(&state.db, user_id, role).await?,
            )?))
        }
        _ => Ok(None),
    }
}

fn rpc_uuid(args: &Value, key: &str) -> AppResult<uuid::Uuid> {
    args.get(key)
        .and_then(Value::as_str)
        .and_then(|value| uuid::Uuid::parse_str(value).ok())
        .ok_or_else(|| AppError::BadRequest(format!("{key} must be a UUID.")))
}

async fn internal_rpc(
    State(state): State<AppState>,
    _auth: InternalAuth,
    Json(payload): Json<InternalRpcRequest>,
) -> AppResult<Json<Value>> {
    if let Some(value) = config_scoped_rpc(&state, &payload.op, &payload.args).await? {
        return Ok(Json(serde_json::to_value(ok(value))?));
    }

    let value = db::rpc_json(&state.db, &payload.op, payload.args).await?;
    Ok(Json(serde_json::to_value(ok(value))?))
}

async fn current_session(
    state: State<AppState>,
    _auth: InternalAuth,
    headers: HeaderMap,
) -> AppResult<Json<Value>> {
    let user = auth::current_user_from_headers(state, headers).await?;
    Ok(Json(serde_json::to_value(ok(user))?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShooVerifyRequest {
    id_token: String,
    app_origin: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShooVerifyResponse {
    session_token: String,
    session_max_age_seconds: i64,
    user: crate::types::SessionUser,
}

async fn verify_shoo(
    State(state): State<AppState>,
    _auth: InternalAuth,
    Json(payload): Json<ShooVerifyRequest>,
) -> AppResult<Json<Value>> {
    if !state.config.is_trusted_origin(&payload.app_origin) {
        return Err(AppError::Forbidden("Origin is not trusted.".to_string()));
    }

    let (session, _user) =
        auth::authorize_shoo_login(&state, &payload.id_token, &payload.app_origin).await?;
    let session_token = auth::create_session_token(&state.config, &session)?;
    Ok(Json(serde_json::to_value(ok(ShooVerifyResponse {
        session_token,
        session_max_age_seconds: auth::SESSION_MAX_AGE_SECONDS,
        user: session,
    }))?))
}
