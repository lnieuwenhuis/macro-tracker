use super::bad_request_message;
use crate::db::weight::normalize_weight_entry_input;
use serde_json::{Value, json};

#[test]
fn onboarding_weight_normalization_rejects_zero_and_post_rounding_overflow() {
    let weight = |value: Value| {
        serde_json::Map::from_iter([
            ("date".to_string(), json!("2026-01-15")),
            ("weightKg".to_string(), value),
        ])
    };

    assert!(normalize_weight_entry_input(&weight(json!(72.5))).is_ok());
    assert!(normalize_weight_entry_input(&weight(json!(0))).is_err());
    assert!(normalize_weight_entry_input(&weight(json!(-1))).is_err());
    assert!(normalize_weight_entry_input(&weight(json!(1e30))).is_err());
    // Rounds up into overflow for numeric(5, 2).
    assert!(normalize_weight_entry_input(&weight(json!(999.995))).is_err());
    // The date is validated on this path too.
    let mut infinity_date = weight(json!(72.5));
    infinity_date.insert("date".to_string(), json!("infinity"));
    assert!(normalize_weight_entry_input(&infinity_date).is_err());
}

#[test]
fn weight_validation_rejects_invalid_values_and_trims_notes() {
    let base = serde_json::Map::from_iter([
        ("date".to_string(), json!("2026-07-09")),
        ("weightKg".to_string(), json!(80.0)),
        ("bodyFatPct".to_string(), json!(20.0)),
        ("notes".to_string(), json!("  hello  ")),
    ]);
    let values = normalize_weight_entry_input(&base).expect("valid weight entry");
    assert_eq!(values.notes.as_deref(), Some("hello"));

    for (key, value, message) in [
        ("weightKg", json!(0), "Weight must be a positive number."),
        ("weightKg", json!(1000), "Weight must be less than 1000 kg."),
        (
            "bodyFatPct",
            json!(101),
            "Body fat percentage must be between 0 and 100.",
        ),
    ] {
        let mut input = base.clone();
        input.insert(key.to_string(), value);
        assert_eq!(
            bad_request_message(normalize_weight_entry_input(&input)),
            message
        );
    }
}
