use anyhow::{Context, bail};
use sqlx::postgres::{PgConnectOptions, PgSslMode};
use std::env;
use std::net::IpAddr;
use std::str::FromStr;

pub const ALLOW_INSECURE_LOCAL_BACKEND_ENV: &str = "BACKEND_ALLOW_INSECURE_LOCAL";
pub const LOCAL_SESSION_SECRET: &str = "macro-tracker-dev-session-secret";
const MIN_SECRET_LENGTH: usize = 32;

#[derive(Clone, Debug)]
pub struct Config {
    pub allow_insecure_internal_auth: bool,
    pub app_url: String,
    /// Gates the test-only role-assignment RPC. Deliberately its own flag
    /// rather than a build profile, so a debug deploy cannot enable it.
    pub enable_test_routes: bool,
    pub backend_internal_secret: Option<String>,
    pub database_url: String,
    pub port: u16,
    pub postgres_pool_max: u32,
    pub session_secret: String,
    pub shoo_base_url: String,
    pub trusted_origins: Vec<String>,
    pub admin_owner_emails: Vec<String>,
    pub openrouter_api_key: Option<String>,
    pub openrouter_model: Option<String>,
    pub openrouter_fallback_models: Option<String>,
    pub openrouter_model_timeout_ms: Option<u64>,
    pub ai_gateway_url: Option<String>,
    pub ai_gateway_api_key: Option<String>,
    pub ai_gateway_models: Option<String>,
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
            enable_test_routes: parse_env_bool(
                read_value(&mut read, "BACKEND_ENABLE_TEST_ROUTES").as_deref(),
            ),
            backend_internal_secret,
            database_url,
            port: parse_bounded(read_value(&mut read, "PORT"), "PORT", 4000, 1, u16::MAX)?,
            postgres_pool_max: parse_bounded(
                read_value(&mut read, "POSTGRES_POOL_MAX"),
                "POSTGRES_POOL_MAX",
                3,
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
            openrouter_api_key: read_value(&mut read, "OPENROUTER_API_KEY"),
            openrouter_model: read_value(&mut read, "OPENROUTER_MODEL"),
            openrouter_fallback_models: read_value(&mut read, "OPENROUTER_FALLBACK_MODELS"),
            openrouter_model_timeout_ms: match read_value(&mut read, "OPENROUTER_MODEL_TIMEOUT_MS")
            {
                None => None,
                Some(value) => Some(value.parse().with_context(|| {
                    "OPENROUTER_MODEL_TIMEOUT_MS must be a non-negative integer".to_string()
                })?),
            },
            ai_gateway_url: parse_ai_gateway_url(
                read_value(&mut read, "AI_GATEWAY_URL"),
                allow_insecure_local,
            )?,
            ai_gateway_api_key: read_value(&mut read, "AI_GATEWAY_API_KEY"),
            ai_gateway_models: read_value(&mut read, "AI_GATEWAY_MODELS"),
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
    if value == LOCAL_SESSION_SECRET {
        bail!("{name} must not use the local development default secret.");
    }
    if value.len() < MIN_SECRET_LENGTH {
        bail!("{name} must be at least {MIN_SECRET_LENGTH} characters long.");
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

/// Parses a numeric setting, failing loudly instead of silently falling back.
///
/// A typo in `POSTGRES_POOL_MAX` used to collapse to the default, and `=0` to a
/// zero-permit pool where every query 500s after waiting out the acquire
/// timeout.
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

/// Provider base URLs are load-bearing: `SHOO_BASE_URL` is both the JWKS fetch
/// origin and the JWT issuer allowlist, so an `http://` value would silently
/// downgrade login-token verification.
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

/// The AI gateway is the OpenAI-compatible chat-completions endpoint that
/// replaces OpenRouter for food-photo analysis (a CLIProxyAPI service).
/// Railway's private network (`*.railway.internal`) has no TLS, so plain
/// http is only allowed there and on loopback; anything else must be https
/// or the API key would cross the public internet in cleartext.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config_from(values: &[(&str, &str)]) -> anyhow::Result<Config> {
        let env = values
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect::<HashMap<_, _>>();
        Config::from_env_reader(|name| env.get(name).cloned())
    }

    #[test]
    fn numeric_config_fails_loudly_instead_of_silently_defaulting() {
        let mut values = production_values();
        values.push(("POSTGRES_POOL_MAX", "abc"));
        let error = config_from(&values).expect_err("a non-numeric pool max must fail");
        assert!(error.to_string().contains("POSTGRES_POOL_MAX"));

        let mut values = production_values();
        values.push(("POSTGRES_POOL_MAX", "0"));
        let error = config_from(&values).expect_err("a zero-permit pool must fail");
        assert!(error.to_string().contains("between 1"));

        let mut values = production_values();
        values.push(("PORT", "0"));
        assert!(config_from(&values).is_err(), "port 0 must be rejected");
    }

    #[test]
    fn provider_base_urls_must_be_https_outside_local_mode() {
        let mut values = production_values();
        values.push(("SHOO_BASE_URL", "http://shoo.local"));
        let error = config_from(&values).expect_err("an http issuer must fail");
        assert!(error.to_string().contains("SHOO_BASE_URL"));

        let mut values = production_values();
        values.push(("JUMBO_BASE_URL", "not-a-url"));
        assert!(
            config_from(&values).is_err(),
            "a malformed provider URL must be rejected"
        );
    }

    #[test]
    fn backend_test_routes_are_disabled_unless_explicitly_enabled() {
        let config = config_from(&production_values()).expect("config should build");
        assert!(!config.enable_test_routes);

        let mut values = production_values();
        values.push(("BACKEND_ENABLE_TEST_ROUTES", "true"));
        let config = config_from(&values).expect("config should build");
        assert!(config.enable_test_routes);
    }

    fn production_values() -> Vec<(&'static str, &'static str)> {
        vec![
            ("APP_URL", "https://macro.example.com"),
            (
                "DATABASE_URL",
                "postgres://postgres:postgres@127.0.0.1:5432/macro_tracker",
            ),
            ("SESSION_SECRET", "session-secret-with-at-least-32-chars"),
            (
                "BACKEND_INTERNAL_SECRET",
                "internal-secret-with-at-least-32-chars",
            ),
        ]
    }

    #[test]
    fn ai_gateway_url_allows_https_and_railway_private_network_http() {
        let mut values = production_values();
        values.push((
            "AI_GATEWAY_URL",
            "https://gateway.example.com/v1/chat/completions",
        ));
        let config = config_from(&values).expect("https gateway URL should be accepted");
        assert_eq!(
            config.ai_gateway_url.as_deref(),
            Some("https://gateway.example.com/v1/chat/completions")
        );

        let mut values = production_values();
        values.push((
            "AI_GATEWAY_URL",
            "http://cliproxyapi.railway.internal:8317/v1/chat/completions",
        ));
        let config = config_from(&values).expect("Railway private-network http should be accepted");
        assert!(config.ai_gateway_url.is_some());
    }

    #[test]
    fn ai_gateway_url_rejects_public_http() {
        let mut values = production_values();
        values.push((
            "AI_GATEWAY_URL",
            "http://gateway.example.com/v1/chat/completions",
        ));
        let error = config_from(&values).expect_err("public http gateway URL must fail");
        assert!(error.to_string().contains("AI_GATEWAY_URL must use https"));
    }

    #[test]
    fn ai_gateway_is_optional_and_absent_by_default() {
        let config = config_from(&production_values()).expect("config should build");
        assert!(config.ai_gateway_url.is_none());
        assert!(config.ai_gateway_api_key.is_none());
        assert!(config.ai_gateway_models.is_none());
    }

    #[test]
    fn production_config_requires_app_url() {
        let values = production_values()
            .into_iter()
            .filter(|(key, _)| *key != "APP_URL")
            .collect::<Vec<_>>();

        let error = config_from(&values).expect_err("APP_URL should be required");

        assert!(error.to_string().contains("APP_URL is required"));
    }

    #[test]
    fn production_config_requires_session_secret() {
        let values = production_values()
            .into_iter()
            .filter(|(key, _)| *key != "SESSION_SECRET")
            .collect::<Vec<_>>();

        let error = config_from(&values).expect_err("SESSION_SECRET should be required");

        assert!(error.to_string().contains("SESSION_SECRET is required"));
    }

    #[test]
    fn production_config_rejects_local_session_default() {
        let mut values = production_values();
        values.retain(|(key, _)| *key != "SESSION_SECRET");
        values.push(("SESSION_SECRET", LOCAL_SESSION_SECRET));

        let error = config_from(&values).expect_err("local default should be rejected");

        assert!(
            error
                .to_string()
                .contains("must not use the local development default")
        );
    }

    #[test]
    fn production_config_preserves_session_secret_whitespace() {
        let mut values = production_values();
        values.retain(|(key, _)| *key != "SESSION_SECRET");
        values.push((
            "SESSION_SECRET",
            "  session-secret-with-at-least-32-chars  \n",
        ));

        let config = config_from(&values).expect("whitespace is part of the secret bytes");

        assert_eq!(
            config.session_secret,
            "  session-secret-with-at-least-32-chars  \n"
        );
    }

    #[test]
    fn production_config_requires_backend_internal_secret() {
        let values = production_values()
            .into_iter()
            .filter(|(key, _)| *key != "BACKEND_INTERNAL_SECRET")
            .collect::<Vec<_>>();

        let error = config_from(&values).expect_err("BACKEND_INTERNAL_SECRET should be required");

        assert!(
            error
                .to_string()
                .contains("BACKEND_INTERNAL_SECRET is required")
        );
    }

    #[test]
    fn local_postgres_database_urls_disable_tls() {
        for database_url in [
            "postgres://postgres:***@localhost:5432/macro_tracker",
            "postgres://postgres:***@127.0.0.1:5432/macro_tracker",
            "postgres://postgres:***@[::1]:5432/macro_tracker",
        ] {
            let mut values = production_values();
            values.retain(|(key, _)| *key != "DATABASE_URL");
            values.push(("DATABASE_URL", database_url));

            let config = config_from(&values).expect("local postgres URL should be accepted");

            assert_eq!(config.database_url, database_url);
            assert_eq!(
                format!(
                    "{:?}",
                    postgres_ssl_mode_for_url(&url::Url::parse(&config.database_url).unwrap())
                        .unwrap()
                ),
                "Disable",
                "local URL should disable TLS: {database_url}"
            );
        }
    }

    #[test]
    fn remote_postgres_database_url_without_sslmode_uses_verifying_tls() {
        let mut values = production_values();
        values.retain(|(key, _)| *key != "DATABASE_URL");
        values.push((
            "DATABASE_URL",
            "postgres://postgres:***@db.example.com:5432/macro_tracker",
        ));

        let config = config_from(&values).expect("remote postgres URL should be accepted");

        assert_eq!(
            format!(
                "{:?}",
                postgres_ssl_mode_for_url(&url::Url::parse(&config.database_url).unwrap()).unwrap()
            ),
            "VerifyFull"
        );
    }

    #[test]
    fn remote_postgres_database_url_accepts_verify_full_sslmode() {
        let mut values = production_values();
        values.retain(|(key, _)| *key != "DATABASE_URL");
        values.push((
            "DATABASE_URL",
            "postgres://postgres:***@db.example.com:5432/macro_tracker?sslmode=verify-full",
        ));

        let config = config_from(&values).expect("verify-full should be accepted");

        assert_eq!(
            format!(
                "{:?}",
                postgres_ssl_mode_for_url(&url::Url::parse(&config.database_url).unwrap()).unwrap()
            ),
            "VerifyFull"
        );
    }

    #[test]
    fn remote_postgres_database_url_accepts_require_sslmode() {
        let mut values = production_values();
        values.retain(|(key, _)| *key != "DATABASE_URL");
        values.push((
            "DATABASE_URL",
            "postgres://postgres:***@db.example.com:5432/macro_tracker?sslmode=require",
        ));

        let config = config_from(&values).expect("documented require mode should be accepted");

        assert_eq!(
            format!(
                "{:?}",
                postgres_ssl_mode_for_url(&url::Url::parse(&config.database_url).unwrap()).unwrap()
            ),
            "Require"
        );
    }

    #[test]
    fn remote_postgres_database_url_rejects_insecure_sslmodes() {
        for sslmode in ["disable", "allow", "prefer", "no-verify"] {
            let mut values = production_values();
            values.retain(|(key, _)| *key != "DATABASE_URL");
            let database_url = format!(
                "postgres://postgres:***@db.example.com:5432/macro_tracker?sslmode={sslmode}"
            );
            values.push(("DATABASE_URL", &database_url));

            let error = config_from(&values).expect_err("insecure sslmode should be rejected");

            assert!(
                error
                    .to_string()
                    .contains(&format!("insecure sslmode={sslmode}")),
                "unexpected error for sslmode={sslmode}: {error:#}"
            );
        }
    }

    #[test]
    fn non_postgres_database_url_is_rejected_with_clear_error() {
        let mut values = production_values();
        values.retain(|(key, _)| *key != "DATABASE_URL");
        values.push((
            "DATABASE_URL",
            "mysql://user:pass@db.example.com/macro_tracker",
        ));

        let error = config_from(&values).expect_err("non-postgres scheme should be rejected");

        assert!(
            error
                .to_string()
                .contains("DATABASE_URL must use postgres:// or postgresql://"),
            "unexpected error: {error:#}"
        );
    }

    #[test]
    fn pglite_database_url_is_rejected_with_clear_error() {
        for database_url in ["file:./data", "memory:"] {
            let mut values = production_values();
            values.retain(|(key, _)| *key != "DATABASE_URL");
            values.push(("DATABASE_URL", database_url));

            let error = config_from(&values).expect_err("PGlite URL should be rejected");

            assert!(
                error.to_string().contains("not file: or memory"),
                "unexpected error for {database_url}: {error:#}"
            );
        }
    }

    #[test]
    fn explicit_local_mode_allows_dev_defaults() {
        let config = config_from(&[
            (
                "DATABASE_URL",
                "postgres://postgres:postgres@127.0.0.1:5432/macro_tracker",
            ),
            (ALLOW_INSECURE_LOCAL_BACKEND_ENV, "true"),
        ])
        .expect("local mode should allow explicit dev defaults");

        assert!(config.allow_insecure_internal_auth);
        assert!(config.allows_insecure_internal_auth_for_app_url());
        assert_eq!(config.session_secret, LOCAL_SESSION_SECRET);
        assert!(config.backend_internal_secret.is_none());
    }

    #[test]
    fn explicit_local_mode_rejects_public_app_url_without_internal_secret() {
        let error = config_from(&[
            ("APP_URL", "https://macro.example.com"),
            (
                "DATABASE_URL",
                "postgres://postgres:***@127.0.0.1:5432/macro_tracker",
            ),
            (ALLOW_INSECURE_LOCAL_BACKEND_ENV, "true"),
        ])
        .expect_err("insecure local mode must not be allowed for public deployments");

        assert!(
            error
                .to_string()
                .contains("only allowed when APP_URL points to localhost")
        );
    }

    #[test]
    fn local_mode_accepts_loopback_app_urls() {
        for app_url in [
            "http://localhost:3000",
            "http://dev.localhost:3000",
            "http://127.0.0.1:3000",
            "http://[::1]:3000",
        ] {
            let config = config_from(&[
                ("APP_URL", app_url),
                (
                    "DATABASE_URL",
                    "postgres://postgres:***@127.0.0.1:5432/macro_tracker",
                ),
                (ALLOW_INSECURE_LOCAL_BACKEND_ENV, "true"),
            ])
            .expect("loopback app urls should allow local insecure mode");

            assert!(config.allows_insecure_internal_auth_for_app_url());
        }
    }
}
