use crate::{
    AppState, db,
    errors::{AppError, AppResult},
    types::{AppUser, SessionUser, ShooProfile},
};
use axum::{
    extract::{FromRequestParts, State},
    http::{HeaderMap, request::Parts},
};
use chrono::{Duration, Utc};
use jsonwebtoken::{
    Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, decode_header, encode,
    jwk::JwkSet,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const SESSION_COOKIE_NAME: &str = "mt_session";
pub const SESSION_MAX_AGE_SECONDS: i64 = 60 * 60 * 24 * 7;

fn install_crypto_provider() {
    let _ = jsonwebtoken::crypto::aws_lc::DEFAULT_PROVIDER.install_default();
}

#[derive(Debug, Serialize, Deserialize)]
struct SessionClaims {
    sub: String,
    email: String,
    #[serde(rename = "type")]
    claim_type: String,
    exp: usize,
    iat: usize,
}

#[derive(Debug, Deserialize)]
struct ShooClaims {
    pairwise_sub: String,
    email: Option<String>,
    name: Option<String>,
    picture: Option<String>,
}

#[derive(Debug)]
pub struct InternalAuth;

impl FromRequestParts<AppState> for InternalAuth {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> AppResult<Self> {
        let Some(expected) = &state.config.backend_internal_secret else {
            if state.config.allows_insecure_internal_auth_for_app_url() {
                return Ok(Self);
            }
            return Err(AppError::Unauthorized(
                "Backend internal secret is not configured.".to_string(),
            ));
        };
        let provided = parts
            .headers
            .get("x-backend-internal-secret")
            .and_then(|value| value.to_str().ok());
        if provided == Some(expected.as_str()) {
            Ok(Self)
        } else {
            Err(AppError::Unauthorized(
                "Invalid backend secret.".to_string(),
            ))
        }
    }
}

pub fn create_session_token(
    config: &crate::config::Config,
    user: &SessionUser,
) -> AppResult<String> {
    install_crypto_provider();
    let now = Utc::now();
    let claims = SessionClaims {
        sub: user.user_id.to_string(),
        email: user.email.clone(),
        claim_type: "mt_session".to_string(),
        iat: now.timestamp() as usize,
        exp: (now + Duration::seconds(SESSION_MAX_AGE_SECONDS)).timestamp() as usize,
    };

    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(config.session_secret.as_bytes()),
    )
    .map_err(|error| AppError::Anyhow(error.into()))
}

pub fn verify_session_token(config: &crate::config::Config, token: &str) -> AppResult<SessionUser> {
    install_crypto_provider();
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_aud = false;
    let decoded = decode::<SessionClaims>(
        token,
        &DecodingKey::from_secret(config.session_secret.as_bytes()),
        &validation,
    )
    .map_err(|_| AppError::Unauthorized("Invalid or expired session.".to_string()))?;

    if decoded.claims.claim_type != "mt_session" {
        return Err(AppError::Unauthorized("Invalid session.".to_string()));
    }

    Ok(SessionUser {
        user_id: Uuid::parse_str(&decoded.claims.sub)
            .map_err(|_| AppError::Unauthorized("Invalid session subject.".to_string()))?,
        email: decoded.claims.email,
    })
}

pub fn session_token_from_headers(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-macro-tracker-session")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .or_else(|| {
            headers
                .get(axum::http::header::COOKIE)
                .and_then(|value| value.to_str().ok())
                .and_then(|cookie| {
                    cookie.split(';').find_map(|part| {
                        let (name, value) = part.trim().split_once('=')?;
                        (name == SESSION_COOKIE_NAME).then(|| value.to_string())
                    })
                })
        })
}

pub async fn current_user_from_headers(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<AppUser> {
    let token = session_token_from_headers(&headers)
        .ok_or_else(|| AppError::Unauthorized("Missing session.".to_string()))?;
    let session = verify_session_token(&state.config, &token)?;
    let mut user = db::get_user_by_id(&state.db, session.user_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("Session user no longer exists.".to_string()))?;

    if state
        .config
        .admin_owner_emails
        .iter()
        .any(|email| email == &user.email.to_lowercase())
        && user.role != "owner"
    {
        user = db::ensure_user_role(&state.db, user.id, "owner").await?;
    }

    Ok(user)
}

pub async fn authorize_shoo_login(
    state: &AppState,
    id_token: &str,
    app_origin: &str,
) -> AppResult<(SessionUser, AppUser)> {
    let claims = verify_shoo_token(state, id_token, app_origin).await?;
    let email = claims
        .email
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            AppError::BadRequest("Shoo token did not include an email address.".to_string())
        })?
        .to_lowercase();
    let profile = ShooProfile {
        pairwise_sub: claims.pairwise_sub,
        email,
        display_name: claims.name,
        picture_url: claims.picture,
    };
    let mut user = db::upsert_user_from_shoo_profile(&state.db, &profile).await?;

    if state
        .config
        .admin_owner_emails
        .iter()
        .any(|email| email == &user.email.to_lowercase())
        && user.role != "owner"
    {
        user = db::ensure_user_role(&state.db, user.id, "owner").await?;
    }

    let session = SessionUser {
        user_id: user.id,
        email: user.email.clone(),
    };
    Ok((session, user))
}

async fn verify_shoo_token(
    state: &AppState,
    id_token: &str,
    app_origin: &str,
) -> AppResult<ShooClaims> {
    install_crypto_provider();
    let header = decode_header(id_token)
        .map_err(|_| AppError::Unauthorized("Invalid Shoo token.".to_string()))?;
    let kid = header
        .kid
        .ok_or_else(|| AppError::Unauthorized("Shoo token is missing kid.".to_string()))?;
    let jwks_url = format!(
        "{}/.well-known/jwks.json",
        state.config.shoo_base_url.trim_end_matches('/')
    );
    let jwks = state
        .http
        .get(jwks_url)
        .send()
        .await
        .map_err(|error| AppError::Upstream(error.to_string()))?
        .error_for_status()
        .map_err(|error| AppError::Upstream(error.to_string()))?
        .json::<JwkSet>()
        .await
        .map_err(|error| AppError::Upstream(error.to_string()))?;
    let jwk = jwks
        .find(&kid)
        .ok_or_else(|| AppError::Unauthorized("Shoo signing key was not found.".to_string()))?;
    let key = DecodingKey::from_jwk(jwk)
        .map_err(|_| AppError::Unauthorized("Shoo signing key is invalid.".to_string()))?;
    let mut validation = Validation::new(header.alg);
    validation.set_issuer(&[state.config.shoo_base_url.as_str()]);
    validation.set_audience(&[format!("origin:{app_origin}")]);
    let decoded = decode::<ShooClaims>(id_token, &key, &validation)
        .map_err(|_| AppError::Unauthorized("Unable to verify Shoo login.".to_string()))?;

    if decoded.claims.pairwise_sub.trim().is_empty() {
        return Err(AppError::Unauthorized(
            "Shoo token is missing pairwise_sub.".to_string(),
        ));
    }

    Ok(decoded.claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config(session_secret: &str) -> crate::config::Config {
        crate::config::Config {
            allow_insecure_internal_auth: false,
            app_url: "http://localhost:3000".to_string(),
            backend_internal_secret: Some("internal-secret-with-at-least-32-chars".to_string()),
            database_url: "postgres://postgres:***@127.0.0.1:5432/macro_tracker".to_string(),
            port: 4000,
            postgres_pool_max: 1,
            session_secret: session_secret.to_string(),
            shoo_base_url: "https://shoo.dev".to_string(),
            trusted_origins: vec!["http://localhost:3000".to_string()],
            admin_owner_emails: vec![],
            openrouter_api_key: None,
            openrouter_model: None,
            openrouter_fallback_models: None,
            openrouter_model_timeout_ms: None,
            open_food_facts_base_url: "https://world.openfoodfacts.org".to_string(),
            albert_heijn_base_url: "https://api.ah.nl".to_string(),
            jumbo_base_url: "https://mobileapi.jumbo.com".to_string(),
        }
    }

    #[test]
    fn session_tokens_use_exact_secret_bytes_with_whitespace() {
        let secret = "  whitespace-session-secret-with-at-least-32-chars  \n";
        let config = test_config(secret);
        let trimmed_config = test_config(secret.trim());
        let user = SessionUser {
            user_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
            email: "coach@example.com".to_string(),
        };

        let token = create_session_token(&config, &user).expect("token should sign");

        let verified = verify_session_token(&config, &token).unwrap();
        assert_eq!(verified.user_id, user.user_id);
        assert_eq!(verified.email, user.email);
        assert!(verify_session_token(&trimmed_config, &token).is_err());
    }
}
