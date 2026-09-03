//! Small helpers used across more than one request-handling module.

/// Round to one decimal place (e.g. body-fat percentages).
pub fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Round to two decimal places (e.g. weights, confidence scores).
pub fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}
