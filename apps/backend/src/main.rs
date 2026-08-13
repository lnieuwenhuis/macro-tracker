mod api;
mod auth;
mod config;
mod db;
mod errors;
mod legacy_api;
mod routes;
mod types;

use anyhow::Context;
use axum::Router;
use config::Config;
use sqlx::postgres::PgPoolOptions;
use tokio::net::TcpListener;
use tower_http::{timeout::TimeoutLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: sqlx::PgPool,
    pub http: reqwest::Client,
}

/// Ceiling for any outbound request that does not set its own deadline.
///
/// `tokio::time::timeout(.., send())` only bounds the *headers*; the body read
/// that follows had no deadline at all, so a provider that answered and then
/// stalled pinned the handler indefinitely. `Client::timeout` covers the whole
/// exchange, and per-request `RequestBuilder::timeout` still overrides it where
/// a longer budget is intended (the AI paths).
const HTTP_CLIENT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const HTTP_CLIENT_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

pub fn build_http_client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(HTTP_CLIENT_TIMEOUT)
        .connect_timeout(HTTP_CLIENT_CONNECT_TIMEOUT)
        .build()
}

/// Applied to the data routes. The AI routes are deliberately excluded — they
/// carry their own (much longer) deadlines and semaphores.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const POSTGRES_ACQUIRE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

fn build_router(state: AppState) -> Router {
    Router::new()
        .nest("/api/v1", api::router())
        .nest("/internal", routes::internal_router())
        .route("/health", axum::routing::get(routes::health))
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::GATEWAY_TIMEOUT,
            REQUEST_TIMEOUT,
        ))
        .merge(legacy_api::router())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "macro_tracker_backend=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Config::from_env()?;
    let db = PgPoolOptions::new()
        .max_connections(config.postgres_pool_max)
        // Below the request timeout layer, so a starved pool surfaces as a
        // fast 500 rather than queueing behind sqlx's 30s default while the
        // proxy in front has already given up.
        .acquire_timeout(POSTGRES_ACQUIRE_TIMEOUT)
        .connect_with(config.postgres_connect_options()?)
        .await
        .context("failed to connect to PostgreSQL")?;

    db::verify_schema_ready(&db)
        .await
        .context("failed to verify database migrations")?;

    let state = AppState {
        config: config.clone(),
        db,
        http: build_http_client().context("failed to build the outbound HTTP client")?,
    };
    let listener = TcpListener::bind(("0.0.0.0", config.port))
        .await
        .with_context(|| format!("failed to bind backend port {}", config.port))?;

    tracing::info!(port = config.port, "macro tracker backend listening");
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use std::env;
    use tower::ServiceExt;

    fn test_config() -> Config {
        Config {
            allow_insecure_internal_auth: false,
            enable_test_routes: false,
            app_url: "http://localhost:3000".to_string(),
            backend_internal_secret: Some("internal-secret-with-at-least-32-chars".to_string()),
            database_url: "postgres://postgres:postgres@127.0.0.1:5432/macro_tracker".to_string(),
            port: 4000,
            postgres_pool_max: 1,
            session_secret: "session-secret-with-at-least-32-chars".to_string(),
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
        let payload: serde_json::Value =
            serde_json::from_slice(&body).expect("body should be JSON");
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
            eprintln!(
                "skipping PostgreSQL health test: TEST_DATABASE_URL/DATABASE_URL unavailable"
            );
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
}
