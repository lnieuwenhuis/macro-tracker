mod api;
mod auth;
mod config;
mod db;
mod errors;
mod legacy_api;
mod routes;
mod shared;
mod types;

use anyhow::Context;
use axum::{Router, extract::State};
use config::Config;
use sqlx::postgres::PgPoolOptions;
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
};
use tokio::net::TcpListener;
use tower_governor::{
    GovernorLayer, errors::GovernorError, governor::GovernorConfigBuilder,
    key_extractor::PeerIpKeyExtractor,
};
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

/// Applied to the internal RPC and health routes.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const POSTGRES_ACQUIRE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// SEC-09: `/api/v1` looks a bearer token up in `api_tokens` *before* it can
/// know the token is garbage, so the cheapest possible unauthenticated request
/// still costs a connection permit. These bounds sit far below the pool
/// (`POSTGRES_POOL_MAX`, default 10) so a flood is refused at the edge instead
/// of starving authenticated traffic.
///
/// Not brute-force protection — the tokens carry 244 bits of entropy. This is
/// purely about availability.
const API_RATE_LIMIT_REPLENISH_MS: u64 = 50;
const API_RATE_LIMIT_BURST: u32 = 100;
/// Only reachable with `BACKEND_ENABLE_TEST_ROUTES`, which SEC-05 restricts to
/// a loopback `APP_URL`.
const API_RATE_LIMIT_TEST_BURST: u32 = 100_000;
/// Drops rate-limit state for IPs that have gone quiet, so the keyed map cannot
/// grow without bound and become its own memory-exhaustion vector.
const API_RATE_LIMIT_GC_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// SEC-06: when the internal-secret check is disabled, `InternalAuth` returns
/// `Ok` for a request carrying **no header at all** — so `/internal/rpc`
/// (`getUserById`, `createApiToken`, `upsertUserFromShooProfile`, every
/// user-scoped read and write for an arbitrary `userId`) would be wide open to
/// anyone on the same network as the developer. The config already forces a
/// loopback `APP_URL` for that mode; the listener has to agree.
///
/// Pure so it can be tested without opening a socket.
fn listen_address(config: &Config) -> IpAddr {
    if config.allows_insecure_internal_auth_for_app_url() {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    }
}

/// Answers a throttled `/api/v1` request in the same envelope every other
/// `/api/v1` failure uses, rather than the layer's default plain-text body.
fn rate_limited_response(error: GovernorError) -> axum::response::Response {
    use axum::response::IntoResponse;

    let (status, code, message) = match error {
        GovernorError::TooManyRequests { .. } => (
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many requests. Slow down and try again shortly.",
        ),
        // Only reachable if the service is mounted without connection info.
        // Fail closed rather than silently dropping the limit.
        _ => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "The request could not be processed.",
        ),
    };

    // The limiter sits in front of the handler, so without this a throttled
    // browser client sees a CORS failure rather than the 429 - the same defect
    // API-06 fixed for the body-limit and path rejections.
    (
        status,
        api::cors_headers(),
        axum::Json(serde_json::json!({
            "ok": false,
            "error": { "code": code, "message": message }
        })),
    )
        .into_response()
}

fn build_router(state: AppState) -> Router {
    // The request-level suite in `apps/web/tests/unit/api-v1.test.ts` drives
    // hundreds of sequential calls from one address, which is exactly the
    // shape the limiter exists to stop - it cannot tell that traffic from a
    // flood. `enable_test_routes` is the existing "this is a test deployment"
    // switch and SEC-05 refuses it unless `APP_URL` is loopback, so widening
    // the burst behind it cannot loosen a real deployment.
    let burst = if state.config.enable_test_routes {
        API_RATE_LIMIT_TEST_BURST
    } else {
        API_RATE_LIMIT_BURST
    };
    build_router_with_rate_limit(state, API_RATE_LIMIT_REPLENISH_MS, burst)
}

fn build_router_with_rate_limit(state: AppState, replenish_ms: u64, burst: u32) -> Router {
    let governor = Arc::new(
        GovernorConfigBuilder::<PeerIpKeyExtractor, _>::default()
            .per_millisecond(replenish_ms)
            .burst_size(burst)
            .finish()
            .expect("rate-limit period and burst size must both be non-zero"),
    );
    // The limiter keys its state by IP and never forgets on its own, so an
    // attacker cycling source addresses would trade the connection pool for
    // unbounded memory. Every caller of this function is already inside the
    // Tokio runtime; the task ends when that runtime does.
    let governor_limiter = Arc::clone(&governor);
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(API_RATE_LIMIT_GC_INTERVAL);
        loop {
            ticker.tick().await;
            governor_limiter.limiter().retain_recent();
        }
    });
    // Per `build_router` call, so each test gets its own and a probe result
    // never leaks between them.
    let health_cache = Arc::new(routes::HealthCache::default());

    Router::new()
        // `/api/v1` enforces its own deadline inside the handler so a timeout
        // still returns the documented JSON envelope and CORS headers, which a
        // transport-level layer cannot do.
        //
        // SEC-09: the limiter is deliberately scoped to `/api/v1` only.
        // `/health` must keep answering during a flood (a 503 there trips the
        // platform's restart policy), and `/internal` is already secret-gated
        // and served entirely from the web tier's single address, where a
        // per-IP limit would throttle the whole application.
        .nest(
            "/api/v1",
            api::router().layer(GovernorLayer::new(governor).error_handler(rate_limited_response)),
        )
        .merge(
            Router::new()
                .nest("/internal", routes::internal_router())
                .route(
                    "/health",
                    axum::routing::get(move |state: State<AppState>| {
                        let cache = Arc::clone(&health_cache);
                        async move { routes::health(cache, state).await }
                    }),
                )
                .layer(TimeoutLayer::with_status_code(
                    axum::http::StatusCode::GATEWAY_TIMEOUT,
                    REQUEST_TIMEOUT,
                )),
        )
        // The AI routes are deliberately excluded — they carry their own (much
        // longer) deadlines and semaphores.
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
    let address = listen_address(&config);
    let listener = TcpListener::bind((address, config.port))
        .await
        .with_context(|| format!("failed to bind backend port {}", config.port))?;

    tracing::info!(%address, port = config.port, "macro tracker backend listening");
    // `ConnectInfo` is what the rate limiter keys on; without it every request
    // would fail key extraction.
    axum::serve(
        listener,
        build_router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
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
mod tests;
