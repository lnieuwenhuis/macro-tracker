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
    jwk::{AlgorithmParameters, EllipticCurve, JwkSet, KeyAlgorithm},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration as StdDuration, Instant as StdInstant},
};
use subtle::ConstantTimeEq;
use uuid::Uuid;

pub const SESSION_COOKIE_NAME: &str = "mt_session";
pub const SESSION_MAX_AGE_SECONDS: i64 = 60 * 60 * 24 * 7;
const SHOO_JWKS_FETCH_TIMEOUT: StdDuration = StdDuration::from_secs(2);
const SHOO_JWKS_CACHE_TTL: StdDuration = StdDuration::from_secs(5 * 60);
// CLEAN-A2: negative results are cached too, briefly, or a provider outage pays the fetch timeout per login.
const SHOO_JWKS_NEGATIVE_CACHE_TTL: StdDuration = StdDuration::from_secs(10);

#[derive(Clone)]
struct CachedJwks {
    // `None` is a negative entry — the last fetch failed.
    jwks: Option<JwkSet>,
    expires_at: StdInstant,
}

static SHOO_JWKS_CACHE: OnceLock<Mutex<HashMap<String, CachedJwks>>> = OnceLock::new();
// CLEAN-A2: one lock per base URL, so a cold cache during a login burst makes exactly one upstream request.
static SHOO_JWKS_FETCH_LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();

fn shoo_jwks_cache() -> &'static Mutex<HashMap<String, CachedJwks>> {
    SHOO_JWKS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn shoo_jwks_fetch_lock(shoo_base_url: &str) -> Arc<tokio::sync::Mutex<()>> {
    Arc::clone(
        SHOO_JWKS_FETCH_LOCKS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(shoo_base_url.to_string())
            .or_default(),
    )
}

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

// SEC-20: the single message every internal-auth failure returns, whatever the underlying cause.
const INVALID_BACKEND_SECRET: &str = "Invalid backend secret.";

// SEC-17: `subtle` blocks the optimizer from reintroducing an early exit; only length may short-circuit.
fn constant_time_eq_bytes(provided: &[u8], expected: &[u8]) -> bool {
    provided.ct_eq(expected).into()
}

impl FromRequestParts<AppState> for InternalAuth {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> AppResult<Self> {
        let Some(expected) = &state.config.backend_internal_secret else {
            if state.config.allows_insecure_internal_auth_for_app_url() {
                return Ok(Self);
            }
            // SEC-20: the caller learns nothing about why it failed; the distinction goes to the operator's log.
            tracing::error!(
                "refusing internal request: BACKEND_INTERNAL_SECRET is unset and insecure local mode does not apply to this APP_URL"
            );
            return Err(AppError::Unauthorized(INVALID_BACKEND_SECRET.to_string()));
        };
        let provided = parts
            .headers
            .get("x-backend-internal-secret")
            .and_then(|value| value.to_str().ok());
        if provided
            .map(|provided| constant_time_eq_bytes(provided.as_bytes(), expected.as_bytes()))
            .unwrap_or(false)
        {
            Ok(Self)
        } else {
            Err(AppError::Unauthorized(INVALID_BACKEND_SECRET.to_string()))
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
    let user = db::get_user_by_id(&state.db, session.user_id)
        .await?
        .ok_or_else(|| AppError::Unauthorized("Session user no longer exists.".to_string()))?;
    reconcile_configured_owner(&state, user).await
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
    let user = db::upsert_user_from_shoo_profile(&state.db, &profile).await?;
    let user = reconcile_configured_owner(state, user).await?;

    let session = SessionUser {
        user_id: user.id,
        email: user.email.clone(),
    };
    Ok((session, user))
}

// What `ADMIN_OWNER_EMAILS` implies for one account; split out so the policy is unit-testable without a database.
#[derive(Debug, PartialEq, Eq)]
enum ConfiguredOwnerAction {
    /// The address is configured and the account is not an owner yet.
    Promote,
    /// The account holds `owner` but its address is not configured; see `reconcile_configured_owner`.
    ReportUnconfiguredOwner,
    Nothing,
}

fn configured_owner_action(
    admin_owner_emails: &[String],
    email: &str,
    role: &str,
) -> ConfiguredOwnerAction {
    let configured = admin_owner_emails.contains(&email.to_lowercase());
    match (configured, role) {
        (true, "owner") => ConfiguredOwnerAction::Nothing,
        (true, _) => ConfiguredOwnerAction::Promote,
        (false, "owner") => ConfiguredOwnerAction::ReportUnconfiguredOwner,
        (false, _) => ConfiguredOwnerAction::Nothing,
    }
}

// Warned at most once per account per process; this runs on every authenticated request.
static REPORTED_UNCONFIGURED_OWNERS: OnceLock<Mutex<HashSet<Uuid>>> = OnceLock::new();

// SEC-18: promotes but never demotes — `users.role` has no provenance column; revoke through `setUserRole` instead.
pub async fn reconcile_configured_owner(state: &AppState, user: AppUser) -> AppResult<AppUser> {
    match configured_owner_action(&state.config.admin_owner_emails, &user.email, &user.role) {
        ConfiguredOwnerAction::Promote => db::ensure_user_role(&state.db, user.id, "owner").await,
        ConfiguredOwnerAction::ReportUnconfiguredOwner => {
            let first_time = REPORTED_UNCONFIGURED_OWNERS
                .get_or_init(|| Mutex::new(HashSet::new()))
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(user.id);
            if first_time {
                tracing::warn!(
                    user_id = %user.id,
                    "account holds the owner role but its address is not in ADMIN_OWNER_EMAILS; \
                     removing an address from that list does not revoke ownership - demote through \
                     the admin flow if this is unintended"
                );
            }
            Ok(user)
        }
        ConfiguredOwnerAction::Nothing => Ok(user),
    }
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
    let jwks = fetch_shoo_jwks(state).await?;
    let jwk = jwks
        .find(&kid)
        .ok_or_else(|| AppError::Unauthorized("Shoo signing key was not found.".to_string()))?;
    // SEC-19: match on kty/crv, not alg (RFC 7517 makes alg optional) - a symmetric key could otherwise sign logins.
    let is_p256 = match &jwk.algorithm {
        AlgorithmParameters::EllipticCurve(ec) => ec.curve == EllipticCurve::P256,
        _ => false,
    };
    if !is_p256 || matches!(jwk.common.key_algorithm, Some(alg) if alg != KeyAlgorithm::ES256) {
        return Err(AppError::Unauthorized(
            "Shoo signing key is invalid.".to_string(),
        ));
    }
    let key = DecodingKey::from_jwk(jwk)
        .map_err(|_| AppError::Unauthorized("Shoo signing key is invalid.".to_string()))?;
    // SEC-02: pin the algorithm to what Shoo signs with; never derive it from the token's own header.
    let mut validation = Validation::new(Algorithm::ES256);
    validation.set_issuer(&[state.config.shoo_base_url.as_str()]);
    validation.set_audience(&[format!("origin:{app_origin}")]);
    // SEC-02: `set_issuer`/`set_audience` don't require the claim — an absent `iss`/`aud` would otherwise pass.
    validation.set_required_spec_claims(&["exp", "iss", "aud"]);
    let decoded = decode::<ShooClaims>(id_token, &key, &validation)
        .map_err(|_| AppError::Unauthorized("Unable to verify Shoo login.".to_string()))?;

    if decoded.claims.pairwise_sub.trim().is_empty() {
        return Err(AppError::Unauthorized(
            "Shoo token is missing pairwise_sub.".to_string(),
        ));
    }

    Ok(decoded.claims)
}

fn jwks_unreachable() -> AppError {
    AppError::Upstream("Could not reach the identity provider.".to_string())
}

/// Reads the cache without fetching; `Some(Err(..))` is a live negative entry. Recovers from lock poisoning.
fn cached_shoo_jwks(shoo_base_url: &str) -> Option<AppResult<JwkSet>> {
    let now = StdInstant::now();
    let cached = shoo_jwks_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(shoo_base_url)
        .filter(|cached| cached.expires_at > now)
        .cloned()?;

    Some(match cached.jwks {
        Some(jwks) => Ok(jwks),
        None => Err(jwks_unreachable()),
    })
}

fn store_shoo_jwks(shoo_base_url: &str, jwks: Option<JwkSet>) {
    let ttl = if jwks.is_some() {
        SHOO_JWKS_CACHE_TTL
    } else {
        SHOO_JWKS_NEGATIVE_CACHE_TTL
    };
    shoo_jwks_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            shoo_base_url.to_string(),
            CachedJwks {
                jwks,
                expires_at: StdInstant::now() + ttl,
            },
        );
}

async fn fetch_shoo_jwks(state: &AppState) -> AppResult<JwkSet> {
    let shoo_base_url = state.config.shoo_base_url.trim_end_matches('/').to_string();
    if let Some(cached) = cached_shoo_jwks(&shoo_base_url) {
        return cached;
    }

    // CLEAN-A2: single-flight, or a cold cache during a login burst fans out one JWKS request per concurrent login.
    let fetch_lock = shoo_jwks_fetch_lock(&shoo_base_url);
    let _guard = fetch_lock.lock().await;
    // The lock holder just filled the cache (positively or, with the short negative TTL, negatively); do not refetch.
    if let Some(cached) = cached_shoo_jwks(&shoo_base_url) {
        return cached;
    }

    let jwks_url = format!("{shoo_base_url}/.well-known/jwks.json");
    // `reqwest::Error`'s Display embeds the URL, so details go to the log and the caller gets a fixed message.
    let upstream_failure = |error: reqwest::Error| {
        tracing::warn!(error = ?error, "Shoo JWKS fetch failed");
        jwks_unreachable()
    };
    let fetched = async {
        state
            .http
            .get(jwks_url)
            .timeout(SHOO_JWKS_FETCH_TIMEOUT)
            .send()
            .await
            .map_err(upstream_failure)?
            .error_for_status()
            .map_err(upstream_failure)?
            .json::<JwkSet>()
            .await
            .map_err(upstream_failure)
    }
    .await;

    store_shoo_jwks(&shoo_base_url, fetched.as_ref().ok().cloned());
    fetched
}

#[cfg(test)]
mod tests;
