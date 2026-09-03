use super::bad_request_message;
use crate::db::api_tokens::{normalize_api_token_expiry, normalize_api_token_scopes};
use chrono::Utc;
use serde_json::{Value, json};

#[test]
fn api_token_scope_validation_rejects_empty_unknown_and_non_string_scopes() {
    for (input, message) in [
        (json!([]), "API token must include at least one scope."),
        (
            json!(["read:daily", "admin:*"]),
            "API token scope is invalid.",
        ),
        (json!(["read:daily", 42]), "API token scope is invalid."),
    ] {
        assert_eq!(
            bad_request_message(normalize_api_token_scopes(Some(&input))),
            message
        );
    }
}

#[test]
fn api_token_scope_validation_dedupes_valid_scopes_in_order() {
    let scopes =
        normalize_api_token_scopes(Some(&json!(["read:daily", "write:daily", "read:daily"])))
            .expect("valid scopes should normalize");

    assert_eq!(scopes, vec!["read:daily", "write:daily"]);
}

#[test]
fn api_token_expiry_validation_preserves_defaults_and_nulls() {
    let default = normalize_api_token_expiry(None)
        .expect("missing expiry should default")
        .expect("default expiry should be set");
    let days = default.signed_duration_since(Utc::now()).num_days();
    assert!((89..=90).contains(&days));

    assert!(
        normalize_api_token_expiry(Some(&Value::Null))
            .expect("null expiry should be accepted")
            .is_none()
    );
}

#[test]
fn api_token_expiry_validation_rejects_invalid_strings() {
    assert_eq!(
        bad_request_message(normalize_api_token_expiry(Some(&json!("not-a-date")))),
        "API token expiry is invalid."
    );
}
