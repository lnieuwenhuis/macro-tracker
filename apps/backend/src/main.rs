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
