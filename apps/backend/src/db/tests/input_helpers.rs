//! Unit tests for the small pure input-normalisation helpers in `db.rs`.

use super::*;

/// A one-entry JSON object, the shape most normalisers receive.
fn field_input(key: &str, value: Value) -> serde_json::Map<String, Value> {
    serde_json::Map::from_iter([(key.to_string(), value)])
}

#[test]
fn input_helpers_search_query_limit_counts_chars_not_bytes() {
    assert!(validate_search_query(&"é".repeat(128)).is_ok());
    assert_eq!(
        bad_request_message(validate_search_query(&"é".repeat(129))),
        "Search query must be at most 128 characters."
    );
}

#[test]
fn input_helpers_search_query_rejects_more_than_eight_terms() {
    assert!(validate_search_query("egg white bacon cheese bread ham tofu skin").is_ok());
    assert_eq!(
        bad_request_message(validate_search_query(
            "egg white bacon cheese bread ham tofu skin yolk"
        )),
        "Search query must have at most 8 terms."
    );
}

#[test]
fn input_helpers_escape_like_pattern_escapes_wildcards_and_backslashes() {
    // Raw strings: the backslash is doubled, `%` and `_` gain one backslash.
    assert_eq!(escape_like_pattern(r"50%_off\"), r"50\%\_off\\");
    assert_eq!(escape_like_pattern("egg"), "egg");
}

#[test]
fn input_helpers_search_like_patterns_wraps_each_term() {
    assert_eq!(search_like_patterns("  egg  white "), ["%egg%", "%white%"]);
}

#[test]
fn input_helpers_accepted_search_patterns_blank_is_none() {
    assert_eq!(
        accepted_search_patterns("   ").expect("blank query is ok"),
        None
    );
    assert_eq!(
        accepted_search_patterns("egg white").expect("query is ok"),
        Some(vec!["%egg%".to_string(), "%white%".to_string()])
    );
}

#[test]
fn input_helpers_ensure_text_length_counts_chars_not_bytes() {
    assert!(ensure_text_length(&"é".repeat(500), 500, "Name").is_ok());
    assert_eq!(
        bad_request_message(ensure_text_length(&"é".repeat(501), 500, "Name")),
        "Name must be at most 500 characters."
    );
}

#[test]
fn input_helpers_trim_optional_string_trims_maps_empty_and_truncates() {
    let trimmed = trim_optional_string(&field_input("label", json!("  hello  ")), "label");
    assert_eq!(trimmed.as_deref(), Some("hello"));
    assert_eq!(
        trim_optional_string(&field_input("label", json!("   ")), "label"),
        None
    );
    assert_eq!(
        trim_optional_string(&field_input("label", json!("")), "label"),
        None
    );
    // Truncation, not rejection: 501 chars come back as 500.
    let truncated = trim_optional_string(&field_input("label", json!("é".repeat(501))), "label");
    assert_eq!(truncated, Some("é".repeat(500)));
}

#[test]
fn input_helpers_optional_free_text_rejects_over_two_thousand_chars() {
    assert_eq!(
        bad_request_message(optional_free_text(
            &field_input("note", json!("é".repeat(2001))),
            "note",
            "Note"
        )),
        "Note must be at most 2000 characters."
    );
    assert_eq!(
        optional_free_text(&field_input("note", json!("  ok  ")), "note", "Note")
            .expect("free text is ok"),
        Some("ok".to_string())
    );
    assert_eq!(
        optional_free_text(&field_input("note", json!("   ")), "note", "Note")
            .expect("blank free text is ok"),
        None
    );
}

#[test]
fn input_helpers_required_string_with_message_reports_given_message() {
    let message = "Label is required.";
    assert_eq!(
        bad_request_message(required_string_with_message(
            &field_input("other", json!("x")),
            "label",
            message
        )),
        message
    );
    assert_eq!(
        bad_request_message(required_string_with_message(
            &field_input("label", json!("   ")),
            "label",
            message
        )),
        message
    );
    assert_eq!(
        required_string_with_message(&field_input("label", json!("  Oats  ")), "label", message)
            .expect("label is ok"),
        "Oats"
    );
    // A present value longer than the text cap is rejected under the key's name.
    assert_eq!(
        bad_request_message(required_string_with_message(
            &field_input("label", json!("é".repeat(501))),
            "label",
            message
        )),
        "label must be at most 500 characters."
    );
}

#[test]
fn input_helpers_normalize_positive_number_rounds_before_the_positive_check() {
    // DATA-05: 0.004 rounds to 0.00, so it is rejected even though it is positive.
    assert_eq!(
        bad_request_message(normalize_positive_number(
            &field_input("quantity", json!(0.004)),
            "quantity",
            "Quantity",
            1.0
        )),
        "Quantity must be a positive number."
    );
    assert_eq!(
        normalize_positive_number(
            &field_input("quantity", json!(0.005)),
            "quantity",
            "Quantity",
            1.0
        )
        .expect("0.005 rounds up to 0.01"),
        0.01
    );
    // A missing key falls back to the caller's default.
    assert_eq!(
        normalize_positive_number(
            &field_input("other", json!(9.0)),
            "quantity",
            "Quantity",
            2.5
        )
        .expect("fallback is ok"),
        2.5
    );
    assert_eq!(
        bad_request_message(normalize_positive_number(
            &field_input("quantity", json!(1_000_000.0)),
            "quantity",
            "Quantity",
            1.0
        )),
        "Quantity must be at most 999999.99."
    );
    assert_eq!(
        bad_request_message(normalize_positive_number(
            &field_input("quantity", json!(-1.0)),
            "quantity",
            "Quantity",
            1.0
        )),
        "Quantity must be a positive number."
    );
}

#[test]
fn input_helpers_optional_positive_number_maps_null_and_missing_to_none() {
    assert_eq!(
        optional_positive_number(
            &field_input("quantity", json!(null)),
            "quantity",
            "Quantity"
        )
        .expect("null is ok"),
        None
    );
    assert_eq!(
        optional_positive_number(&field_input("other", json!(9.0)), "quantity", "Quantity")
            .expect("missing key is ok"),
        None
    );
    assert_eq!(
        optional_positive_number(&field_input("quantity", json!(2.0)), "quantity", "Quantity")
            .expect("2.0 is ok"),
        Some(2.0)
    );
}

#[test]
fn input_helpers_normalize_quantity_unit_defaults_and_validates() {
    assert_eq!(
        normalize_quantity_unit(&field_input("other", json!(4.0)), "unit")
            .expect("missing unit defaults"),
        "serving"
    );
    for unit in ["g", "ml", "serving", "count"] {
        assert_eq!(
            normalize_quantity_unit(&field_input("unit", json!(unit)), "unit")
                .expect("unit is accepted"),
            unit
        );
    }
    assert_eq!(
        bad_request_message(normalize_quantity_unit(
            &field_input("unit", json!("kg")),
            "unit"
        )),
        "Quantity unit is invalid."
    );
}

#[test]
fn input_helpers_ensure_collection_size_caps_at_two_hundred() {
    assert!(ensure_collection_size(&vec![Value::Null; 200], "items").is_ok());
    assert_eq!(
        bad_request_message(ensure_collection_size(&vec![Value::Null; 201], "items")),
        "items must contain at most 200 entries."
    );
}
