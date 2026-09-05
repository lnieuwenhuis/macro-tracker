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

    let mut values = local_values();
    values.push((ENABLE_TEST_ROUTES_ENV, "true"));
    let config = config_from(&values).expect("config should build");
    assert!(config.enable_test_routes);
}

/// SEC-05.
#[test]
fn backend_test_routes_are_refused_for_a_non_local_app_url() {
    let mut values = production_values();
    values.push((ENABLE_TEST_ROUTES_ENV, "true"));

    let error = config_from(&values).expect_err("test routes must not be enabled for a deployment");

    assert!(
        error
            .to_string()
            .contains("only allowed when APP_URL points to localhost"),
        "unexpected error: {error:#}"
    );
}

/// SEC-05: the Playwright/CI `APP_URL` values must keep working.
#[test]
fn backend_test_routes_are_accepted_for_loopback_app_urls() {
    for app_url in [
        "http://localhost:3000",
        "http://dev.localhost:3000",
        "http://127.0.0.1:3000",
        "http://[::1]:3000",
    ] {
        let mut values = production_values();
        values.retain(|(key, _)| *key != "APP_URL");
        values.push(("APP_URL", app_url));
        values.push((ENABLE_TEST_ROUTES_ENV, "true"));

        let config = config_from(&values)
            .unwrap_or_else(|error| panic!("{app_url} should be accepted: {error:#}"));

        assert!(config.enable_test_routes, "{app_url}");
    }
}

/// SEC-08: the minimum-length check runs on the trimmed secret, not the untrimmed one.
#[test]
fn production_config_measures_secret_length_on_the_trimmed_value() {
    let padded_short = format!("   {}short   ", " ".repeat(40));
    assert!(padded_short.len() > MIN_SECRET_LENGTH);
    for name in ["SESSION_SECRET", "BACKEND_INTERNAL_SECRET"] {
        let mut values = production_values();
        values.retain(|(key, _)| *key != name);
        values.push((name, &padded_short));

        let Err(error) = config_from(&values) else {
            panic!("{name} of only whitespace must be rejected");
        };

        assert!(
            error
                .to_string()
                .contains("must be at least 32 characters long"),
            "unexpected error for {name}: {error:#}"
        );
    }
}

/// SEC-08: mirrors `KNOWN_INSECURE_SESSION_SECRETS` in `apps/web/lib/env.ts`.
#[test]
fn production_config_rejects_committed_development_secrets() {
    for secret in [
        "macro-tracker-dev-session-secret",
        "macro-tracker-local-backend-secret",
        // 35 characters, so a naive length check passes it.
        "change-this-to-a-long-random-string",
        // Padding must not smuggle a blocked value past the check either.
        "  change-this-to-a-long-random-string  ",
    ] {
        for name in ["SESSION_SECRET", "BACKEND_INTERNAL_SECRET"] {
            let mut values = production_values();
            values.retain(|(key, _)| *key != name);
            values.push((name, secret));

            let Err(error) = config_from(&values) else {
                panic!("{name}={secret:?} must be rejected");
            };

            assert!(
                error.to_string().contains(
                    "must not use a development or placeholder secret published in this repository"
                ),
                "unexpected error for {name}={secret:?}: {error:#}"
            );
        }
    }
}

/// The CI secret literals (`.github/workflows/ci.yml` lines ~30/32) must stay accepted in every deployment shape.
#[test]
fn production_config_accepts_ci_secret_literals() {
    for secret in [
        "macro-tracker-ci-session-secret-32-chars",
        "macro-tracker-ci-backend-secret-32-chars",
    ] {
        for name in ["SESSION_SECRET", "BACKEND_INTERNAL_SECRET"] {
            let mut values = production_values();
            values.retain(|(key, _)| *key != name);
            values.push((name, secret));

            assert!(
                config_from(&values).is_ok(),
                "{name}={secret:?} must be accepted for CI"
            );
        }
    }
}

#[test]
fn postgres_pool_defaults_above_the_unauthenticated_request_burst() {
    let config = config_from(&production_values()).expect("config should build");

    assert_eq!(config.postgres_pool_max, 10);
}

/// `production_values` with the loopback `APP_URL` a local or CI backend actually runs on.
fn local_values() -> Vec<(&'static str, &'static str)> {
    let mut values = production_values();
    values.retain(|(key, _)| *key != "APP_URL");
    values.push(("APP_URL", "http://localhost:3000"));
    values
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
    assert!(config.ai_gateway_model_timeout_ms.is_none());
}

#[test]
fn production_config_requires_core_keys() {
    for key in ["APP_URL", "SESSION_SECRET", "BACKEND_INTERNAL_SECRET"] {
        let values = production_values()
            .into_iter()
            .filter(|(candidate, _)| *candidate != key)
            .collect::<Vec<_>>();

        let error = config_from(&values).expect_err("{key} should be required");

        assert!(
            error.to_string().contains(&format!("{key} is required")),
            "unexpected error for {key}: {error:#}"
        );
    }
}

#[test]
fn production_config_rejects_local_session_default() {
    let mut values = production_values();
    values.retain(|(key, _)| *key != "SESSION_SECRET");
    values.push(("SESSION_SECRET", LOCAL_SESSION_SECRET));

    let error = config_from(&values).expect_err("local default should be rejected");

    assert!(
        error.to_string().contains(
            "must not use a development or placeholder secret published in this repository"
        ),
        "unexpected error: {error:#}"
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
                postgres_ssl_mode_for_url(&url::Url::parse(&config.database_url).unwrap()).unwrap()
            ),
            "Disable",
            "local URL should disable TLS: {database_url}"
        );
    }
}

#[test]
fn remote_postgres_database_url_sslmode_selects_tls_mode() {
    for (suffix, expected) in [
        ("", "VerifyFull"),
        ("?sslmode=verify-full", "VerifyFull"),
        ("?sslmode=require", "Require"),
    ] {
        let mut values = production_values();
        values.retain(|(key, _)| *key != "DATABASE_URL");
        let database_url =
            format!("postgres://postgres:***@db.example.com:5432/macro_tracker{suffix}");
        values.push(("DATABASE_URL", &database_url));

        let config = config_from(&values).expect("remote postgres URL should be accepted");

        assert_eq!(
            format!(
                "{:?}",
                postgres_ssl_mode_for_url(&url::Url::parse(&config.database_url).unwrap()).unwrap()
            ),
            expected,
            "unexpected TLS mode for suffix {suffix:?}"
        );
    }
}

#[test]
fn remote_postgres_database_url_rejects_insecure_sslmodes() {
    for sslmode in ["disable", "allow", "prefer", "no-verify"] {
        let mut values = production_values();
        values.retain(|(key, _)| *key != "DATABASE_URL");
        let database_url =
            format!("postgres://postgres:***@db.example.com:5432/macro_tracker?sslmode={sslmode}");
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
