use anyhow::{Context, bail};
use std::env;

#[derive(Clone)]
pub struct Config {
    pub app_url: String,
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
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let app_url = read_required("APP_URL", Some("http://localhost:3000"))?;
        let session_secret =
            read_required("SESSION_SECRET", Some("macro-tracker-dev-session-secret"))?;
        let database_url = read_required("DATABASE_URL", None)?;
        if database_url.starts_with("file:") || database_url == "memory:" {
            bail!("Rust backend requires a PostgreSQL DATABASE_URL.");
        }

        let app_origin = url::Url::parse(&app_url)
            .context("APP_URL must be a valid URL")?
            .origin()
            .ascii_serialization();
        let mut trusted_origins = vec![app_origin];
        trusted_origins.extend(parse_origin_list(env::var("APP_TRUSTED_ORIGINS").ok())?);
        trusted_origins.sort();
        trusted_origins.dedup();

        Ok(Self {
            app_url,
            backend_internal_secret: env::var("BACKEND_INTERNAL_SECRET").ok(),
            database_url,
            port: env::var("PORT")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(4000),
            postgres_pool_max: env::var("POSTGRES_POOL_MAX")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(3),
            session_secret,
            shoo_base_url: env::var("SHOO_BASE_URL")
                .unwrap_or_else(|_| "https://shoo.dev".to_string()),
            trusted_origins,
            admin_owner_emails: parse_csv_lower(env::var("ADMIN_OWNER_EMAILS").ok()),
            openrouter_api_key: env::var("OPENROUTER_API_KEY").ok(),
            openrouter_model: env::var("OPENROUTER_MODEL").ok(),
            openrouter_fallback_models: env::var("OPENROUTER_FALLBACK_MODELS").ok(),
            openrouter_model_timeout_ms: env::var("OPENROUTER_MODEL_TIMEOUT_MS")
                .ok()
                .and_then(|value| value.parse().ok()),
        })
    }

    pub fn is_trusted_origin(&self, origin: &str) -> bool {
        self.trusted_origins.iter().any(|trusted| trusted == origin)
    }
}

fn read_required(name: &str, fallback: Option<&str>) -> anyhow::Result<String> {
    match env::var(name).ok().or_else(|| fallback.map(str::to_string)) {
        Some(value) if !value.trim().is_empty() => Ok(value),
        _ => bail!("{name} is required."),
    }
}

fn parse_csv_lower(value: Option<String>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split(',')
        .map(|item| item.trim().to_lowercase())
        .filter(|item| !item.is_empty())
        .collect()
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
