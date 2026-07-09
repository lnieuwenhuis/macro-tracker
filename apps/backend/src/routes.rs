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

pub async fn health() -> (StatusCode, Json<Value>) {
    (StatusCode::OK, Json(serde_json::json!({ "ok": true })))
}

async fn internal_rpc(
    State(state): State<AppState>,
    _auth: InternalAuth,
    Json(payload): Json<InternalRpcRequest>,
) -> AppResult<Json<Value>> {
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
