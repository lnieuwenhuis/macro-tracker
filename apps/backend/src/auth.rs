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
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration as StdDuration, Instant as StdInstant},
};
use uuid::Uuid;

pub const SESSION_COOKIE_NAME: &str = "mt_session";
pub const SESSION_MAX_AGE_SECONDS: i64 = 60 * 60 * 24 * 7;
const SHOO_JWKS_FETCH_TIMEOUT: StdDuration = StdDuration::from_secs(2);
const SHOO_JWKS_CACHE_TTL: StdDuration = StdDuration::from_secs(5 * 60);

#[derive(Clone)]
struct CachedJwks {
    jwks: JwkSet,
    expires_at: StdInstant,
}

static SHOO_JWKS_CACHE: OnceLock<Mutex<HashMap<String, CachedJwks>>> = OnceLock::new();

fn shoo_jwks_cache() -> &'static Mutex<HashMap<String, CachedJwks>> {
    SHOO_JWKS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
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

fn constant_time_eq_bytes(provided: &[u8], expected: &[u8]) -> bool {
    let mut diff = provided.len() ^ expected.len();
    let max_len = provided.len().max(expected.len());

    for index in 0..max_len {
        let provided_byte = provided.get(index).copied().unwrap_or(0);
        let expected_byte = expected.get(index).copied().unwrap_or(0);
        diff |= usize::from(provided_byte ^ expected_byte);
    }

    diff == 0
}

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
        if provided
            .map(|provided| constant_time_eq_bytes(provided.as_bytes(), expected.as_bytes()))
            .unwrap_or(false)
        {
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

pub async fn reconcile_configured_owner(state: &AppState, user: AppUser) -> AppResult<AppUser> {
    if state
        .config
        .admin_owner_emails
        .iter()
        .any(|email| email == &user.email.to_lowercase())
        && user.role != "owner"
    {
        return db::ensure_user_role(&state.db, user.id, "owner").await;
    }
    Ok(user)
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

async fn fetch_shoo_jwks(state: &AppState) -> AppResult<JwkSet> {
    let shoo_base_url = state.config.shoo_base_url.trim_end_matches('/').to_string();
    let now = StdInstant::now();
    // Recover from poisoning rather than propagating it: a panic inside any
    // critical section would otherwise turn a one-off failure into "every
    // login panics forever".
    if let Some(cached) = shoo_jwks_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&shoo_base_url)
        .filter(|cached| cached.expires_at > now)
        .cloned()
    {
        return Ok(cached.jwks);
    }

    let jwks_url = format!("{shoo_base_url}/.well-known/jwks.json");
    // `reqwest::Error`'s Display embeds the request URL, so the details go to
    // the log and the caller gets a fixed message.
    let upstream_failure = |error: reqwest::Error| {
        tracing::warn!(error = ?error, "Shoo JWKS fetch failed");
        AppError::Upstream("Could not reach the identity provider.".to_string())
    };
    let jwks = state
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
        .map_err(upstream_failure)?;

    shoo_jwks_cache()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            shoo_base_url,
            CachedJwks {
                jwks: jwks.clone(),
                expires_at: StdInstant::now() + SHOO_JWKS_CACHE_TTL,
            },
        );

    Ok(jwks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64ct::{Base64UrlUnpadded, Encoding};
    use sqlx::postgres::PgPoolOptions;
    use std::{
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::Instant,
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn test_config(session_secret: &str) -> crate::config::Config {
        crate::config::Config {
            allow_insecure_internal_auth: false,
            enable_test_routes: false,
            app_url: "http://localhost:3000".to_string(),
            backend_internal_secret: Some("internal-secret-with-at-least-32-chars".to_string()),
            database_url: "postgres://postgres:postgres@127.0.0.1:5432/macro_tracker".to_string(),
            port: 4000,
            postgres_pool_max: 1,
            session_secret: session_secret.to_string(),
            shoo_base_url: "https://shoo.dev".to_string(),
            trusted_origins: vec!["http://localhost:3000".to_string()],
            admin_owner_emails: vec![],
            ai_gateway_url: None,
            ai_gateway_api_key: None,
            ai_gateway_models: None,
            ai_gateway_model_timeout_ms: None,
            open_food_facts_base_url: "https://world.openfoodfacts.org".to_string(),
            albert_heijn_base_url: "https://api.ah.nl".to_string(),
            jumbo_base_url: "https://mobileapi.jumbo.com".to_string(),
        }
    }

    fn test_state() -> crate::AppState {
        crate::AppState {
            config: test_config("session-secret-with-at-least-32-chars"),
            db: PgPoolOptions::new()
                .connect_lazy("postgres://postgres:postgres@127.0.0.1:5432/macro_tracker")
                .expect("test pool should be created lazily"),
            http: reqwest::Client::new(),
        }
    }

    async fn authorize_internal_request(secret: Option<&str>) -> AppResult<InternalAuth> {
        let state = test_state();
        let mut builder = axum::http::Request::builder();
        if let Some(secret) = secret {
            builder = builder.header("x-backend-internal-secret", secret);
        }
        let (mut parts, ()) = builder
            .body(())
            .expect("test request should build")
            .into_parts();

        InternalAuth::from_request_parts(&mut parts, &state).await
    }

    fn unsigned_shoo_token_with_kid(kid: &str) -> String {
        let header = serde_json::json!({ "alg": "RS256", "kid": kid, "typ": "JWT" }).to_string();
        let claims = serde_json::json!({ "sub": "unused" }).to_string();
        format!(
            "{}.{}.",
            Base64UrlUnpadded::encode_string(header.as_bytes()),
            Base64UrlUnpadded::encode_string(claims.as_bytes())
        )
    }

    async fn stalled_http_base_url() -> String {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let address = listener.local_addr().expect("listener should have address");
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = [0; 1024];
                let _ = socket.read(&mut buffer).await;
                tokio::time::sleep(StdDuration::from_secs(30)).await;
            }
        });
        format!("http://{address}")
    }

    async fn jwks_base_url(jwks_body: String) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test listener should bind");
        let address = listener.local_addr().expect("listener should have address");
        let request_count = Arc::new(AtomicUsize::new(0));
        let server_count = Arc::clone(&request_count);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                server_count.fetch_add(1, Ordering::SeqCst);
                let mut buffer = [0; 1024];
                let _ = socket.read(&mut buffer).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                    jwks_body.len(),
                    jwks_body
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
        (format!("http://{address}"), request_count)
    }

    fn signed_shoo_token(kid: &str, secret: &[u8], issuer: &str, app_origin: &str) -> String {
        let mut header = Header::new(Algorithm::HS256);
        header.kid = Some(kid.to_string());
        let now = Utc::now();
        let claims = serde_json::json!({
            "iss": issuer,
            "aud": format!("origin:{app_origin}"),
            "exp": (now + Duration::minutes(5)).timestamp(),
            "iat": now.timestamp(),
            "pairwise_sub": "pairwise-test-sub",
            "email": "coach@example.test",
            "name": "Coach Test",
            "picture": null
        });
        encode(&header, &claims, &EncodingKey::from_secret(secret)).expect("test token should sign")
    }

    fn symmetric_jwks(kid: &str, secret: &[u8]) -> String {
        serde_json::json!({
            "keys": [{
                "kty": "oct",
                "kid": kid,
                "alg": "HS256",
                "k": Base64UrlUnpadded::encode_string(secret)
            }]
        })
        .to_string()
    }

    #[tokio::test]
    async fn internal_auth_accepts_correct_backend_secret() {
        let result =
            authorize_internal_request(Some("internal-secret-with-at-least-32-chars")).await;

        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn internal_auth_rejects_incorrect_backend_secret() {
        let error = authorize_internal_request(Some("wrong-secret-with-at-least-32-chars"))
            .await
            .expect_err("incorrect secret should be rejected");

        assert!(matches!(error, AppError::Unauthorized(_)));
    }

    #[tokio::test]
    async fn internal_auth_rejects_missing_backend_secret() {
        let error = authorize_internal_request(None)
            .await
            .expect_err("missing secret should be rejected");

        assert!(matches!(error, AppError::Unauthorized(_)));
    }

    #[tokio::test]
    async fn shoo_jwks_fetch_times_out_instead_of_hanging() {
        let mut config = test_config("session-secret-with-at-least-32-chars");
        config.shoo_base_url = stalled_http_base_url().await;
        let state = crate::AppState {
            config,
            db: PgPoolOptions::new()
                .connect_lazy("postgres://postgres:***@127.0.0.1:5432/macro_tracker")
                .expect("test pool should be created lazily"),
            http: reqwest::Client::new(),
        };
        let started = Instant::now();

        let error = verify_shoo_token(
            &state,
            &unsigned_shoo_token_with_kid("slow-key"),
            "http://localhost:3000",
        )
        .await
        .expect_err("stalled JWKS fetch should fail");

        assert!(started.elapsed() < StdDuration::from_secs(5));
        assert!(matches!(error, AppError::Upstream(_)));
    }

    #[tokio::test]
    async fn shoo_jwks_are_cached_per_base_url() {
        let secret = b"cached-shoo-secret-with-at-least-32-chars";
        let kid = "cached-key";
        let (base_url, request_count) = jwks_base_url(symmetric_jwks(kid, secret)).await;
        let mut config = test_config("session-secret-with-at-least-32-chars");
        config.shoo_base_url = base_url.clone();
        let state = crate::AppState {
            config,
            db: PgPoolOptions::new()
                .connect_lazy("postgres://postgres:***@127.0.0.1:5432/macro_tracker")
                .expect("test pool should be created lazily"),
            http: reqwest::Client::new(),
        };
        let token = signed_shoo_token(kid, secret, &base_url, "http://localhost:3000");

        let first = verify_shoo_token(&state, &token, "http://localhost:3000")
            .await
            .expect("first token verification should succeed");
        let second = verify_shoo_token(&state, &token, "http://localhost:3000")
            .await
            .expect("second token verification should use cached JWKS");

        assert_eq!(first.pairwise_sub, "pairwise-test-sub");
        assert_eq!(second.email.as_deref(), Some("coach@example.test"));
        assert_eq!(request_count.load(Ordering::SeqCst), 1);
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
