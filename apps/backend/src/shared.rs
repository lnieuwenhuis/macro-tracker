//! Small helpers used across more than one request-handling module.
//!
//! CLEAN-07: `round1` was defined identically in `api.rs`, `legacy_api.rs`
//! and `db.rs`; `round2` was defined identically in `db.rs` and
//! `legacy_api.rs`. Both are pure numeric formatting helpers with no
//! behavioural variance across call sites, so they live here once.

/// Round to one decimal place (e.g. body-fat percentages).
pub fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Round to two decimal places (e.g. weights, confidence scores).
pub fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}
