use super::*;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use std::env;
use tower::ServiceExt;

use config::test_config;

fn test_state(config: Config) -> AppState {
    AppState {
        config,
        db: PgPoolOptions::new()
            .connect_lazy("postgres://postgres:***@127.0.0.1:5432/macro_tracker")
            .expect("test pool should be created lazily"),
        http: reqwest::Client::new(),
    }
}

fn test_state_with_db(config: Config, db: sqlx::PgPool) -> AppState {
    AppState {
        config,
        db,
        http: reqwest::Client::new(),
    }
}

fn health_request() -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri("/health")
        .body(Body::empty())
        .expect("request should build")
}

fn internal_rpc_request(secret: Option<&str>) -> Request<Body> {
    let mut builder = Request::builder()
        .method("POST")
        .uri("/internal/rpc")
        .header("content-type", "application/json");
    if let Some(secret) = secret {
        builder = builder.header("x-backend-internal-secret", secret);
    }

    builder
        .body(Body::from(r#"{"op":"unknownTestOperation","args":{}}"#))
        .expect("request should build")
}

#[tokio::test]
async fn health_returns_unavailable_when_database_is_not_ready() {
    let mut config = test_config();
    config.database_url = "postgres://postgres:postgres@127.0.0.1:1/macro_tracker".to_string();
    let db = PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(100))
        .connect_lazy(&config.database_url)
        .expect("test pool should be created lazily");
    let response = build_router(test_state_with_db(config, db))
        .oneshot(health_request())
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body should collect")
        .to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).expect("body should be JSON");
    assert_eq!(
        payload,
        serde_json::json!({ "ok": false, "error": "database readiness check failed" })
    );
    assert!(!String::from_utf8_lossy(&body).contains("127.0.0.1"));
}

#[tokio::test]
async fn health_returns_ok_when_database_is_ready() {
    let Ok(database_url) = env::var("TEST_DATABASE_URL").or_else(|_| env::var("DATABASE_URL"))
    else {
        eprintln!("skipping PostgreSQL health test: TEST_DATABASE_URL/DATABASE_URL unavailable");
        return;
    };
    let mut config = test_config();
    config.database_url = database_url.clone();
    let db = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("test database should connect");
    let response = build_router(test_state_with_db(config, db.clone()))
        .oneshot(health_request())
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::OK);
    db.close().await;
}

/// SEC-06.
#[test]
fn insecure_internal_auth_forces_a_loopback_listener() {
    let mut config = test_config();
    config.allow_insecure_internal_auth = true;
    config.app_url = "http://localhost:3000".to_string();
    config.backend_internal_secret = None;

    assert!(config.allows_insecure_internal_auth_for_app_url());
    assert_eq!(listen_address(&config), IpAddr::V4(Ipv4Addr::LOCALHOST));
}

/// SEC-06: the normal, authenticated deployment must stay reachable from
/// outside the container.
#[test]
fn authenticated_backend_listens_on_all_interfaces() {
    assert_eq!(
        listen_address(&test_config()),
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    );

    // The flag alone is not enough: `allows_insecure_internal_auth_for_app_url`
    // is false for a public `APP_URL`, so internal auth is still enforced
    // and restricting the listener would break the deployment for nothing.
    let mut config = test_config();
    config.allow_insecure_internal_auth = true;
    config.app_url = "https://macro.example.com".to_string();

    assert_eq!(listen_address(&config), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
}

#[tokio::test]
async fn internal_rpc_rejects_missing_backend_secret_config() {
    let mut config = test_config();
    config.backend_internal_secret = None;
    let response = build_router(test_state(config))
        .oneshot(internal_rpc_request(None))
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn internal_rpc_rejects_insecure_mode_when_app_url_is_public() {
    let mut config = test_config();
    config.allow_insecure_internal_auth = true;
    config.app_url = "https://macro.example.com".to_string();
    config.backend_internal_secret = None;

    let response = build_router(test_state(config))
        .oneshot(internal_rpc_request(None))
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn internal_rpc_rejects_incorrect_backend_secret() {
    let response = build_router(test_state(test_config()))
        .oneshot(internal_rpc_request(Some("wrong-secret")))
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn internal_rpc_accepts_correct_backend_secret() {
    let response = build_router(test_state(test_config()))
        .oneshot(internal_rpc_request(Some(
            "internal-secret-with-at-least-32-chars",
        )))
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

fn test_op_request(op: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/internal/rpc")
        .header("content-type", "application/json")
        .header(
            "x-backend-internal-secret",
            "internal-secret-with-at-least-32-chars",
        )
        .body(Body::from(format!(
            r#"{{"op":"{op}","args":{{"userId":"11111111-1111-4111-8111-111111111111"}}}}"#
        )))
        .expect("request should build")
}

/// SEC-11: `setUserOnboardingForTesting` was dispatched unconditionally from
/// `db::rpc_json` while its sibling sat behind `enable_test_routes`.
#[tokio::test]
async fn test_only_rpc_ops_are_refused_when_test_routes_are_disabled() {
    for op in ["setUserOnboardingForTesting", "ensureUserRoleForTesting"] {
        let config = test_config();
        assert!(!config.enable_test_routes);

        let response = build_router(test_state(config))
            .oneshot(test_op_request(op))
            .await
            .expect("request should complete");

        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{op}");
    }
}

/// SEC-11: the gate must not break the op when it is legitimately enabled.
/// A missing `onboarded` argument is rejected by `db::rpc_json` itself, so
/// reaching a 400 proves dispatch got past the gate without needing a
/// database.
#[tokio::test]
async fn test_only_onboarding_rpc_still_dispatches_when_test_routes_are_enabled() {
    let mut config = test_config();
    config.enable_test_routes = true;

    let response = build_router(test_state(config))
        .oneshot(test_op_request("setUserOnboardingForTesting"))
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

fn bad_bearer_request(peer: SocketAddr) -> Request<Body> {
    Request::builder()
        .method("GET")
        .uri("/api/v1/me")
        // Well-formed prefix, so `/api/v1` runs the `token_hash` lookup
        // before it can tell the token is worthless. That database hit
        // before any credential check is the whole point of SEC-09.
        .header("authorization", "Bearer mtk_v1_notarealtokenatall")
        .extension(axum::extract::ConnectInfo(peer))
        .body(Body::empty())
        .expect("request should build")
}

/// SEC-09: a burst of unauthenticated `/api/v1` requests must be refused at
/// the edge instead of consuming every connection permit, and `/health` must
/// keep answering while it happens - a 503 there trips the platform's
/// restart policy and turns a load spike into a restart loop.
#[tokio::test]
async fn unauthenticated_api_burst_is_throttled_before_it_can_starve_the_pool() {
    let Ok(database_url) = env::var("TEST_DATABASE_URL").or_else(|_| env::var("DATABASE_URL"))
    else {
        panic!(
            "TEST_DATABASE_URL/DATABASE_URL is required for this test; \
                 see the repository README for the test database setup"
        );
    };
    let mut config = test_config();
    config.database_url = database_url.clone();
    // Two permits, so "the limiter refused it" and "the pool absorbed it"
    // are not the same outcome.
    let db = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(std::time::Duration::from_secs(2))
        .connect(&database_url)
        .await
        .expect("test database should connect");

    const BURST: u32 = 5;
    const REQUESTS: usize = 40;
    // A one-minute replenish period means nothing is refilled mid-test, so
    // exactly `BURST` requests get through - no timing race.
    let router =
        build_router_with_rate_limit(test_state_with_db(config, db.clone()), 60_000, BURST);
    let peer = SocketAddr::from(([203, 0, 113, 7], 51_000));

    let mut statuses = Vec::with_capacity(REQUESTS);
    for _ in 0..REQUESTS {
        let response = router
            .clone()
            .oneshot(bad_bearer_request(peer))
            .await
            .expect("request should complete");
        statuses.push(response.status());
    }

    let throttled = statuses
        .iter()
        .filter(|status| **status == StatusCode::TOO_MANY_REQUESTS)
        .count();
    assert_eq!(
        REQUESTS - throttled,
        BURST as usize,
        "only the burst allowance may reach the database: {statuses:?}"
    );
    // The requests that do get through must reach the `api_tokens` lookup -
    // otherwise the limiter would be bounding a 404 and proving nothing.
    // `db::authenticate_api_token` short-circuits a token without the
    // `mtk_v1_` prefix *before* the query, so anything but a routing error
    // here means the query ran: 401 when the connection's default schema is
    // populated, 500 when it is not (the integration suite builds its schema
    // per test, so the default one is usually empty).
    for status in statuses
        .iter()
        .filter(|status| **status != StatusCode::TOO_MANY_REQUESTS)
    {
        assert!(
            matches!(
                *status,
                StatusCode::UNAUTHORIZED | StatusCode::INTERNAL_SERVER_ERROR
            ),
            "an allowed request must reach the token lookup, got {status}: {statuses:?}"
        );
    }
    assert!(
        !statuses.contains(&StatusCode::NOT_FOUND)
            && !statuses.contains(&StatusCode::METHOD_NOT_ALLOWED),
        "the flood must target a real endpoint: {statuses:?}"
    );

    let health = router
        .clone()
        .oneshot(health_request())
        .await
        .expect("request should complete");
    assert_eq!(
        health.status(),
        StatusCode::OK,
        "/health must stay green through an unauthenticated burst"
    );

    db.close().await;
}

/// SEC-09: the throttled response keeps the documented `/api/v1` envelope
/// rather than the layer's plain-text default.
#[tokio::test]
async fn throttled_api_requests_use_the_documented_error_envelope() {
    // The first request is only there to consume the single burst cell, and
    // it reaches the database. A short acquire timeout keeps it from waiting
    // out the whole `/api/v1` deadline against an unreachable pool.
    let db = PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(100))
        .connect_lazy("postgres://postgres:***@127.0.0.1:1/macro_tracker")
        .expect("test pool should be created lazily");
    let router = build_router_with_rate_limit(test_state_with_db(test_config(), db), 60_000, 1);
    let peer = SocketAddr::from(([203, 0, 113, 8], 51_000));

    let _first = router
        .clone()
        .oneshot(bad_bearer_request(peer))
        .await
        .expect("request should complete");
    let throttled = router
        .oneshot(bad_bearer_request(peer))
        .await
        .expect("request should complete");

    assert_eq!(throttled.status(), StatusCode::TOO_MANY_REQUESTS);
    let body = throttled
        .into_body()
        .collect()
        .await
        .expect("body should collect")
        .to_bytes();
    let payload: serde_json::Value = serde_json::from_slice(&body).expect("body should be JSON");
    assert_eq!(payload["ok"], serde_json::json!(false));
    assert_eq!(payload["error"]["code"], serde_json::json!("rate_limited"));
}

/// SEC-09: `/health` used to run `SELECT 1` per request, so a probe flood
/// could take every permit. Closing the pool after a successful probe proves
/// the next answer came from the cache and not from the database.
#[tokio::test]
async fn health_serves_a_cached_probe_without_touching_the_database() {
    let Ok(database_url) = env::var("TEST_DATABASE_URL").or_else(|_| env::var("DATABASE_URL"))
    else {
        panic!(
            "TEST_DATABASE_URL/DATABASE_URL is required for this test; \
                 see the repository README for the test database setup"
        );
    };
    let mut config = test_config();
    config.database_url = database_url.clone();
    let db = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("test database should connect");
    let router = build_router(test_state_with_db(config, db.clone()));

    let first = router
        .clone()
        .oneshot(health_request())
        .await
        .expect("request should complete");
    assert_eq!(first.status(), StatusCode::OK);

    db.close().await;

    let cached = router
        .oneshot(health_request())
        .await
        .expect("request should complete");
    assert_eq!(
        cached.status(),
        StatusCode::OK,
        "a probe within the cache TTL must not re-query the database"
    );
}
