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

/// Binds a loopback listener that answers every connection with `response` and counts requests served.
async fn spawn_looping_stub_server(response: String) -> (String, Arc<AtomicUsize>) {
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
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    (format!("http://{address}"), request_count)
}

async fn jwks_base_url(jwks_body: String) -> (String, Arc<AtomicUsize>) {
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
        jwks_body.len(),
        jwks_body
    );
    spawn_looping_stub_server(response).await
}

/// Throwaway P-256 keypair for these tests only; Shoo signs ID tokens with ES256 (see SEC-19).
const TEST_EC_PRIVATE_KEY_PEM: &str = concat!(
    "-----BEGIN PRIVATE KEY-----\n",
    "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgl7f/GjQzI961QUMc\n",
    "9mCHWJo8/lNDAwg3zxZzakX5IbmhRANCAATa0cFohs0y4U+YZ4z04JTsZWB5XQjx\n",
    "hOc/kCgxv30TfZ9j0RGhSh2nw1h0n4dDKoIm/1HmggrwIu2WjiAozhFT\n",
    "-----END PRIVATE KEY-----\n",
);
const TEST_EC_PUBLIC_X: &str = "2tHBaIbNMuFPmGeM9OCU7GVgeV0I8YTnP5AoMb99E30";
const TEST_EC_PUBLIC_Y: &str = "n2PREaFKHafDWHSfh0Mqgib_UeaCCvAi7ZaOICjOEVM";

fn ec_encoding_key() -> EncodingKey {
    EncodingKey::from_ec_pem(TEST_EC_PRIVATE_KEY_PEM.as_bytes()).expect("test EC key should parse")
}

/// Signs a token with the test EC key from a full claim set, so a test can omit a claim to prove it is required.
fn signed_shoo_token_with_claims(kid: &str, claims: serde_json::Value) -> String {
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(kid.to_string());
    encode(&header, &claims, &ec_encoding_key()).expect("test token should sign")
}

fn shoo_claims(issuer: &str, app_origin: &str) -> serde_json::Value {
    let now = Utc::now();
    serde_json::json!({
        "iss": issuer,
        "aud": format!("origin:{app_origin}"),
        "exp": (now + Duration::minutes(5)).timestamp(),
        "iat": now.timestamp(),
        "pairwise_sub": "pairwise-test-sub",
        "email": "coach@example.test",
        "name": "Coach Test",
        "picture": null
    })
}

fn signed_shoo_token(kid: &str, issuer: &str, app_origin: &str) -> String {
    signed_shoo_token_with_claims(kid, shoo_claims(issuer, app_origin))
}

fn ec_jwks(kid: &str) -> String {
    serde_json::json!({
        "keys": [{
            "kty": "EC",
            "crv": "P-256",
            "kid": kid,
            "alg": "ES256",
            "use": "sig",
            "x": TEST_EC_PUBLIC_X,
            "y": TEST_EC_PUBLIC_Y
        }]
    })
    .to_string()
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
    let result = authorize_internal_request(Some("internal-secret-with-at-least-32-chars")).await;

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

/// SEC-20: an unconfigured backend and a wrong secret must be indistinguishable to the caller.
#[tokio::test]
async fn internal_auth_does_not_reveal_that_the_secret_is_unconfigured() {
    let mut config = test_config("session-secret-with-at-least-32-chars");
    config.backend_internal_secret = None;
    let state = crate::AppState {
        config,
        db: PgPoolOptions::new()
            .connect_lazy("postgres://postgres:***@127.0.0.1:5432/macro_tracker")
            .expect("test pool should be created lazily"),
        http: reqwest::Client::new(),
    };
    let (mut parts, ()) = axum::http::Request::builder()
        .body(())
        .expect("test request should build")
        .into_parts();

    let unconfigured = InternalAuth::from_request_parts(&mut parts, &state)
        .await
        .expect_err("an unconfigured backend must still reject");
    let wrong_secret = authorize_internal_request(Some("wrong-secret-with-at-least-32-chars"))
        .await
        .expect_err("a wrong secret must be rejected");

    let AppError::Unauthorized(unconfigured) = unconfigured else {
        panic!("expected an unauthorized rejection");
    };
    let AppError::Unauthorized(wrong_secret) = wrong_secret else {
        panic!("expected an unauthorized rejection");
    };
    assert_eq!(unconfigured, wrong_secret);
    assert_eq!(unconfigured, INVALID_BACKEND_SECRET);
}

/// SEC-17: guards the swap from the hand-rolled loop to `subtle`.
#[test]
fn constant_time_comparison_matches_byte_equality() {
    let secret = b"internal-secret-with-at-least-32-chars";

    assert!(constant_time_eq_bytes(secret, secret));
    assert!(!constant_time_eq_bytes(b"", secret));
    assert!(!constant_time_eq_bytes(secret, b""));
    // Same length, differing only in the last byte: the early-exit case.
    assert!(!constant_time_eq_bytes(
        b"internal-secret-with-at-least-32-charS",
        secret
    ));
    // A prefix must not compare equal.
    assert!(!constant_time_eq_bytes(b"internal-secret", secret));
    assert!(constant_time_eq_bytes(b"", b""));
}

/// SEC-18: promotion is automatic, revocation is not — an admin-granted owner is never demoted.
#[test]
fn configured_owner_policy_promotes_but_never_demotes() {
    let configured = vec!["owner@example.com".to_string()];

    assert_eq!(
        configured_owner_action(&configured, "owner@example.com", "user"),
        ConfiguredOwnerAction::Promote
    );
    // Matching is case-insensitive; `admin_owner_emails` is stored lowercased.
    assert_eq!(
        configured_owner_action(&configured, "Owner@Example.com", "admin"),
        ConfiguredOwnerAction::Promote
    );
    assert_eq!(
        configured_owner_action(&configured, "owner@example.com", "owner"),
        ConfiguredOwnerAction::Nothing
    );
    // Granted via admin flow or left behind by config removal: indistinguishable, so neither is demoted.
    assert_eq!(
        configured_owner_action(&configured, "someone@example.com", "owner"),
        ConfiguredOwnerAction::ReportUnconfiguredOwner
    );
    assert_eq!(
        configured_owner_action(&[], "someone@example.com", "owner"),
        ConfiguredOwnerAction::ReportUnconfiguredOwner
    );
    assert_eq!(
        configured_owner_action(&configured, "someone@example.com", "user"),
        ConfiguredOwnerAction::Nothing
    );
}

#[tokio::test]
async fn shoo_jwks_fetch_times_out_instead_of_hanging() {
    let state = shoo_state_for(&stalled_http_base_url().await);
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
    let kid = "cached-key";
    let (base_url, request_count) = jwks_base_url(ec_jwks(kid)).await;
    let state = shoo_state_for(&base_url);
    let token = signed_shoo_token(kid, &base_url, "http://localhost:3000");

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

/// Like `jwks_base_url`, but every request fails upstream.
async fn failing_jwks_base_url() -> (String, Arc<AtomicUsize>) {
    spawn_looping_stub_server(
        "HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n".to_string(),
    )
    .await
}

fn shoo_state_for(base_url: &str) -> crate::AppState {
    let mut config = test_config("session-secret-with-at-least-32-chars");
    config.shoo_base_url = base_url.to_string();
    crate::AppState {
        config,
        db: PgPoolOptions::new()
            .connect_lazy("postgres://postgres:***@127.0.0.1:5432/macro_tracker")
            .expect("test pool should be created lazily"),
        http: reqwest::Client::new(),
    }
}

/// CLEAN-A2: a cold cache during a login burst must not fan out one JWKS request per concurrent login.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_cold_logins_make_exactly_one_jwks_request() {
    const LOGINS: usize = 8;
    let kid = "single-flight-key";
    let (base_url, request_count) = jwks_base_url(ec_jwks(kid)).await;
    let state = shoo_state_for(&base_url);
    let token = signed_shoo_token(kid, &base_url, "http://localhost:3000");
    // Releases every task into the cache lookup at once, so an un-deduplicated version really races.
    let start = Arc::new(tokio::sync::Barrier::new(LOGINS));

    let mut handles = Vec::with_capacity(LOGINS);
    for _ in 0..LOGINS {
        let state = state.clone();
        let token = token.clone();
        let start = Arc::clone(&start);
        handles.push(tokio::spawn(async move {
            start.wait().await;
            verify_shoo_token(&state, &token, "http://localhost:3000").await
        }));
    }

    for handle in handles {
        let claims = handle
            .await
            .expect("task should not panic")
            .expect("every concurrent login should verify");
        assert_eq!(claims.pairwise_sub, "pairwise-test-sub");
    }

    assert_eq!(
        request_count.load(Ordering::SeqCst),
        1,
        "concurrent cold logins must share a single upstream JWKS fetch"
    );
}

/// CLEAN-A2: without a negative entry, an identity-provider outage makes every login pay the full fetch timeout again.
#[tokio::test]
async fn failed_jwks_fetches_are_negatively_cached() {
    let kid = "negative-cache-key";
    let (base_url, request_count) = failing_jwks_base_url().await;
    let state = shoo_state_for(&base_url);
    let token = signed_shoo_token(kid, &base_url, "http://localhost:3000");

    for attempt in 0..3 {
        let error = verify_shoo_token(&state, &token, "http://localhost:3000")
            .await
            .expect_err("an unreachable provider must fail the login");
        assert!(matches!(error, AppError::Upstream(_)), "attempt {attempt}");
    }

    assert_eq!(
        request_count.load(Ordering::SeqCst),
        1,
        "a failed fetch must be cached briefly instead of retried per login"
    );
}

/// Builds state whose JWKS endpoint serves `jwks_body`, and returns the issuer the token must claim.
async fn shoo_state_with_jwks(jwks_body: String) -> (crate::AppState, String) {
    let (base_url, _) = jwks_base_url(jwks_body).await;
    let mut config = test_config("session-secret-with-at-least-32-chars");
    config.shoo_base_url = base_url.clone();
    let state = crate::AppState {
        config,
        db: PgPoolOptions::new()
            .connect_lazy("postgres://postgres:***@127.0.0.1:5432/macro_tracker")
            .expect("test pool should be created lazily"),
        http: reqwest::Client::new(),
    };
    (state, base_url)
}

/// SEC-02: a token that omits `aud` or `iss` must not authenticate (same fall-through for both).
#[tokio::test]
async fn shoo_token_without_audience_or_issuer_is_rejected() {
    for (omitted_claim, message) in [
        ("aud", "a token with no aud claim must not authenticate"),
        ("iss", "a token with no iss claim must not authenticate"),
    ] {
        let kid = "es256-key";
        let (state, base_url) = shoo_state_with_jwks(ec_jwks(kid)).await;
        let now = Utc::now();
        let claims = if omitted_claim == "aud" {
            serde_json::json!({
                "iss": base_url,
                "exp": (now + Duration::minutes(5)).timestamp(),
                "iat": now.timestamp(),
                "pairwise_sub": "pairwise-test-sub",
                "email": "coach@example.test"
            })
        } else {
            serde_json::json!({
                "aud": "origin:http://localhost:3000",
                "exp": (now + Duration::minutes(5)).timestamp(),
                "iat": now.timestamp(),
                "pairwise_sub": "pairwise-test-sub",
                "email": "coach@example.test"
            })
        };
        let token = signed_shoo_token_with_claims(kid, claims);

        let error = verify_shoo_token(&state, &token, "http://localhost:3000")
            .await
            .expect_err(message);

        assert!(
            matches!(error, AppError::Unauthorized(_)),
            "omitted {omitted_claim}"
        );
    }
}

/// Guard on the case that always worked, so the required-claims change isn't mistaken for the whole check.
#[tokio::test]
async fn shoo_token_with_wrong_audience_is_rejected() {
    let kid = "es256-key";
    let (state, base_url) = shoo_state_with_jwks(ec_jwks(kid)).await;
    let token = signed_shoo_token(kid, &base_url, "https://evil.example");

    let error = verify_shoo_token(&state, &token, "http://localhost:3000")
        .await
        .expect_err("a token minted for another origin must not authenticate");

    assert!(matches!(error, AppError::Unauthorized(_)));
}

#[tokio::test]
async fn shoo_token_with_correct_issuer_and_audience_is_accepted() {
    let kid = "es256-key";
    let (state, base_url) = shoo_state_with_jwks(ec_jwks(kid)).await;
    let token = signed_shoo_token(kid, &base_url, "http://localhost:3000");

    let claims = verify_shoo_token(&state, &token, "http://localhost:3000")
        .await
        .expect("a well-formed ES256 token should authenticate");

    assert_eq!(claims.pairwise_sub, "pairwise-test-sub");
}

/// A JWK may legitimately omit the optional `alg` member (RFC 7517 §4.4); the key type carries the check instead.
#[tokio::test]
async fn shoo_key_without_alg_member_still_verifies() {
    let kid = "es256-key";
    let jwks = serde_json::json!({
        "keys": [{
            "kty": "EC",
            "crv": "P-256",
            "kid": kid,
            "use": "sig",
            "x": TEST_EC_PUBLIC_X,
            "y": TEST_EC_PUBLIC_Y
        }]
    })
    .to_string();
    let (state, base_url) = shoo_state_with_jwks(jwks).await;
    let token = signed_shoo_token(kid, &base_url, "http://localhost:3000");

    let claims = verify_shoo_token(&state, &token, "http://localhost:3000")
        .await
        .expect("an EC key with no alg member should still verify");

    assert_eq!(claims.pairwise_sub, "pairwise-test-sub");
}

/// SEC-19: a symmetric `oct` JWK must never verify a login (anyone reading the public JWKS could mint one).
#[tokio::test]
async fn symmetric_jwks_key_is_rejected() {
    let secret = b"symmetric-shoo-secret-with-at-least-32-chars";
    let kid = "oct-key";
    let (state, base_url) = shoo_state_with_jwks(symmetric_jwks(kid, secret)).await;
    let mut header = Header::new(Algorithm::HS256);
    header.kid = Some(kid.to_string());
    let token = encode(
        &header,
        &shoo_claims(&base_url, "http://localhost:3000"),
        &EncodingKey::from_secret(secret),
    )
    .expect("test token should sign");

    let error = verify_shoo_token(&state, &token, "http://localhost:3000")
        .await
        .expect_err("a symmetric JWKS key must never verify a login");

    assert!(matches!(error, AppError::Unauthorized(_)));
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
