use super::*;
use axum::{body::Body, http::Request};
use http_body_util::BodyExt;
use sqlx::postgres::PgPoolOptions;
use std::sync::Arc;
use tower::ServiceExt;

fn test_state() -> AppState {
    AppState {
        config: Arc::new(crate::config::test_config()),
        db: PgPoolOptions::new()
            .connect_lazy("postgres://postgres:***@127.0.0.1:5432/macro_tracker")
            .expect("test pool should be created lazily"),
        http: reqwest::Client::new(),
    }
}

#[test]
fn public_food_mapping_removes_private_fields_without_copying_the_array() {
    let mapped = map_food_array(json!([{
        "id": "food-1",
        "name": "Oats",
        "ownerUserId": "private-owner",
        "sourceMetadata": { "upstream": "private" }
    }]));

    assert_eq!(mapped, json!([{ "id": "food-1", "name": "Oats" }]));
}

#[tokio::test]
async fn openapi_json_is_public_and_uses_cors_contract() {
    let response = router()
        .with_state(test_state())
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/openapi.json")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&CORS_ALLOW_ORIGIN.parse().unwrap())
    );
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body should collect")
        .to_bytes();
    let payload: Value = serde_json::from_slice(&body).expect("body should be JSON");

    assert_eq!(payload["openapi"], "3.1.0");
    assert_eq!(payload["info"]["title"], "Macro Tracker API");
    assert_eq!(payload["servers"], json!([{ "url": "/api/v1" }]));
    assert_eq!(
        payload["paths"]["/openapi.json"]["get"]["security"],
        json!([])
    );
    assert!(payload["paths"].get("/goals").is_some());
}

async fn read_json_body(response: Response) -> Value {
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body should collect")
        .to_bytes();
    serde_json::from_slice(&body).expect("body should be JSON")
}

async fn call(method: &str, uri: &str, bearer: Option<&str>) -> Response {
    let mut builder = Request::builder().method(method).uri(uri);
    if let Some(bearer) = bearer {
        builder = builder.header(header::AUTHORIZATION, bearer);
    }

    router()
        .with_state(test_state())
        .oneshot(builder.body(Body::empty()).expect("request should build"))
        .await
        .expect("request should complete")
}

#[tokio::test]
async fn unknown_routes_return_the_error_envelope() {
    let response = call("GET", "/does-not-exist", None).await;

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let payload = read_json_body(response).await;
    assert_eq!(payload["ok"], json!(false));
    assert_eq!(payload["error"]["code"], json!("not_found"));
}

#[tokio::test]
async fn known_routes_reject_unsupported_methods_before_authenticating() {
    let response = call("DELETE", "/goals", None).await;

    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    let allow = response
        .headers()
        .get(header::ALLOW)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    assert!(allow.contains("GET"), "unexpected Allow header: {allow}");
    assert!(
        allow.contains("OPTIONS"),
        "unexpected Allow header: {allow}"
    );

    let payload = read_json_body(response).await;
    assert_eq!(payload["error"]["code"], json!("method_not_allowed"));
}

#[tokio::test]
async fn an_oversized_body_keeps_the_error_envelope_and_the_cors_headers() {
    // API-06: the `Bytes` extractor rejects before the handler, so a 413 must still carry CORS headers.
    let response = router()
        .with_state(test_state())
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/goals")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(vec![b'x'; 3 * 1024 * 1024]))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&CORS_ALLOW_ORIGIN.parse().unwrap())
    );

    let payload = read_json_body(response).await;
    assert_eq!(payload["ok"], json!(false));
    assert_eq!(payload["error"]["code"], json!("payload_too_large"));
}

#[tokio::test]
async fn the_public_spec_is_still_served_when_the_body_is_rejected() {
    // A rejected body must not stop the unauthenticated document from being readable.
    let response = router()
        .with_state(test_state())
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/openapi.json")
                .body(Body::from(vec![b'x'; 3 * 1024 * 1024]))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn preflight_succeeds_without_a_token() {
    let response = call("OPTIONS", "/goals", None).await;

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&CORS_ALLOW_ORIGIN.parse().unwrap())
    );
}

#[tokio::test]
async fn missing_and_malformed_bearer_tokens_are_reported_distinctly() {
    let missing = call("GET", "/goals", None).await;
    assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        read_json_body(missing).await["error"]["code"],
        json!("missing_token")
    );

    let malformed = call("GET", "/goals", Some("Token abc")).await;
    assert_eq!(malformed.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        read_json_body(malformed).await["error"]["code"],
        json!("malformed_token")
    );
}

#[test]
fn auth_error_maps_every_backend_reason() {
    assert_eq!(auth_error("expired").0, "expired_token");
    assert_eq!(auth_error("revoked").0, "revoked_token");
    assert_eq!(auth_error("malformed").0, "malformed_token");
    assert_eq!(auth_error("missing").0, "missing_token");
    assert_eq!(auth_error("anything-else").0, "invalid_token");
}

#[test]
fn require_date_matches_the_internal_rpc_rule() {
    assert!(require_date("2026-01-15").is_ok());
    assert!(require_date("2024-02-29").is_ok());

    for invalid in [
        "",
        "2026-1-5",
        "26-01-15",
        "2026-13-01",
        "2026-02-30",
        // Postgres would accept all three as `date` input.
        "infinity",
        "today",
        "epoch",
    ] {
        assert!(
            require_date(invalid).is_err(),
            "expected {invalid:?} to be rejected"
        );
    }
}

#[test]
fn require_uuid_rejects_non_uuid_path_parameters() {
    assert!(require_uuid("not-a-uuid").is_err());
    let uuid = Uuid::new_v4().to_string();
    assert_eq!(require_uuid(&uuid).expect("valid uuid"), uuid);
}

#[test]
fn merge_goals_keeps_omitted_fields_and_clears_explicit_nulls() {
    let merged = merge_goals(
        json!({ "caloriesKcal": 2200, "proteinG": 150, "carbsG": 250, "fatG": 70 }),
        json!({ "proteinG": 180, "fatG": null }),
    )
    .expect("patch should merge");

    assert_eq!(merged["caloriesKcal"], json!(2200));
    assert_eq!(merged["proteinG"].as_f64(), Some(180.0));
    assert_eq!(merged["carbsG"], json!(250));
    assert_eq!(merged["fatG"], Value::Null);
}

#[test]
fn merge_goals_rejects_invalid_numbers() {
    let current = json!({ "caloriesKcal": 2000, "proteinG": 150, "carbsG": 200, "fatG": 60 });

    for patch in [
        json!({ "proteinG": -1 }),
        json!({ "proteinG": "150" }),
        json!({ "caloriesKcal": 2000.5 }),
    ] {
        assert!(
            merge_goals(current.clone(), patch.clone()).is_err(),
            "expected {patch} to be rejected"
        );
    }
}

fn object(value: Value) -> Map<String, Value> {
    value
        .as_object()
        .cloned()
        .expect("value should be an object")
}

#[test]
fn meal_entry_patches_cannot_set_the_private_recalculation_flag() {
    // DATA-02: `proteinG` should force recalculation, but the caller tries to override the flag to `false`.
    let merged = merge_meal_entry_patch(
        object(json!({
            "id": "11111111-1111-4111-8111-111111111111",
            "productId": "22222222-2222-4222-8222-222222222222",
            "label": "Oats",
            "quantity": 1.0,
            "unit": "serving",
            "proteinG": 10.0,
            "carbsG": 20.0,
            "fatG": 5.0,
            "caloriesKcal": 165
        })),
        object(json!({
            "proteinG": 1,
            "caloriesKcal": -2_000_000_000i64,
            "__recalculateProductMacros": false
        })),
    );

    assert!(
        !merged.contains_key("__recalculateProductMacros"),
        "a client must not be able to control the recalculation flag: {merged:?}"
    );
    assert_eq!(merged["proteinG"], json!(1));
}

#[test]
fn meal_entry_patches_drop_every_reserved_key() {
    let merged = merge_meal_entry_patch(
        object(json!({ "label": "Oats" })),
        object(json!({ "__anythingElse": "nope", "label": "Toast" })),
    );

    assert!(!merged.contains_key("__anythingElse"));
    assert_eq!(merged["label"], json!("Toast"));
}

#[test]
fn product_linked_entries_keep_their_snapshot_when_no_macro_field_is_patched() {
    // Renaming a product-linked entry must not recompute its macros.
    let merged = merge_meal_entry_patch(
        object(json!({
            "productId": "22222222-2222-4222-8222-222222222222",
            "label": "Oats",
            "proteinG": 10.0
        })),
        object(json!({ "label": "Breakfast oats" })),
    );

    assert_eq!(merged["__recalculateProductMacros"], json!(false));
    assert_eq!(merged["label"], json!("Breakfast oats"));
}

#[test]
fn entries_without_a_product_never_carry_the_recalculation_flag() {
    let merged = merge_meal_entry_patch(
        object(json!({ "label": "Oats", "proteinG": 10.0 })),
        object(json!({ "label": "Toast" })),
    );

    assert!(!merged.contains_key("__recalculateProductMacros"));
}

#[test]
fn weight_entry_patches_drop_reserved_keys_too() {
    let merged = apply_client_patch(
        object(json!({ "date": "2026-01-15", "weightKg": 80.0 })),
        object(json!({ "weightKg": 79.0, "__recalculateProductMacros": false })),
    );

    assert!(!merged.contains_key("__recalculateProductMacros"));
    assert_eq!(merged["weightKg"], json!(79.0));
}

#[test]
fn read_json_rejects_a_malformed_body() {
    assert!(read_json(&Bytes::from_static(b"{ not json")).is_err());
    assert!(read_json(&Bytes::from_static(b"{}")).is_ok());
}

#[test]
fn require_object_rejects_non_objects() {
    assert!(require_object(json!([1, 2, 3])).is_err());
    assert!(require_object(json!("string")).is_err());
    assert!(require_object(json!({ "a": 1 })).is_ok());
}

#[test]
fn app_errors_map_onto_the_public_status_and_code() {
    let cases = [
        (
            AppError::BadRequest("nope".into()),
            StatusCode::BAD_REQUEST,
            "bad_request",
        ),
        (
            AppError::Forbidden("nope".into()),
            StatusCode::FORBIDDEN,
            "forbidden",
        ),
        (
            AppError::NotFound("nope".into()),
            StatusCode::NOT_FOUND,
            "not_found",
        ),
        (
            AppError::Conflict("nope".into()),
            StatusCode::CONFLICT,
            "conflict",
        ),
        (
            AppError::Upstream("nope".into()),
            StatusCode::BAD_GATEWAY,
            "upstream_error",
        ),
    ];

    for (error, status, code) in cases {
        let failure = api_failure_from_app_error(error);
        assert_eq!(failure.status, status);
        assert_eq!(failure.code, code);
    }
}

/// Minimal `sqlx::error::DatabaseError` so unique-violation mapping is testable without a real constraint.
#[derive(Debug)]
struct FakeDatabaseError {
    code: &'static str,
    constraint: Option<&'static str>,
}

impl std::fmt::Display for FakeDatabaseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "duplicate key value violates unique constraint")
    }
}

impl std::error::Error for FakeDatabaseError {}

impl sqlx::error::DatabaseError for FakeDatabaseError {
    fn message(&self) -> &str {
        "duplicate key value violates unique constraint"
    }

    fn code(&self) -> Option<std::borrow::Cow<'_, str>> {
        Some(std::borrow::Cow::Borrowed(self.code))
    }

    fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
        self
    }

    fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
        self
    }

    fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
        self
    }

    fn constraint(&self) -> Option<&str> {
        self.constraint
    }

    fn kind(&self) -> sqlx::error::ErrorKind {
        if self.code == "23505" {
            sqlx::error::ErrorKind::UniqueViolation
        } else {
            sqlx::error::ErrorKind::Other
        }
    }
}

fn database_error(code: &'static str, constraint: Option<&'static str>) -> AppError {
    AppError::Sqlx(sqlx::Error::Database(Box::new(FakeDatabaseError {
        code,
        constraint,
    })))
}

#[test]
fn any_unique_violation_is_a_conflict_not_an_internal_error() {
    // API-03: every unique-violation constraint must map to a conflict, not just the weight-date one.
    let failure = api_failure_from_app_error(database_error(
        "23505",
        Some("meal_entries_user_client_mutation_id_key"),
    ));

    assert_eq!(failure.status, StatusCode::CONFLICT);
    assert_eq!(failure.code, "conflict");
    assert!(
        !failure.message.contains("meal_entries"),
        "the constraint name must not be echoed: {}",
        failure.message
    );
}

#[test]
fn the_weight_date_conflict_keeps_its_specific_code() {
    let failure =
        api_failure_from_app_error(database_error("23505", Some(WEIGHT_ENTRY_DATE_CONSTRAINT)));

    assert_eq!(failure.status, StatusCode::CONFLICT);
    assert_eq!(failure.code, "weight_entry_date_conflict");
}

#[test]
fn a_non_unique_database_fault_is_still_an_internal_error() {
    let failure = api_failure_from_app_error(database_error("08006", None));

    assert_eq!(failure.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(failure.code, "internal_error");
}

#[test]
fn barcodes_are_validated_the_same_way_on_both_entry_points() {
    assert!(require_barcode("8712345678901").is_ok());
    assert!(require_barcode("1234").is_ok());
    assert!(require_barcode("123").is_err());
    assert!(require_barcode("").is_err());
    assert!(require_barcode(&"9".repeat(21)).is_err());
    assert!(require_barcode(&"9".repeat(20)).is_ok());
}

#[test]
fn unauthorized_is_reported_as_invalid_token_on_the_public_api() {
    let failure = api_failure_from_app_error(AppError::Unauthorized("nope".into()));
    assert_eq!(failure.status, StatusCode::UNAUTHORIZED);
    assert_eq!(failure.code, "invalid_token");
}

#[test]
fn internal_failures_never_leak_their_message() {
    let failure = api_failure_from_app_error(AppError::Anyhow(anyhow::anyhow!(
        "connection to postgres://user:secret@db.internal failed"
    )));

    assert_eq!(failure.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(failure.code, "internal_error");
    assert!(!failure.message.contains("postgres://"));
}

/// Turns an OpenAPI path template into a concrete request path a client would hit.
fn sample_path(template: &str) -> Vec<String> {
    template
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| match segment {
            "{date}" => "2026-01-15".to_string(),
            "{barcode}" => "8712345678901".to_string(),
            segment if segment.starts_with('{') => {
                "11111111-1111-4111-8111-111111111111".to_string()
            }
            segment => segment.to_string(),
        })
        .collect()
}

#[test]
fn every_shipped_endpoint_declares_scopes_for_each_method() {
    // API-01: derived from the routing table, so a new endpoint cannot skip this coverage.
    for endpoint in API_V1_ENDPOINTS {
        for method in endpoint.methods {
            assert!(
                required_scopes(endpoint, method).is_some(),
                "{} {method} declares no scopes",
                endpoint.path
            );
        }
    }
}

#[test]
fn an_endpoint_with_no_scope_tuple_for_a_method_is_denied() {
    // API-01: a method allowed but absent from `scopes` must not fall back to "no scopes required".
    let endpoint = Endpoint {
        path: "/example",
        methods: &["GET", "DELETE"],
        scopes: &[("GET", &["read:daily"])],
    };

    assert_eq!(required_scopes(&endpoint, "GET"), Some(&["read:daily"][..]));
    assert_eq!(required_scopes(&endpoint, "DELETE"), None);
}

#[test]
fn every_table_entry_routes_back_to_itself() {
    // Guards the match order: a literal segment must not be swallowed by an earlier wildcard shape.
    for endpoint in API_V1_ENDPOINTS {
        let path = sample_path(endpoint.path);
        let resolved =
            endpoint_for(&path).unwrap_or_else(|| panic!("{} does not route", endpoint.path));
        assert_eq!(
            resolved.path, endpoint.path,
            "{:?} routed to {} instead of {}",
            path, resolved.path, endpoint.path
        );
    }
}

#[test]
fn the_routing_table_and_the_published_contract_agree_on_scopes() {
    // The spec is served verbatim, so drift between enforced and documented scopes is a silent break.
    let spec: Value = serde_json::from_slice(API_V1_OPENAPI_JSON).expect("spec should be JSON");
    let paths = spec["paths"].as_object().expect("spec should have paths");

    let mut documented = paths
        .iter()
        .flat_map(|(path, operations)| {
            operations
                .as_object()
                .expect("operations should be an object")
                .iter()
                .map(move |(method, operation)| {
                    (
                        format!("{} {path}", method.to_uppercase()),
                        operation["x-required-scopes"]
                            .as_array()
                            .map(|scopes| {
                                scopes
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_string)
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default(),
                    )
                })
        })
        .collect::<std::collections::BTreeMap<_, _>>();

    for endpoint in API_V1_ENDPOINTS {
        for method in endpoint.methods {
            let key = format!("{method} {}", endpoint.path);
            let scopes = required_scopes(endpoint, method)
                .unwrap_or_else(|| panic!("{key} declares no scopes"));
            let documented_scopes = documented
                .remove(&key)
                .unwrap_or_else(|| panic!("{key} is enforced but not documented"));
            assert_eq!(
                documented_scopes,
                scopes
                    .iter()
                    .map(|scope| scope.to_string())
                    .collect::<Vec<_>>(),
                "{key} enforces different scopes than the spec documents"
            );
        }
    }

    assert!(
        documented.is_empty(),
        "documented operations that no endpoint serves: {:?}",
        documented.keys().collect::<Vec<_>>()
    );
}

#[test]
fn the_published_status_lists_match_what_the_handler_can_actually_return() {
    // API-15: the documented status set must match what each handler can actually return, including 504/413.
    let spec: Value = serde_json::from_slice(API_V1_OPENAPI_JSON).expect("spec should be JSON");
    let paths = spec["paths"].as_object().expect("spec should have paths");

    for (path, operations) in paths {
        for (method, operation) in operations.as_object().expect("operations object") {
            let responses = operation["responses"]
                .as_object()
                .expect("operation should document responses");
            let label = format!("{} {path}", method.to_uppercase());

            if path == "/openapi.json" {
                // Answered before auth or the deadline wrapper, but the rate limiter still wraps it.
                assert_eq!(
                    responses.keys().collect::<Vec<_>>(),
                    vec!["200", "429"],
                    "{label}: the public document has only these outcomes"
                );
                continue;
            }

            // 405 is a path-level property, but every operation lists it since OpenAPI has nowhere else to put it.
            for required in ["401", "403", "405", "429", "500", "504"] {
                assert!(
                    responses.contains_key(required),
                    "{label}: missing {required}"
                );
            }
            if operation.get("requestBody").is_some() {
                assert!(responses.contains_key("413"), "{label}: missing 413");
            }
        }
    }
}

#[test]
fn every_success_response_describes_its_data_and_every_ref_resolves() {
    // API-15: every success response must describe `data`, and every `$ref` in the hand-maintained spec must resolve.
    let spec: Value = serde_json::from_slice(API_V1_OPENAPI_JSON).expect("spec should be JSON");

    fn collect_refs(node: &Value, into: &mut Vec<String>) {
        match node {
            Value::Object(map) => {
                for (key, value) in map {
                    if key == "$ref" {
                        if let Some(reference) = value.as_str() {
                            into.push(reference.to_string());
                        }
                    } else {
                        collect_refs(value, into);
                    }
                }
            }
            Value::Array(items) => items.iter().for_each(|item| collect_refs(item, into)),
            _ => {}
        }
    }

    let mut refs = Vec::new();
    collect_refs(&spec, &mut refs);
    assert!(!refs.is_empty(), "the document should use components");
    for reference in &refs {
        let path = reference
            .strip_prefix("#/")
            .unwrap_or_else(|| panic!("{reference} is not a local reference"));
        let mut node = &spec;
        for segment in path.split('/') {
            node = node
                .get(segment)
                .unwrap_or_else(|| panic!("{reference} does not resolve"));
        }
    }

    let paths = spec["paths"].as_object().expect("spec should have paths");
    for (path, operations) in paths {
        for (method, operation) in operations.as_object().expect("operations object") {
            let label = format!("{} {path}", method.to_uppercase());
            let responses = operation["responses"].as_object().expect("responses");
            let (_, success) = responses
                .iter()
                .find(|(status, _)| status.starts_with('2'))
                .unwrap_or_else(|| panic!("{label}: no success response"));
            let schema = &success["content"]["application/json"]["schema"];

            if path == "/openapi.json" {
                // This one operation answers with the document itself, not the `{ ok, data }` envelope.
                assert!(
                    schema.get("properties").is_none(),
                    "{label}: the spec endpoint does not use the envelope"
                );
                continue;
            }

            let data = &schema["properties"]["data"];
            assert!(
                data.is_object() && !data.as_object().expect("object").is_empty(),
                "{label}: `data` is still undescribed"
            );
            assert_eq!(
                schema["properties"]["ok"],
                json!({ "const": true }),
                "{label}: success responses set ok=true"
            );
        }
    }
}

#[test]
fn the_published_timeout_status_is_the_one_the_handler_emits() {
    let spec: Value = serde_json::from_slice(API_V1_OPENAPI_JSON).expect("spec should be JSON");

    assert!(
        spec["paths"]["/goals"]["get"]["responses"]
            .get(StatusCode::GATEWAY_TIMEOUT.as_str())
            .is_some()
    );
    assert!(
        spec["paths"]["/goals"]["patch"]["responses"]
            .get(StatusCode::PAYLOAD_TOO_LARGE.as_str())
            .is_some()
    );
}

#[test]
fn the_published_quantity_units_are_the_ones_the_data_layer_accepts() {
    // API-15: `unit` must be documented as the same closed set `is_quantity_unit` accepts.
    let spec: Value = serde_json::from_slice(API_V1_OPENAPI_JSON).expect("spec should be JSON");
    let unit = &spec["paths"]["/days/{date}/entries"]["post"]["requestBody"]["content"]["application/json"]
        ["schema"]["properties"]["unit"];

    let documented = unit["enum"]
        .as_array()
        .expect("unit should be an enum")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();

    // Mirrors the private `is_quantity_unit` in db.rs; move this assertion if that set changes.
    assert_eq!(documented, vec!["g", "ml", "serving", "count"]);
}

#[test]
fn the_body_date_is_not_documented_where_the_path_wins() {
    // API-15: `dispatch_api_request` overwrites body `date` with the path segment, so it must not be documented.
    let spec: Value = serde_json::from_slice(API_V1_OPENAPI_JSON).expect("spec should be JSON");
    let properties = &spec["paths"]["/days/{date}/entries"]["post"]["requestBody"]["content"]["application/json"]
        ["schema"]["properties"];

    assert!(properties.get("date").is_none());
}

#[test]
fn portions_is_documented_as_optional_with_its_real_default() {
    let spec: Value = serde_json::from_slice(API_V1_OPENAPI_JSON).expect("spec should be JSON");
    let schema =
        &spec["paths"]["/recipes"]["post"]["requestBody"]["content"]["application/json"]["schema"];

    let required = schema["required"]
        .as_array()
        .expect("required should be an array")
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();

    assert!(!required.contains(&"portions"));
    assert_eq!(schema["properties"]["portions"]["default"], json!(1));
}

#[tokio::test]
async fn a_timed_out_request_still_returns_the_json_envelope_and_cors_headers() {
    // A tower TimeoutLayer would emit a bare 504, breaking the documented contract and CORS for browsers.
    let response = raw_json_response(
        StatusCode::GATEWAY_TIMEOUT,
        json!({
            "ok": false,
            "error": { "code": "timeout", "message": "The request took too long to complete." }
        }),
        None,
    );

    assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(
        response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
        Some(&CORS_ALLOW_ORIGIN.parse().unwrap())
    );

    let payload = read_json_body(response).await;
    assert_eq!(payload["ok"], json!(false));
    assert_eq!(payload["error"]["code"], json!("timeout"));
}

#[tokio::test]
async fn slow_requests_time_out_through_the_api_error_envelope() {
    // A deadline short enough to elapse proves the timeout branch produces an envelope, not an empty response.
    let slow = async {
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        Ok::<(StatusCode, Value), ApiFailure>((StatusCode::OK, json!({})))
    };

    let result = match tokio::time::timeout(std::time::Duration::from_millis(20), slow).await {
        Ok(result) => result,
        Err(_) => Err(ApiFailure::new(
            StatusCode::GATEWAY_TIMEOUT,
            "timeout",
            "The request took too long to complete.",
        )),
    };

    let failure = result.expect_err("the slow future must time out");
    assert_eq!(failure.status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(failure.code, "timeout");
}

#[test]
fn unknown_paths_have_no_endpoint() {
    assert!(endpoint_for(&["nope".to_string()]).is_none());
    assert!(
        endpoint_for(&["goals".to_string(), "extra".to_string()]).is_none(),
        "trailing segments must not resolve"
    );
}
