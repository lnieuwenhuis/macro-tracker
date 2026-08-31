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
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex as TokioMutex;

pub fn internal_router() -> Router<AppState> {
    Router::new()
        .route("/rpc", post(internal_rpc))
        .route("/session/current", get(current_session))
        .route("/auth/shoo/verify", post(verify_shoo))
}

/// SEC-09: `/health` is unauthenticated and used to run `SELECT 1` per request,
/// so a flood of probes could take every connection permit and starve real
/// traffic — which then made `/health` itself 503 and tripped the platform's
/// restart policy, turning a load spike into a restart loop.
///
/// The readiness signal is still real, just sampled: one probe per
/// `HEALTH_CACHE_TTL` at most, shared by all concurrent callers.
const HEALTH_CACHE_TTL: Duration = Duration::from_secs(1);

#[derive(Default)]
pub struct HealthCache {
    last: TokioMutex<Option<(Instant, bool)>>,
}

impl HealthCache {
    async fn database_is_ready(&self, db: &sqlx::PgPool) -> bool {
        // Held across the probe so a burst collapses into a single query
        // instead of one per request.
        let mut last = self.last.lock().await;
        if let Some((checked_at, ready)) = *last
            && checked_at.elapsed() < HEALTH_CACHE_TTL
        {
            return ready;
        }

        let ready = match sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(db).await {
            Ok(1) => true,
            Ok(_) => false,
            Err(error) => {
                tracing::warn!(error = ?error, "database readiness check failed");
                false
            }
        };
        *last = Some((Instant::now(), ready));
        ready
    }
}

pub async fn health(
    cache: Arc<HealthCache>,
    State(state): State<AppState>,
) -> (StatusCode, Json<Value>) {
    if cache.database_is_ready(&state.db).await {
        (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "ok": false, "error": "database readiness check failed" })),
        )
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
        // SEC-11: `setUserOnboardingForTesting` is dispatched from
        // `db::rpc_json`, which only sees the pool and so cannot consult
        // `enable_test_routes`. Gating it here refuses it before it reaches that
        // dispatch. It already needs the internal secret, so this is
        // defence-in-depth - but it is the only test-only op that had no
        // server-side switch at all.
        "setUserOnboardingForTesting" => {
            require_test_routes(state)?;
            // Fall through to `db::rpc_json`, which owns the implementation.
            Ok(None)
        }
        "ensureUserRoleForTesting" => {
            require_test_routes(state)?;
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

fn require_test_routes(state: &AppState) -> AppResult<()> {
    if state.config.enable_test_routes {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "Test routes are not enabled on this backend.".to_string(),
        ))
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
