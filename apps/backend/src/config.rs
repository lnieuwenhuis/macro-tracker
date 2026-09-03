use anyhow::{Context, bail};
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use std::env;
use std::net::IpAddr;
use std::str::FromStr;

pub const ALLOW_INSECURE_LOCAL_BACKEND_ENV: &str = "BACKEND_ALLOW_INSECURE_LOCAL";
pub const LOCAL_SESSION_SECRET: &str = "macro-tracker-dev-session-secret";
pub const ENABLE_TEST_ROUTES_ENV: &str = "BACKEND_ENABLE_TEST_ROUTES";
const MIN_SECRET_LENGTH: usize = 32;

// SEC-08: secrets published in this repo/docs; `apps/web/lib/env.ts` keeps the same list (one shared HMAC key).
// CI's `macro-tracker-ci-*-secret-32-chars` literals are absent: CI runs loopback with no insecure-local flag.
const KNOWN_INSECURE_SECRETS: &[&str] = &[
    LOCAL_SESSION_SECRET, // also the `playwright.config.ts` session default
    "macro-tracker-local-backend-secret", // the internal-secret default in `apps/web/playwright.config.ts`
    "change-this-to-a-long-random-string", // the README setup placeholder
];

#[derive(Clone, Debug)]
pub struct Config {
    pub allow_insecure_internal_auth: bool,
    pub app_url: String,
    /// Gates test-only RPCs; its own flag rather than a build profile, so a debug deploy cannot enable it.
    pub enable_test_routes: bool,
    pub backend_internal_secret: Option<String>,
    pub database_url: String,
    pub port: u16,
    pub postgres_pool_max: u32,
    pub session_secret: String,
    pub shoo_base_url: String,
    pub trusted_origins: Vec<String>,
    pub admin_owner_emails: Vec<String>,
    pub ai_gateway_url: Option<String>,
    pub ai_gateway_api_key: Option<String>,
    pub ai_gateway_models: Option<String>,
    pub ai_gateway_model_timeout_ms: Option<u64>,
    pub open_food_facts_base_url: String,
    pub albert_heijn_base_url: String,
    pub jumbo_base_url: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        Self::from_env_reader(|name| env::var(name).ok())
    }

    fn from_env_reader<F>(mut read: F) -> anyhow::Result<Self>
    where
        F: FnMut(&str) -> Option<String>,
    {
        let allow_insecure_local =
            parse_env_bool(read_value(&mut read, ALLOW_INSECURE_LOCAL_BACKEND_ENV).as_deref());
        let app_url = read_required(
            &mut read,
            "APP_URL",
            allow_insecure_local.then_some("http://localhost:3000"),
        )?;
        validate_insecure_local_backend_mode(allow_insecure_local, &app_url)?;
        let session_secret = read_secret(
            &mut read,
            "SESSION_SECRET",
            allow_insecure_local.then_some(LOCAL_SESSION_SECRET),
            allow_insecure_local,
        )?;
        let backend_internal_secret = read_value(&mut read, "BACKEND_INTERNAL_SECRET");
        match backend_internal_secret.as_deref() {
            Some(value) => validate_secret("BACKEND_INTERNAL_SECRET", value, allow_insecure_local)?,
            None if allow_insecure_local => {}
            None => bail!(
                "BACKEND_INTERNAL_SECRET is required. Set {ALLOW_INSECURE_LOCAL_BACKEND_ENV}=true only for local test backends."
            ),
        }
        let database_url = read_required(&mut read, "DATABASE_URL", None)?;
        validate_postgres_database_url(&database_url)?;
        let enable_test_routes =
            parse_env_bool(read_value(&mut read, ENABLE_TEST_ROUTES_ENV).as_deref());
        validate_test_routes_mode(enable_test_routes, &app_url)?;

        let app_origin = url::Url::parse(&app_url)
            .context("APP_URL must be a valid URL")?
            .origin()
            .ascii_serialization();
        let mut trusted_origins = vec![app_origin];
        trusted_origins.extend(parse_origin_list(read_value(
            &mut read,
            "APP_TRUSTED_ORIGINS",
        ))?);
        trusted_origins.sort();
        trusted_origins.dedup();

        Ok(Self {
            allow_insecure_internal_auth: allow_insecure_local,
            app_url,
            enable_test_routes,
            backend_internal_secret,
            database_url,
            port: parse_bounded(read_value(&mut read, "PORT"), "PORT", 4000, 1, u16::MAX)?,
            // SEC-09: kept small so a pre-auth request burst cannot starve real traffic behind the 10s acquire timeout.
            postgres_pool_max: parse_bounded(
                read_value(&mut read, "POSTGRES_POOL_MAX"),
                "POSTGRES_POOL_MAX",
                10,
                1,
                256,
            )?,
            session_secret,
            shoo_base_url: parse_https_base_url(
                read_value(&mut read, "SHOO_BASE_URL"),
                "SHOO_BASE_URL",
                "https://shoo.dev",
                allow_insecure_local,
            )?,
            trusted_origins,
            admin_owner_emails: parse_csv_lower(read_value(&mut read, "ADMIN_OWNER_EMAILS")),
            ai_gateway_url: parse_ai_gateway_url(
                read_value(&mut read, "AI_GATEWAY_URL"),
                allow_insecure_local,
            )?,
            ai_gateway_api_key: read_value(&mut read, "AI_GATEWAY_API_KEY"),
            ai_gateway_models: read_value(&mut read, "AI_GATEWAY_MODELS"),
            ai_gateway_model_timeout_ms: match read_value(&mut read, "AI_GATEWAY_MODEL_TIMEOUT_MS")
            {
                None => None,
                Some(value) => Some(value.parse().with_context(|| {
                    "AI_GATEWAY_MODEL_TIMEOUT_MS must be a non-negative integer".to_string()
                })?),
            },
            open_food_facts_base_url: parse_https_base_url(
                read_value(&mut read, "OPEN_FOOD_FACTS_BASE_URL"),
                "OPEN_FOOD_FACTS_BASE_URL",
                "https://world.openfoodfacts.org",
                allow_insecure_local,
            )?,
            albert_heijn_base_url: parse_https_base_url(
                read_value(&mut read, "ALBERT_HEIJN_BASE_URL"),
                "ALBERT_HEIJN_BASE_URL",
                "https://api.ah.nl",
                allow_insecure_local,
            )?,
            jumbo_base_url: parse_https_base_url(
                read_value(&mut read, "JUMBO_BASE_URL"),
                "JUMBO_BASE_URL",
                "https://mobileapi.jumbo.com",
                allow_insecure_local,
            )?,
        })
    }

    pub fn is_trusted_origin(&self, origin: &str) -> bool {
        self.trusted_origins.iter().any(|trusted| trusted == origin)
    }

    pub fn allows_insecure_internal_auth_for_app_url(&self) -> bool {
        self.allow_insecure_internal_auth && is_local_app_url(&self.app_url)
    }

    pub fn postgres_connect_options(&self) -> anyhow::Result<PgConnectOptions> {
        postgres_connect_options_from_url(&self.database_url)
    }
}

fn postgres_connect_options_from_url(database_url: &str) -> anyhow::Result<PgConnectOptions> {
    let url = validate_postgres_database_url(database_url)?;
    let ssl_mode = postgres_ssl_mode_for_url(&url)?;

    PgConnectOptions::from_str(database_url)
        .context("DATABASE_URL must be a valid PostgreSQL connection string")
        .map(|options| options.ssl_mode(ssl_mode))
}

fn validate_postgres_database_url(database_url: &str) -> anyhow::Result<url::Url> {
    if database_url.starts_with("file:") || database_url == "memory:" {
        bail!("Rust backend requires a PostgreSQL DATABASE_URL, not file: or memory:.");
    }

    let url = url::Url::parse(database_url)
        .context("DATABASE_URL must be a valid PostgreSQL connection string")?;
    match url.scheme() {
        "postgres" | "postgresql" => {
            postgres_ssl_mode_for_url(&url)?;
            Ok(url)
        }
        scheme => bail!("DATABASE_URL must use postgres:// or postgresql://, not {scheme}://."),
    }
}

fn postgres_ssl_mode_for_url(url: &url::Url) -> anyhow::Result<PgSslMode> {
    if is_local_database_host(url.host()) {
        return Ok(PgSslMode::Disable);
    }

    let sslmode = url
        .query_pairs()
        .find(|(key, _)| {
            key.eq_ignore_ascii_case("sslmode") || key.eq_ignore_ascii_case("ssl-mode")
        })
        .map(|(_, value)| value.to_ascii_lowercase());

    match sslmode.as_deref() {
        None => Ok(PgSslMode::VerifyFull),
        Some("verify-full") => Ok(PgSslMode::VerifyFull),
        Some("require") => Ok(PgSslMode::Require),
        Some(value @ ("disable" | "allow" | "prefer" | "no-verify")) => {
            bail!("Remote PostgreSQL DATABASE_URL cannot use insecure sslmode={value}.")
        }
        Some(value) => bail!("Remote PostgreSQL DATABASE_URL has unsupported sslmode={value}."),
    }
}

fn is_local_database_host(host: Option<url::Host<&str>>) -> bool {
    match host {
        Some(url::Host::Domain(host)) => {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        }
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn validate_insecure_local_backend_mode(
    allow_insecure_local: bool,
    app_url: &str,
) -> anyhow::Result<()> {
    if allow_insecure_local && !is_local_app_url(app_url) {
        bail!(
            "{ALLOW_INSECURE_LOCAL_BACKEND_ENV}=true is only allowed when APP_URL points to localhost or a loopback address."
        );
    }
    Ok(())
}

fn is_local_app_url(app_url: &str) -> bool {
    let Ok(url) = url::Url::parse(app_url) else {
        return false;
    };
    match url.host() {
        Some(url::Host::Domain(host)) => host == "localhost" || host.ends_with(".localhost"),
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn read_value<F>(read: &mut F, name: &str) -> Option<String>
where
    F: FnMut(&str) -> Option<String>,
{
    read(name).map(|value| value.trim().to_string())
}

fn read_required<F>(read: &mut F, name: &str, fallback: Option<&str>) -> anyhow::Result<String>
where
    F: FnMut(&str) -> Option<String>,
{
    match read_value(read, name).or_else(|| fallback.map(str::to_string)) {
        Some(value) if !value.trim().is_empty() => Ok(value),
        _ => bail!("{name} is required."),
    }
}

fn read_secret<F>(
    read: &mut F,
    name: &str,
    fallback: Option<&str>,
    allow_insecure_local: bool,
) -> anyhow::Result<String>
where
    F: FnMut(&str) -> Option<String>,
{
    let value = match read(name).or_else(|| fallback.map(str::to_string)) {
        Some(value) if !value.trim().is_empty() => value,
        _ => bail!("{name} is required."),
    };
    validate_secret(name, &value, allow_insecure_local)?;
    Ok(value)
}

fn validate_secret(name: &str, value: &str, allow_insecure_local: bool) -> anyhow::Result<()> {
    if allow_insecure_local {
        return Ok(());
    }
    // SEC-08: only the check trims, so 32 spaces cannot pass; the untrimmed value is what gets signed with.
    let trimmed = value.trim();
    if KNOWN_INSECURE_SECRETS.contains(&trimmed) {
        bail!(
            "{name} must not use a development or placeholder secret published in this repository. Generate one with `openssl rand -base64 48`."
        );
    }
    if trimmed.len() < MIN_SECRET_LENGTH {
        bail!("{name} must be at least {MIN_SECRET_LENGTH} characters long.");
    }
    Ok(())
}

// SEC-05: `ensureUserRoleForTesting` has none of the admin path's guards; loopback-only, like the insecure-local flag.
fn validate_test_routes_mode(enable_test_routes: bool, app_url: &str) -> anyhow::Result<()> {
    if enable_test_routes && !is_local_app_url(app_url) {
        bail!(
            "{ENABLE_TEST_ROUTES_ENV}=true is only allowed when APP_URL points to localhost or a loopback address."
        );
    }
    Ok(())
}

fn parse_env_bool(value: Option<&str>) -> bool {
    matches!(
        value.map(|item| item.trim().to_ascii_lowercase()),
        Some(value) if matches!(value.as_str(), "1" | "true" | "yes" | "on")
    )
}

fn parse_csv_lower(value: Option<String>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split(',')
        .map(|item| item.trim().to_lowercase())
        .filter(|item| !item.is_empty())
        .collect()
}

/// Parses a numeric setting, failing loudly instead of silently falling back to `default`.
fn parse_bounded<T>(
    value: Option<String>,
    name: &str,
    default: T,
    min: T,
    max: T,
) -> anyhow::Result<T>
where
    T: FromStr + PartialOrd + std::fmt::Display + Copy,
    <T as FromStr>::Err: std::fmt::Display,
{
    let Some(raw) = value else {
        return Ok(default);
    };

    let parsed: T = raw
        .trim()
        .parse()
        .map_err(|error| anyhow::anyhow!("{name} must be a number: {error}"))?;

    if parsed < min || parsed > max {
        bail!("{name} must be between {min} and {max}, got {parsed}");
    }

    Ok(parsed)
}

/// `SHOO_BASE_URL` is both the JWKS origin and the JWT issuer allowlist; `http://` would downgrade login verification.
fn parse_https_base_url(
    value: Option<String>,
    name: &str,
    default: &str,
    allow_insecure_local: bool,
) -> anyhow::Result<String> {
    let raw = value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string());

    let parsed = url::Url::parse(&raw).with_context(|| format!("{name} must be a valid URL"))?;

    match parsed.scheme() {
        "https" => {}
        "http" if allow_insecure_local => {}
        "http" => bail!(
            "{name} must use https. Set {ALLOW_INSECURE_LOCAL_BACKEND_ENV}=true only for local test backends."
        ),
        scheme => bail!("{name} must use http or https, got {scheme}"),
    }

    if !parsed.has_host() {
        bail!("{name} must include a host");
    }

    Ok(raw)
}

/// Railway's private network (`*.railway.internal`) has no TLS, so plain http is only allowed there and on loopback.
fn parse_ai_gateway_url(
    value: Option<String>,
    allow_insecure_local: bool,
) -> anyhow::Result<Option<String>> {
    let Some(raw) = value.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    let parsed =
        url::Url::parse(&raw).context("AI_GATEWAY_URL must be a valid chat-completions URL")?;
    if !parsed.has_host() {
        bail!("AI_GATEWAY_URL must include a host");
    }

    match parsed.scheme() {
        "https" => {}
        "http" if allow_insecure_local || is_private_gateway_host(parsed.host()) => {}
        "http" => bail!(
            "AI_GATEWAY_URL must use https unless the host is loopback or on the Railway private network (*.railway.internal)."
        ),
        scheme => bail!("AI_GATEWAY_URL must use http or https, got {scheme}"),
    }

    Ok(Some(raw))
}

fn is_private_gateway_host(host: Option<url::Host<&str>>) -> bool {
    match host {
        Some(url::Host::Domain(host)) => {
            host.eq_ignore_ascii_case("localhost")
                || host.to_ascii_lowercase().ends_with(".railway.internal")
        }
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn parse_origin_list(value: Option<String>) -> anyhow::Result<Vec<String>> {
    value
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| {
            Ok(url::Url::parse(item)
                .with_context(|| format!("invalid origin URL: {item}"))?
                .origin()
                .ascii_serialization())
        })
        .collect()
}

/// A fully-populated, valid `Config` for tests; callers overwrite whichever fields they care about.
#[cfg(test)]
pub(crate) fn test_config() -> Config {
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
        ai_gateway_url: None,
        ai_gateway_api_key: None,
        ai_gateway_models: None,
        ai_gateway_model_timeout_ms: None,
        open_food_facts_base_url: "https://world.openfoodfacts.org".to_string(),
        albert_heijn_base_url: "https://api.ah.nl".to_string(),
        jumbo_base_url: "https://mobileapi.jumbo.com".to_string(),
    }
}

#[cfg(test)]
mod tests;
