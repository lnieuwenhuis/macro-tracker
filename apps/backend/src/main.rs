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
use axum::{
    Router,
    extract::State,
    http::{HeaderMap, Request, header},
};
use config::Config;
use sha2::{Digest, Sha256};
use sqlx::postgres::PgPoolOptions;
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
};
use tokio::net::TcpListener;
use tower_governor::{
    GovernorLayer,
    errors::GovernorError,
    governor::GovernorConfigBuilder,
    key_extractor::{GlobalKeyExtractor, KeyExtractor, PeerIpKeyExtractor},
};
use tower_http::{timeout::TimeoutLayer, trace::TraceLayer};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
pub struct AppState {
    /// Router clones state for request handling. Configuration is immutable after startup, so
    /// share it instead of copying its strings and origin lists on every state clone.
    pub config: Arc<Config>,
    pub db: sqlx::PgPool,
    pub http: reqwest::Client,
}

// Bounds headers and body together; a bare `tokio::time::timeout(send())` would only bound the headers.
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

// SEC-09: bounds the per-IP arrival rate at the edge, ahead of the `api_tokens` lookup. Availability, not brute force.
const API_RATE_LIMIT_REPLENISH_MS: u64 = 50;
const API_RATE_LIMIT_BURST: u32 = 100;
// Only reachable via `BACKEND_ENABLE_TEST_ROUTES`, which SEC-05 restricts to a loopback `APP_URL`.
const API_RATE_LIMIT_TEST_BURST: u32 = 100_000;
// Evicts quiet IPs so the rate-limit map cannot grow into its own memory-exhaustion vector.
const API_RATE_LIMIT_GC_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

// SEC-02: per-credential buckets keep one proxied client from starving the others, but a caller
// cycling unique credentials would still get a fresh allowance each time; this is the aggregate ceiling.
const API_RATE_LIMIT_GLOBAL_REPLENISH_MS: u64 = 5;
const API_RATE_LIMIT_GLOBAL_BURST: u32 = 1_000;

// SEC-06: with internal-secret checks disabled, `InternalAuth` accepts requests with no header at all.
fn listen_address(config: &Config) -> IpAddr {
    if config.allows_insecure_internal_auth_for_app_url() {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    } else {
        IpAddr::V4(Ipv4Addr::UNSPECIFIED)
    }
}

// SEC-02: bucket by the credential the caller presents, never by a caller-controlled forwarding header.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum ApiRateLimitKey {
    /// SHA-256 of the presented bearer token; the raw token never enters the limiter map.
    Token([u8; 32]),
    /// Peer address for anonymous traffic, including direct backend access.
    Peer(IpAddr),
}

#[derive(Clone, Copy)]
struct ApiClientKeyExtractor;

impl KeyExtractor for ApiClientKeyExtractor {
    type Key = ApiRateLimitKey;

    fn name(&self) -> &'static str {
        "API client"
    }

    fn extract<T>(&self, request: &Request<T>) -> Result<Self::Key, GovernorError> {
        if let Some(token) = presented_bearer_token(request.headers()) {
            let digest = Sha256::digest(token.as_bytes());
            let mut key = [0_u8; 32];
            key.copy_from_slice(&digest);
            return Ok(ApiRateLimitKey::Token(key));
        }

        // Deliberately ignores X-Forwarded-For/X-Real-IP/Forwarded: behind the Next proxy the peer is
        // the proxy, and anywhere else the headers are caller-controlled.
        PeerIpKeyExtractor
            .extract(request)
            .map(ApiRateLimitKey::Peer)
    }
}

fn presented_bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    let token = token.trim();
    (scheme.eq_ignore_ascii_case("bearer") && !token.is_empty()).then_some(token)
}

// Answers a throttled `/api/v1` request in the same JSON envelope every other `/api/v1` failure uses.
fn rate_limited_response(error: GovernorError) -> axum::response::Response {
    use axum::response::IntoResponse;

    let (status, code, message) = match error {
        GovernorError::TooManyRequests { .. } => (
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Too many requests. Slow down and try again shortly.",
        ),
        // Fail closed: only reachable if the service were ever mounted without connection info.
        _ => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "The request could not be processed.",
        ),
    };

    // API-06: attach CORS headers here too, or a throttled browser client sees a CORS failure instead of a 429.
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
    // `enable_test_routes` is refused for a non-loopback `APP_URL` by SEC-05, so widening the burst behind it is safe.
    let burst = if state.config.enable_test_routes {
        API_RATE_LIMIT_TEST_BURST
    } else {
        API_RATE_LIMIT_BURST
    };
    build_router_with_rate_limit(state, API_RATE_LIMIT_REPLENISH_MS, burst)
}

fn build_router_with_rate_limit(state: AppState, replenish_ms: u64, burst: u32) -> Router {
    let per_client = Arc::new(
        GovernorConfigBuilder::<PeerIpKeyExtractor, _>::default()
            .key_extractor(ApiClientKeyExtractor)
            .per_millisecond(replenish_ms)
            .burst_size(burst)
            .finish()
            .expect("rate-limit period and burst size must both be non-zero"),
    );
    let global = Arc::new(
        GovernorConfigBuilder::<PeerIpKeyExtractor, _>::default()
            .key_extractor(GlobalKeyExtractor)
            .per_millisecond(API_RATE_LIMIT_GLOBAL_REPLENISH_MS)
            .burst_size(API_RATE_LIMIT_GLOBAL_BURST)
            .finish()
            .expect("rate-limit period and burst size must both be non-zero"),
    );
    // The keyed maps never forget on their own; GC them or a source-cycling attacker trades the pool for unbounded memory.
    let per_client_limiter = Arc::clone(&per_client);
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(API_RATE_LIMIT_GC_INTERVAL);
        loop {
            ticker.tick().await;
            per_client_limiter.limiter().retain_recent();
        }
    });
    let global_limiter = Arc::clone(&global);
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(API_RATE_LIMIT_GC_INTERVAL);
        loop {
            ticker.tick().await;
            global_limiter.limiter().retain_recent();
        }
    });
    // One per `build_router` call, so a probe result never leaks between tests.
    let health_cache = Arc::new(routes::HealthCache::default());

    Router::new()
        // SEC-09: scoped to `/api/v1` only — `/health` must answer through a flood and `/internal` is secret-gated.
        .nest(
            "/api/v1",
            api::router()
                // Inner aggregate ceiling: a request over its own bucket is refused before it can
                // consume a global cell, so one client's flood cannot drain the shared allowance.
                .layer(GovernorLayer::new(global).error_handler(rate_limited_response))
                .layer(GovernorLayer::new(per_client).error_handler(rate_limited_response)),
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
        // AI routes carry their own, much longer, deadlines and semaphores, so they stay off this timeout layer.
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
        // Below `REQUEST_TIMEOUT`, so a starved pool fails fast instead of queueing past sqlx's 30s default.
        .acquire_timeout(POSTGRES_ACQUIRE_TIMEOUT)
        .connect_with(config.postgres_connect_options()?)
        .await
        .context("failed to connect to PostgreSQL")?;

    db::verify_schema_ready(&db)
        .await
        .context("failed to verify database migrations")?;

    let address = listen_address(&config);
    let port = config.port;
    let state = AppState {
        config: Arc::new(config),
        db,
        http: build_http_client().context("failed to build the outbound HTTP client")?,
    };
    let listener = TcpListener::bind((address, port))
        .await
        .with_context(|| format!("failed to bind backend port {port}"))?;

    tracing::info!(%address, port, "macro tracker backend listening");
    // The rate limiter keys on `ConnectInfo`; without it every request fails key extraction.
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
