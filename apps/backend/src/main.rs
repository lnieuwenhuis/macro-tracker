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
use tower_http::trace::TraceLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: sqlx::PgPool,
    pub http: reqwest::Client,
}

fn build_router(state: AppState) -> Router {
    Router::new()
        .nest("/api/v1", api::router())
        .merge(legacy_api::router())
        .nest("/internal", routes::internal_router())
        .route("/health", axum::routing::get(routes::health))
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
        .connect(&config.database_url)
        .await
        .context("failed to connect to PostgreSQL")?;

    db::bootstrap_schema(&db)
        .await
        .context("failed to bootstrap database schema")?;

    let state = AppState {
        config: config.clone(),
        db,
        http: reqwest::Client::new(),
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
    use tower::ServiceExt;

    fn test_config() -> Config {
        Config {
            allow_insecure_internal_auth: false,
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
                .connect_lazy("postgres://postgres:postgres@127.0.0.1:5432/macro_tracker")
                .expect("test pool should be created lazily"),
            http: reqwest::Client::new(),
        }
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
