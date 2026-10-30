use super::bad_request_message;
use crate::db::weight::{WeightStatEntry, normalize_weight_entry_input, weight_stats};
use chrono::NaiveDate;
use serde_json::{Value, json};

fn date(text: &str) -> NaiveDate {
    NaiveDate::parse_from_str(text, "%Y-%m-%d").expect("test date is valid")
}

fn entry(date: NaiveDate, weight_kg: f64) -> WeightStatEntry {
    WeightStatEntry { date, weight_kg }
}

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

#[test]
fn weight_stats_empty_entries_report_all_null() {
    let stats = weight_stats(&[], date("2026-06-30"));
    assert_eq!(stats.len(), 4);
    assert_eq!(stats["currentWeight"], Value::Null);
    assert_eq!(stats["weekChange"], Value::Null);
    assert_eq!(stats["monthChange"], Value::Null);
    assert_eq!(stats["trendDirection"], Value::Null);
}

#[test]
fn weight_stats_single_entry_has_no_changes_or_trend() {
    let stats = weight_stats(&[entry(date("2026-06-25"), 81.5)], date("2026-06-30"));
    assert_eq!(stats["currentWeight"], json!(81.5));
    assert_eq!(stats["weekChange"], Value::Null);
    assert_eq!(stats["monthChange"], Value::Null);
    assert_eq!(stats["trendDirection"], Value::Null);
}

#[test]
fn weight_stats_two_entries_set_trend_from_difference() {
    let today = date("2026-06-30");
    let trend = |first: f64, second: f64| {
        let stats = weight_stats(
            &[
                entry(date("2026-06-20"), first),
                entry(date("2026-06-27"), second),
            ],
            today,
        );
        stats["trendDirection"].clone()
    };

    assert_eq!(trend(80.0, 80.2), json!("up"));
    assert_eq!(trend(80.2, 80.0), json!("down"));
    // |diff| <= 0.1 is stable, including at the threshold.
    assert_eq!(trend(80.0, 80.1), json!("stable"));
    assert_eq!(trend(80.1, 80.0), json!("stable"));
    assert_eq!(trend(80.0, 80.05), json!("stable"));
}

#[test]
fn weight_stats_three_entries_average_the_last_two_differences() {
    let today = date("2026-06-30");
    // The last difference alone (-0.1) would read stable; the average (0.15) reads up.
    assert_eq!(
        weight_stats(
            &[
                entry(date("2026-06-10"), 80.0),
                entry(date("2026-06-20"), 80.4),
                entry(date("2026-06-27"), 80.3),
            ],
            today
        )["trendDirection"],
        json!("up")
    );
    // More than three entries only look at the last three rows.
    assert_eq!(
        weight_stats(
            &[
                entry(date("2026-06-01"), 78.0),
                entry(date("2026-06-10"), 80.0),
                entry(date("2026-06-20"), 80.4),
                entry(date("2026-06-27"), 80.3),
            ],
            today
        )["trendDirection"],
        json!("up")
    );
    // A steady decline averages to down.
    assert_eq!(
        weight_stats(
            &[
                entry(date("2026-06-10"), 80.0),
                entry(date("2026-06-20"), 79.5),
                entry(date("2026-06-27"), 79.0),
            ],
            today
        )["trendDirection"],
        json!("down")
    );
}

#[test]
fn weight_stats_week_change_uses_closest_entry_on_or_before_seven_days() {
    let today = date("2026-06-30");
    // An entry exactly on today-7 wins over earlier entries.
    let stats = weight_stats(
        &[
            entry(date("2026-06-20"), 82.0),
            entry(date("2026-06-23"), 81.0),
            entry(date("2026-06-30"), 80.5),
        ],
        today,
    );
    assert_eq!(stats["weekChange"], json!(-0.5));

    // The closest entry on or before the cutoff is used, not the earliest one.
    let stats = weight_stats(
        &[
            entry(date("2026-06-21"), 82.0),
            entry(date("2026-06-22"), 81.2),
            entry(date("2026-06-30"), 80.5),
        ],
        today,
    );
    assert_eq!(stats["weekChange"], json!(-0.7));
}

#[test]
fn weight_stats_week_change_is_null_without_a_reference_entry() {
    let stats = weight_stats(&[entry(date("2026-06-29"), 80.5)], date("2026-06-30"));
    assert_eq!(stats["currentWeight"], json!(80.5));
    assert_eq!(stats["weekChange"], Value::Null);
    assert_eq!(stats["monthChange"], Value::Null);
}

#[test]
fn weight_stats_month_change_uses_closest_entry_on_or_before_thirty_days() {
    let today = date("2026-06-30");
    let stats = weight_stats(
        &[
            entry(date("2026-05-28"), 83.0),
            entry(date("2026-06-05"), 82.0),
            entry(date("2026-06-30"), 80.5),
        ],
        today,
    );
    assert_eq!(stats["monthChange"], json!(-2.5));

    // A weekly change still exists when no 30-day reference does.
    let stats = weight_stats(
        &[
            entry(date("2026-06-22"), 81.0),
            entry(date("2026-06-30"), 80.5),
        ],
        today,
    );
    assert_eq!(stats["weekChange"], json!(-0.5));
    assert_eq!(stats["monthChange"], Value::Null);
}

#[test]
fn weight_stats_ignore_entries_after_the_reference_date() {
    let today = date("2026-06-30");
    let stats = weight_stats(
        &[
            entry(date("2026-06-23"), 83.0),
            entry(date("2026-06-30"), 81.5),
            entry(date("2026-08-01"), 70.0),
        ],
        today,
    );
    assert_eq!(stats["currentWeight"], json!(81.5));
    assert_eq!(stats["weekChange"], json!(-1.5));
    assert_eq!(stats["monthChange"], Value::Null);
    assert_eq!(stats["trendDirection"], json!("down"));

    // When every measurement is after the reference date, all stats are null.
    let stats = weight_stats(&[entry(date("2026-08-01"), 70.0)], today);
    assert_eq!(stats["currentWeight"], Value::Null);
    assert_eq!(stats["weekChange"], Value::Null);
    assert_eq!(stats["monthChange"], Value::Null);
    assert_eq!(stats["trendDirection"], Value::Null);
}

#[test]
fn weight_stats_changes_round_to_two_decimals() {
    let stats = weight_stats(
        &[
            entry(date("2026-06-23"), 79.0),
            entry(date("2026-06-30"), 80.004),
        ],
        date("2026-06-30"),
    );
    // 80.004 - 79.0 = 1.004 rounds to 1.0.
    assert_eq!(stats["weekChange"], json!(1.0));
}
