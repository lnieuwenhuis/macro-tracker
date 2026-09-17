use super::*;
use crate::config::Config;
use axum::{
    body::Body,
    extract::Path as AxumPath,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tower::ServiceExt;

fn test_config(provider_base_url: Option<&str>) -> Config {
    let provider_base_url = provider_base_url.unwrap_or("http://127.0.0.1:1");
    Config {
        allow_insecure_internal_auth: true,
        enable_test_routes: false,
        app_url: "http://localhost:3000".to_string(),
        backend_internal_secret: None,
        database_url: "postgres://postgres:***@127.0.0.1:1/macro_tracker".to_string(),
        port: 4000,
        postgres_pool_max: 1,
        session_secret: "local-test-secret".to_string(),
        shoo_base_url: "https://shoo.dev".to_string(),
        trusted_origins: vec!["http://localhost:3000".to_string()],
        admin_owner_emails: vec![],
        ai_gateway_url: None,
        ai_gateway_api_key: None,
        ai_gateway_models: None,
        ai_gateway_model_timeout_ms: None,
        open_food_facts_base_url: provider_base_url.to_string(),
        albert_heijn_base_url: provider_base_url.to_string(),
        jumbo_base_url: provider_base_url.to_string(),
    }
}

fn test_state(provider_base_url: Option<&str>) -> AppState {
    AppState {
        config: Arc::new(test_config(provider_base_url)),
        db: sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(50))
            .connect_lazy("postgres://postgres:***@127.0.0.1:1/macro_tracker")
            .expect("test pool should be created lazily"),
        http: reqwest::Client::new(),
    }
}

fn session_cookie(state: &AppState) -> String {
    let token = auth::create_session_token(
        &state.config,
        &crate::types::SessionUser {
            user_id: uuid::Uuid::new_v4(),
            email: "barcode-test@example.com".to_string(),
        },
    )
    .expect("session token should sign");

    format!("{}={token}", auth::SESSION_COOKIE_NAME)
}

async fn spawn_barcode_provider_stub() -> String {
    async fn off_miss() -> Json<Value> {
        Json(json!({ "status": 0 }))
    }
    async fn ah_token() -> Json<Value> {
        Json(json!({ "access_token": "test-token" }))
    }
    async fn ah_search() -> Json<Value> {
        Json(json!({
            "cards": [{
                "products": [{
                    "webshopId": "ah-product-1",
                    "title": "AH Test Product",
                    "brand": "AH Brand",
                    "images": [{ "url": "https://example.com/ah.png" }]
                }]
            }]
        }))
    }
    async fn ah_detail(AxumPath(_id): AxumPath<String>) -> Json<Value> {
        Json(json!({
            "nutritionInfo": [
                { "name": "Energie kcal", "value": 123, "unit": "kcal" },
                { "name": "Eiwitten", "value": 4.2, "unit": "g" },
                { "name": "Koolhydraten", "value": 12.3, "unit": "g" },
                { "name": "Vet", "value": 5.6, "unit": "g" }
            ]
        }))
    }

    let app = Router::new()
        .route("/api/v2/product/{*path}", get(off_miss))
        .route("/mobile-auth/v1/auth/token/anonymous", post(ah_token))
        .route("/mobile-services/product/search/v2", get(ah_search))
        .route(
            "/mobile-services/product/detail/v4/fir/{id}",
            get(ah_detail),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("stub listener should bind");
    let addr = listener.local_addr().expect("stub address should exist");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("stub server should run");
    });
    format!("http://{addr}")
}

#[derive(Clone)]
struct ChatStubResponse {
    status: StatusCode,
    delay: Duration,
    body: Value,
}

struct ChatStubState {
    requests: AtomicUsize,
    responses: Vec<ChatStubResponse>,
}

async fn chat_stub_handler(State(state): State<Arc<ChatStubState>>) -> impl IntoResponse {
    let request_index = state.requests.fetch_add(1, Ordering::SeqCst);
    let response = state
        .responses
        .get(request_index)
        .or_else(|| state.responses.last())
        .expect("stub should have at least one response")
        .clone();
    tokio::time::sleep(response.delay).await;
    (response.status, Json(response.body))
}

async fn spawn_chat_stub(responses: Vec<ChatStubResponse>) -> (String, Arc<ChatStubState>) {
    let state = Arc::new(ChatStubState {
        requests: AtomicUsize::new(0),
        responses,
    });
    let app = Router::new()
        .route("/chat/completions", post(chat_stub_handler))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("stub listener should bind");
    let addr = listener.local_addr().expect("stub address should exist");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("stub server should run");
    });
    (format!("http://{addr}/chat/completions"), state)
}

fn gateway_test_state(endpoint: &str, models: Option<&str>) -> AppState {
    let mut state = test_state(None);
    let config = Arc::make_mut(&mut state.config);
    config.ai_gateway_url = Some(endpoint.to_string());
    config.ai_gateway_api_key = Some("test-gateway-key".to_string());
    config.ai_gateway_models = models.map(str::to_string);
    state
}

#[tokio::test]
async fn barcode_provider_race_returns_fast_ah_without_waiting_for_slow_jumbo() {
    let result = tokio::time::timeout(
        Duration::from_millis(50),
        prefer_primary_provider(
            async { ProviderOutcome::Found(json!("albert_heijn")) },
            std::future::pending::<ProviderOutcome<Value>>(),
        ),
    )
    .await
    .expect("a fast Albert Heijn hit should not wait for Jumbo");

    assert!(matches!(result, ProviderOutcome::Found(value) if value == json!("albert_heijn")));
}

#[tokio::test]
async fn barcode_provider_race_returns_jumbo_after_ah_miss() {
    let result = prefer_primary_provider(async { ProviderOutcome::<Value>::NotFound }, async {
        ProviderOutcome::Found(json!("jumbo"))
    })
    .await;

    assert!(matches!(result, ProviderOutcome::Found(value) if value == json!("jumbo")));
}

/// API-04: only two successful misses establish absence; one failure keeps the answer retryable.
#[tokio::test]
async fn barcode_provider_race_keeps_absence_only_when_both_providers_answered() {
    let both_missed =
        prefer_primary_provider(async { ProviderOutcome::<Value>::NotFound }, async {
            ProviderOutcome::<Value>::NotFound
        })
        .await;
    assert!(matches!(both_missed, ProviderOutcome::NotFound));

    let one_failed = prefer_primary_provider(async { ProviderOutcome::<Value>::NotFound }, async {
        ProviderOutcome::<Value>::Unavailable
    })
    .await;
    assert!(matches!(one_failed, ProviderOutcome::Unavailable));

    let one_hit = prefer_primary_provider(async { ProviderOutcome::<Value>::Unavailable }, async {
        ProviderOutcome::Found(json!("hit"))
    })
    .await;
    assert!(matches!(one_hit, ProviderOutcome::Found(value) if value == json!("hit")));
}

#[tokio::test]
async fn food_photo_capacity_wait_is_bounded_and_recovers_after_release() {
    let slots = tokio::sync::Semaphore::new(1);
    let held_slot = slots
        .acquire()
        .await
        .expect("first slot should be available");

    assert!(
        acquire_food_photo_slot(&slots, Duration::from_millis(10))
            .await
            .is_none(),
        "a request should stop waiting when all slots remain occupied"
    );

    drop(held_slot);
    assert!(
        acquire_food_photo_slot(&slots, Duration::from_millis(50))
            .await
            .is_some(),
        "capacity should be reusable after the in-flight upload releases it"
    );
}

#[tokio::test]
async fn food_photo_upload_deadline_rejects_a_stalled_body_read() {
    let result = await_food_photo_upload(
        std::future::pending::<Result<FoodPhotoUpload, ()>>(),
        Duration::from_millis(10),
    )
    .await;

    assert_eq!(result.unwrap_err(), FoodPhotoUploadError::TimedOut);
}

#[tokio::test]
async fn food_photo_stops_after_non_retryable_provider_response() {
    let (endpoint, stub) = spawn_chat_stub(vec![ChatStubResponse {
        status: StatusCode::UNAUTHORIZED,
        delay: Duration::ZERO,
        body: json!({ "error": { "message": "Invalid API key." } }),
    }])
    .await;

    let result = analyze_food_photo_url_with_limits(
        &gateway_test_state(&endpoint, Some("test/model-1,test/model-2,test/model-3")),
        "data:image/png;base64,AA==",
        "",
        None,
        "test-user",
        false,
        FoodPhotoRequestLimits {
            chat_completions_url: &endpoint,
            model_timeout: Duration::from_millis(100),
            request_timeout: Duration::from_secs(1),
        },
    )
    .await;

    assert_eq!(stub.requests.load(Ordering::SeqCst), 1);
    // The provider's 401 is our misconfiguration, not the caller's: it must surface as a 502 with no upstream text.
    assert_eq!(result["statusCode"], json!(502));
    assert_eq!(result["retryable"], json!(false));
    assert_eq!(
        result["error"],
        json!("Photo analysis failed. Please try again.")
    );
    assert!(!result.to_string().contains("Invalid API key"));
}

#[tokio::test]
async fn food_photo_uses_fallback_after_retryable_provider_response() {
    let (endpoint, stub) = spawn_chat_stub(vec![
            ChatStubResponse {
                status: StatusCode::SERVICE_UNAVAILABLE,
                delay: Duration::ZERO,
                body: json!({ "error": { "message": "Provider temporarily unavailable." } }),
            },
            ChatStubResponse {
                status: StatusCode::OK,
                delay: Duration::ZERO,
                body: json!({
                    "choices": [{
                        "message": {
                            "content": "{\"status\":\"ready\",\"estimate\":{\"label\":\"Test meal\",\"caloriesKcal\":100,\"proteinG\":10,\"carbsG\":12,\"fatG\":2,\"confidence\":0.9,\"notes\":[]}}"
                        }
                    }]
                }),
            },
        ])
        .await;

    let result = analyze_food_photo_url_with_limits(
        &gateway_test_state(&endpoint, Some("test/model-1,test/model-2")),
        "data:image/png;base64,AA==",
        "",
        None,
        "test-user",
        false,
        FoodPhotoRequestLimits {
            chat_completions_url: &endpoint,
            model_timeout: Duration::from_millis(100),
            request_timeout: Duration::from_secs(1),
        },
    )
    .await;

    assert_eq!(stub.requests.load(Ordering::SeqCst), 2);
    assert_eq!(result["ok"], json!(true));
    assert_eq!(result["analysis"]["estimate"]["label"], json!("Test meal"));
}

#[tokio::test]
async fn food_photo_fallback_chain_cannot_exceed_request_deadline() {
    let delayed_retryable_failure = ChatStubResponse {
        status: StatusCode::SERVICE_UNAVAILABLE,
        delay: Duration::from_millis(40),
        body: json!({ "error": { "message": "Provider temporarily unavailable." } }),
    };
    let (endpoint, stub) = spawn_chat_stub(vec![delayed_retryable_failure]).await;
    let started = Instant::now();

    let result = analyze_food_photo_url_with_limits(
        &gateway_test_state(
            &endpoint,
            Some("test/model-1,test/model-2,test/model-3,test/model-4"),
        ),
        "data:image/png;base64,AA==",
        "",
        None,
        "test-user",
        false,
        FoodPhotoRequestLimits {
            chat_completions_url: &endpoint,
            model_timeout: Duration::from_millis(60),
            request_timeout: Duration::from_millis(100),
        },
    )
    .await;

    assert!(started.elapsed() < Duration::from_millis(300));
    assert!((1..4).contains(&stub.requests.load(Ordering::SeqCst)));
    assert_eq!(result["kind"], json!("provider_error"));
    assert_eq!(result["retryable"], json!(false));
    assert_eq!(
        result["error"],
        json!("Food photo AI request timed out after 100ms.")
    );
}

#[tokio::test]
async fn food_photo_succeeds_through_the_gateway() {
    let (endpoint, stub) = spawn_chat_stub(vec![ChatStubResponse {
            status: StatusCode::OK,
            delay: Duration::ZERO,
            body: json!({
                "choices": [{
                    "message": {
                        "content": "{\"status\":\"ready\",\"estimate\":{\"label\":\"Gateway meal\",\"caloriesKcal\":250,\"proteinG\":20,\"carbsG\":30,\"fatG\":5,\"confidence\":0.8,\"notes\":[]}}"
                    }
                }]
            }),
        }])
        .await;

    let result = analyze_food_photo_url_with_limits(
        &gateway_test_state(&endpoint, Some("gpt-5.6-luna(low)")),
        "data:image/png;base64,AA==",
        "",
        None,
        "test-user",
        false,
        FoodPhotoRequestLimits {
            chat_completions_url: &endpoint,
            model_timeout: Duration::from_millis(500),
            request_timeout: Duration::from_secs(1),
        },
    )
    .await;

    assert_eq!(stub.requests.load(Ordering::SeqCst), 1);
    assert_eq!(result["ok"], json!(true));
    assert_eq!(
        result["analysis"]["estimate"]["label"],
        json!("Gateway meal")
    );
}

#[tokio::test]
async fn gateway_mode_without_api_key_fails_closed() {
    let mut state = gateway_test_state("http://127.0.0.1:9/unreachable", None);
    Arc::make_mut(&mut state.config).ai_gateway_api_key = None;

    let result = analyze_food_photo_url_with_limits(
        &state,
        "data:image/png;base64,AA==",
        "",
        None,
        "test-user",
        false,
        FoodPhotoRequestLimits {
            chat_completions_url: "http://127.0.0.1:9/unreachable",
            model_timeout: Duration::from_millis(100),
            request_timeout: Duration::from_secs(1),
        },
    )
    .await;

    assert_eq!(result["kind"], json!("missing_api_key"));
}

#[test]
fn gateway_models_come_from_config_with_luna_defaults() {
    let mut config = test_config(None);
    config.ai_gateway_url = Some("https://gateway.example".to_string());
    assert_eq!(
        configured_food_photo_models(&config),
        vec![
            "gpt-5.6-luna(low)".to_string(),
            "gpt-5.6-luna(medium)".to_string()
        ]
    );

    config.ai_gateway_models =
        Some("gpt-5.6-luna(medium), gpt-5.6-terra(low)\ngpt-5.6-luna(medium)".to_string());
    assert_eq!(
        configured_food_photo_models(&config),
        vec![
            "gpt-5.6-luna(medium)".to_string(),
            "gpt-5.6-terra(low)".to_string()
        ]
    );
}

#[test]
fn food_photo_request_body_omits_fields_reasoning_models_reject() {
    let body = serde_json::to_value(build_food_photo_request_body(
        "gpt-5.6-luna(low)",
        "data:image/png;base64,AA==",
        "",
        "user-1",
        false,
    ))
    .expect("request body should serialize");

    assert_eq!(body["model"], json!("gpt-5.6-luna(low)"));
    assert_eq!(body["max_tokens"], json!(4000));
    // Reasoning models reject temperature pins; provider-specific routing fields would be meaningless too.
    for absent in [
        "temperature",
        "provider",
        "plugins",
        "response_format",
        "reasoning",
    ] {
        assert!(
            body.get(absent).is_none(),
            "request body must not include {absent}"
        );
    }
    assert_eq!(
        body["messages"][1]["content"][1]["image_url"]["url"],
        json!("data:image/png;base64,AA==")
    );
}

#[tokio::test]
async fn a_content_less_upstream_200_is_sanitised_before_it_reaches_the_caller() {
    // API-02: a 200 with no usable message content must not echo the provider, model, or token spend.
    let (endpoint, _stub) = spawn_chat_stub(vec![ChatStubResponse {
        status: StatusCode::OK,
        delay: Duration::ZERO,
        body: json!({
            "provider": "SecretProvider",
            "model": "internal/model",
            "usage": { "total_tokens": 1234 },
            "choices": [{ "message": { "content": null } }]
        }),
    }])
    .await;

    let result = analyze_food_photo_url_with_limits(
        &gateway_test_state(&endpoint, Some("test/model-1")),
        "data:image/png;base64,AA==",
        "",
        None,
        "test-user",
        false,
        FoodPhotoRequestLimits {
            chat_completions_url: &endpoint,
            model_timeout: Duration::from_millis(100),
            request_timeout: Duration::from_secs(1),
        },
    )
    .await;

    assert_eq!(result["kind"], json!("empty_response"));
    assert_eq!(result["statusCode"], json!(502));
    assert_eq!(
        result["error"],
        json!("The AI did not return a response. Please try again.")
    );
    assert!(
        result.get("aiResponse").is_none(),
        "the upstream payload must not be forwarded: {result}"
    );
    let serialized = result.to_string();
    for leaked in ["SecretProvider", "internal/model", "1234"] {
        assert!(
            !serialized.contains(leaked),
            "response leaked {leaked:?}: {serialized}"
        );
    }
}

#[tokio::test]
async fn unparseable_model_output_is_not_echoed_back() {
    // API-02/SEC-04: when the model answers with unparseable text, it is neither returned nor logged verbatim.
    let (endpoint, _stub) = spawn_chat_stub(vec![ChatStubResponse {
        status: StatusCode::OK,
        delay: Duration::ZERO,
        body: json!({
            "choices": [{ "message": { "content": "I refuse. Internal note: SecretProvider" } }]
        }),
    }])
    .await;

    let result = analyze_food_photo_url_with_limits(
        &gateway_test_state(&endpoint, Some("test/model-1")),
        "data:image/png;base64,AA==",
        "",
        None,
        "test-user",
        false,
        FoodPhotoRequestLimits {
            chat_completions_url: &endpoint,
            model_timeout: Duration::from_millis(100),
            request_timeout: Duration::from_secs(1),
        },
    )
    .await;

    assert_eq!(result["kind"], json!("invalid_json"));
    assert_eq!(result["statusCode"], json!(502));
    assert!(result.get("aiResponse").is_none());
    assert!(!result.to_string().contains("SecretProvider"));
}

/// Shares a byte buffer with the fmt subscriber so a test can assert what did and did not reach the log.
struct CaptureWriter(Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for CaptureWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("capture lock should not be poisoned")
            .extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CaptureWriter {
    type Writer = CaptureWriter;

    fn make_writer(&'a self) -> Self::Writer {
        CaptureWriter(Arc::clone(&self.0))
    }
}

fn capture_logs<T>(run: impl FnOnce() -> T) -> (T, String) {
    let buffer = Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    let subscriber = tracing_subscriber::fmt()
        .with_writer(CaptureWriter(Arc::clone(&buffer)))
        .with_ansi(false)
        .finish();

    let result = tracing::subscriber::with_default(subscriber, run);
    let logs = String::from_utf8(
        buffer
            .lock()
            .expect("capture lock should not be poisoned")
            .clone(),
    )
    .expect("captured logs should be UTF-8");

    (result, logs)
}

fn run_gateway_analysis(response_body: Value) -> (Value, String) {
    capture_logs(move || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime should build")
            .block_on(async move {
                let (endpoint, _stub) = spawn_chat_stub(vec![ChatStubResponse {
                    status: StatusCode::OK,
                    delay: Duration::ZERO,
                    body: response_body,
                }])
                .await;
                analyze_food_photo_url_with_limits(
                    &gateway_test_state(&endpoint, Some("test/model-1")),
                    "data:image/png;base64,AA==",
                    "",
                    None,
                    "test-user",
                    false,
                    FoodPhotoRequestLimits {
                        chat_completions_url: &endpoint,
                        model_timeout: Duration::from_millis(200),
                        request_timeout: Duration::from_secs(1),
                    },
                )
                .await
            })
    })
}

/// SEC-04: malformed model output must not be copied into application logs.
#[test]
fn malformed_model_output_is_not_written_to_logs() {
    const MARKER: &str = "SENSITIVE-PHOTO-MARKER-7c1f9d";
    let (result, logs) = run_gateway_analysis(json!({
        "choices": [{ "message": { "content": format!("{MARKER} {{not json") } }]
    }));

    assert_eq!(result["kind"], json!("invalid_json"));
    assert!(
        !logs.contains(MARKER),
        "raw model output must never be logged: {logs}"
    );
    assert!(
        logs.contains("invalid_json"),
        "the failure category must stay diagnosable: {logs}"
    );
}

/// SEC-04: an upstream 200 whose payload lacks message content must not be logged verbatim.
#[test]
fn a_contentless_provider_payload_is_not_written_to_logs() {
    const MARKER: &str = "SENSITIVE-PAYLOAD-MARKER-3b8e42";
    let (result, logs) = run_gateway_analysis(json!({
        "echoedPrompt": MARKER,
        "choices": [{ "message": { "content": null } }]
    }));

    assert_eq!(result["kind"], json!("empty_response"));
    assert!(
        !logs.contains(MARKER),
        "raw provider payloads must never be logged: {logs}"
    );
    assert!(
        logs.contains("empty_response"),
        "the failure category must stay diagnosable: {logs}"
    );
}

/// SEC-04: a provider error body can describe our misconfiguration, so only the category is logged.
#[test]
fn a_provider_error_body_is_not_written_to_logs() {
    const MARKER: &str = "SENSITIVE-ERROR-MARKER-91ad";
    let (result, logs) = run_gateway_analysis(json!({
        "error": { "message": format!("{MARKER}: invalid model") }
    }));

    assert_eq!(result["statusCode"], json!(502));
    assert!(
        !logs.contains(MARKER),
        "raw provider error bodies must never be logged: {logs}"
    );
    assert!(
        logs.contains("food photo provider request failed"),
        "the failure must stay diagnosable: {logs}"
    );
}

#[tokio::test]
async fn a_transport_failure_never_reports_the_upstream_url() {
    // API-12: `reqwest::Error`'s Display embeds the request URL; a closed port makes `send()` fail outright.
    let result = analyze_food_photo_url_with_limits(
        &gateway_test_state("http://127.0.0.1:1/chat/completions", Some("test/model-1")),
        "data:image/png;base64,AA==",
        "",
        None,
        "test-user",
        false,
        FoodPhotoRequestLimits {
            chat_completions_url: "http://127.0.0.1:1/chat/completions",
            model_timeout: Duration::from_millis(200),
            request_timeout: Duration::from_secs(1),
        },
    )
    .await;

    assert_eq!(result["kind"], json!("provider_error"));
    assert_eq!(result["statusCode"], json!(502));
    assert_eq!(
        result["error"],
        json!("Photo analysis failed. Please try again.")
    );
    assert!(
        !result.to_string().contains("127.0.0.1"),
        "response leaked the upstream URL: {result}"
    );
}

#[tokio::test]
async fn a_model_that_cannot_see_images_is_reported_as_our_fault() {
    // API-13: an unsupported server-configured model is our deployment problem, not the caller's 400.
    let (endpoint, _stub) = spawn_chat_stub(vec![ChatStubResponse {
        status: StatusCode::BAD_REQUEST,
        delay: Duration::ZERO,
        body: json!({
            "error": { "message": "Model internal/text-only does not support image input." }
        }),
    }])
    .await;

    let result = analyze_food_photo_url_with_limits(
        &gateway_test_state(&endpoint, Some("test/model-1,test/model-2")),
        "data:image/png;base64,AA==",
        "",
        None,
        "test-user",
        false,
        FoodPhotoRequestLimits {
            chat_completions_url: &endpoint,
            model_timeout: Duration::from_millis(100),
            request_timeout: Duration::from_secs(1),
        },
    )
    .await;

    assert_eq!(result["kind"], json!("unsupported_model"));
    assert_eq!(result["statusCode"], json!(502));
    assert_eq!(result["retryable"], json!(false));
    assert!(
        !result.to_string().contains("internal/text-only"),
        "response leaked the provider's message: {result}"
    );
}

#[test]
fn the_prompt_caps_how_much_clarification_reaches_the_model() {
    // API-05: `clarification` must be capped like the image field, or prose could be billed as prompt tokens.
    let huge = "x".repeat(MAX_CLARIFICATION_CHARS * 4);

    let prompt = build_prompt(&huge, false);

    let carried = prompt.lines().last().expect("prompt should have lines");
    assert_eq!(carried.chars().count(), MAX_CLARIFICATION_CHARS);
    assert!(prompt.len() < MAX_CLARIFICATION_CHARS + 1_000);
}

#[test]
fn a_short_clarification_survives_intact() {
    let prompt = build_prompt("  the bowl holds 300 ml  ", false);

    assert!(prompt.ends_with("the bowl holds 300 ml"));
}

#[test]
fn truncating_a_clarification_never_splits_a_character() {
    // Multi-byte input must not be cut mid-code-point.
    let prompt = build_prompt(&"é".repeat(MAX_CLARIFICATION_CHARS + 10), false);

    let carried = prompt.lines().last().expect("prompt should have lines");
    assert_eq!(carried.chars().count(), MAX_CLARIFICATION_CHARS);
}

#[test]
fn every_benchmark_fixture_points_at_a_direct_image_file() {
    // CONCERN-C3: an article page URL serves `text/html`, not the image, silently scoring models on a web page.
    for fixture in BENCHMARK_FIXTURES {
        assert!(
            !fixture.image_url.contains("/wiki/"),
            "{}: image_url is an article page, not an image: {}",
            fixture.id,
            fixture.image_url
        );
        assert!(
            fixture.image_url.starts_with("https://"),
            "{}: image_url must be https",
            fixture.id
        );

        if fixture
            .image_source_url
            .starts_with("https://commons.wikimedia.org/")
        {
            assert!(
                fixture
                    .image_url
                    .starts_with("https://upload.wikimedia.org/wikipedia/commons/")
                    && fixture.image_url.ends_with(".jpg"),
                "{}: a Commons fixture must fetch the direct file URL, got {}",
                fixture.id,
                fixture.image_url
            );
        }
    }
}

#[test]
fn the_unreproducible_benchmark_fixtures_are_the_known_ten() {
    // `loremflickr.com` redirects to a random photo per request; pinned so this set can't grow unnoticed.
    let unreproducible = BENCHMARK_FIXTURES
        .iter()
        .filter(|fixture| fixture.image_url.contains("loremflickr.com"))
        .map(|fixture| fixture.id)
        .collect::<Vec<_>>();

    assert_eq!(
        unreproducible,
        vec![
            "medium-carrot",
            "white-bread-slice",
            "cheddar-ounce",
            "almonds-ounce",
            "rolled-oats-40g",
            "cooked-shrimp-100g",
            "cooked-salmon-100g",
            "cooked-lentils-cup",
            "whole-milk-cup",
            "nonfat-greek-yogurt-170g",
        ]
    );
}

/// `BENCHMARK_LOCK` is process-global, so the tests that drive it have to take turns.
static BENCHMARK_LOCK_TESTS: Mutex<()> = Mutex::new(());

fn clear_benchmark_lock() {
    let lock = BENCHMARK_LOCK.get_or_init(|| Mutex::new(None));
    *lock.lock().unwrap_or_else(|error| error.into_inner()) = None;
}

#[test]
fn benchmark_lock_guard_releases_on_drop() {
    let _serialized = BENCHMARK_LOCK_TESTS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    clear_benchmark_lock();

    let guard = acquire_benchmark_lock().expect("first acquire should succeed");
    assert!(
        acquire_benchmark_lock().is_none(),
        "second acquire should be blocked while guard is live"
    );

    drop(guard);

    assert!(
        acquire_benchmark_lock().is_some(),
        "dropping guard should release benchmark lock"
    );
    clear_benchmark_lock();
}

#[test]
fn an_overrunning_benchmark_run_cannot_release_its_successor() {
    // API-08: run A overruns the TTL and B legitimately takes the lock; A finishing later must not clear B's stamp.
    let _serialized = BENCHMARK_LOCK_TESTS
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    clear_benchmark_lock();

    let run_a =
        acquire_benchmark_lock_with_ttl(Duration::ZERO).expect("run A should take the lock");
    let _run_b = acquire_benchmark_lock().expect("run B should take the expired lock");

    drop(run_a);

    assert!(
        acquire_benchmark_lock().is_none(),
        "run B still holds the lock; a third run must not start"
    );
    clear_benchmark_lock();
}

async fn food_photo_test_handler(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Response {
    let mut image = None;
    while let Ok(Some(field)) = multipart.next_field().await {
        if field.name() == Some("image") {
            let content_type = field
                .content_type()
                .map(str::to_string)
                .unwrap_or_else(|| "application/octet-stream".to_string());
            let bytes = field.bytes().await.expect("test multipart should parse");
            image = Some((bytes, content_type));
        }
    }
    let (bytes, content_type) = image.expect("test image should be present");
    let result = analyze_food_photo_bytes(
        &state,
        bytes,
        &content_type,
        "",
        None,
        "00000000-0000-0000-0000-000000000001",
        false,
    )
    .await;
    legacy_json(StatusCode::BAD_REQUEST, result)
}

#[tokio::test]
async fn food_photo_body_limit_allows_images_above_axum_default_to_reach_processing() {
    let boundary = "boundary-food-photo-regression";
    let mut body = Vec::new();
    body.extend_from_slice(
            format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"photo.png\"\r\nContent-Type: image/png\r\n\r\n"
            )
            .as_bytes(),
        );
    body.extend(std::iter::repeat_n(0x89, 3 * 1024 * 1024));
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());

    let app = Router::new()
        .route(
            "/api/ai/food-photo",
            post(food_photo_test_handler).layer(DefaultBodyLimit::max(FOOD_PHOTO_BODY_LIMIT_BYTES)),
        )
        .with_state(test_state(None));
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/ai/food-photo")
                .header(
                    "content-type",
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(Body::from(body))
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_ne!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    let body = response
        .into_body()
        .collect()
        .await
        .expect("response body should collect")
        .to_bytes();
    let payload: Value = serde_json::from_slice(&body).expect("response should be json");
    assert_eq!(payload["kind"], json!("missing_api_key"));
}

#[test]
fn food_photo_data_url_matches_the_provider_data_url_contract() {
    for length in [0, 1, 2, 3, 12_287, 12_288, 12_289, 24_575, 24_576, 24_577] {
        let image = (0..length).map(|index| index as u8).collect::<Vec<_>>();
        assert_eq!(
            food_photo_data_url(&image, "image/png"),
            format!("data:image/png;base64,{}", Base64::encode_string(&image)),
            "length {length} must preserve the provider data URL"
        );
    }
}

#[tokio::test]
async fn barcode_route_falls_back_to_albert_heijn_after_open_food_facts_miss() {
    // Drives the post-authentication half of the route; the API-14 account gate needs a real database.
    let base_url = spawn_barcode_provider_stub().await;
    let state = test_state(Some(&base_url));
    let response = lookup_barcode_for_user(&state, "8712345678901".to_string()).await;

    assert_eq!(response.status(), StatusCode::OK);
    let body = response
        .into_body()
        .collect()
        .await
        .expect("response body should collect")
        .to_bytes();
    let payload: Value = serde_json::from_slice(&body).expect("response should be json");
    assert_eq!(payload["found"], json!(true));
    assert_eq!(payload["product"]["source"], json!("albert_heijn"));
    assert_eq!(payload["product"]["name"], json!("AH Test Product"));
    assert_eq!(payload["product"]["proteinG"], json!(4.2));
}

#[tokio::test]
async fn barcode_lookup_reports_saturation_as_busy_not_as_a_miss() {
    // Drain every permit; reporting saturation as `found: false` would send the user to re-enter a real product.
    let slots = barcode_lookup_slots();
    let held = slots
        .acquire_many(MAX_CONCURRENT_BARCODE_LOOKUPS as u32)
        .await
        .expect("permits should be available");

    let state = test_state(None);
    let outcome = tokio::time::timeout(
        BARCODE_LOOKUP_SLOT_WAIT_TIMEOUT + Duration::from_secs(2),
        lookup_barcode_provider_chain(&state, "8712345678901"),
    )
    .await
    .expect("the chain must give up rather than block");

    assert!(
        matches!(outcome, BarcodeLookup::Busy),
        "expected Busy, got {outcome:?}"
    );

    drop(held);
}

#[tokio::test]
async fn barcode_route_rejects_requests_without_a_session() {
    let app = router().with_state(test_state(None));
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/barcode/8712345678901")
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn barcode_route_rejects_a_session_whose_account_cannot_be_loaded() {
    // API-14: a correctly signed session for a deleted account must not reach the upstream providers.
    let state = test_state(None);
    let cookie = session_cookie(&state);
    let app = router().with_state(state);
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/barcode/8712345678901")
                .header("cookie", cookie)
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_benchmark_route_answers_the_same_way_whatever_an_anonymous_body_contains() {
    // API-09: malformed vs. well-formed JSON must not produce distinguishable statuses before the admin check.
    for body in ["{ not json", r#"{"model":"test/model:free"}"#] {
        let app = router().with_state(test_state(None));
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/admin/ai-model-benchmark")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .expect("request should build"),
            )
            .await
            .expect("request should complete");

        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "body {body:?} produced a distinguishable status"
        );
    }
}

#[test]
fn one_account_cannot_hold_every_food_photo_slot() {
    // API-04: without per-user accounting, one account could hold all global permits for the full round trip.
    let noisy = Uuid::new_v4();
    let other = Uuid::new_v4();

    let held = (0..MAX_FOOD_PHOTO_UPLOADS_PER_USER)
        .map(|_| {
            FOOD_PHOTO_USER_SLOTS
                .acquire(noisy)
                .expect("slots up to the cap should be granted")
        })
        .collect::<Vec<_>>();

    assert!(
        FOOD_PHOTO_USER_SLOTS.acquire(noisy).is_none(),
        "an account past its cap must be refused"
    );
    assert!(
        FOOD_PHOTO_USER_SLOTS.acquire(other).is_some(),
        "one noisy account must not starve everyone else"
    );

    drop(held);
    assert!(
        FOOD_PHOTO_USER_SLOTS.acquire(noisy).is_some(),
        "finishing an upload must return the slot"
    );
}

#[test]
fn released_food_photo_slots_do_not_accumulate_per_account() {
    let user_id = Uuid::new_v4();

    drop(
        FOOD_PHOTO_USER_SLOTS
            .acquire(user_id)
            .expect("slot should be granted"),
    );

    let slots = FOOD_PHOTO_USER_SLOTS
        .slots
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    assert!(
        !slots.contains_key(&user_id),
        "the map must not grow one entry per account that ever uploaded"
    );
}

/// SEC-05: one account must not be able to occupy the whole barcode provider fan-out.
#[test]
fn one_account_cannot_hold_every_barcode_slot() {
    let noisy = Uuid::new_v4();
    let other = Uuid::new_v4();

    let held = (0..MAX_BARCODE_LOOKUPS_PER_USER)
        .map(|_| {
            BARCODE_LOOKUP_USER_SLOTS
                .acquire(noisy)
                .expect("slots up to the cap should be granted")
        })
        .collect::<Vec<_>>();

    assert!(
        BARCODE_LOOKUP_USER_SLOTS.acquire(noisy).is_none(),
        "an account past its cap must be refused"
    );
    assert!(
        BARCODE_LOOKUP_USER_SLOTS.acquire(other).is_some(),
        "one noisy account must not starve everyone else"
    );

    // Cancellation and error paths drop the future's guards, releasing both counters.
    drop(held);
    assert!(
        BARCODE_LOOKUP_USER_SLOTS.acquire(noisy).is_some(),
        "finishing or cancelling a lookup must return the slot"
    );
}

#[test]
fn released_barcode_slots_do_not_accumulate_per_account() {
    let user_id = Uuid::new_v4();

    drop(
        BARCODE_LOOKUP_USER_SLOTS
            .acquire(user_id)
            .expect("slot should be granted"),
    );

    let slots = BARCODE_LOOKUP_USER_SLOTS
        .slots
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    assert!(
        !slots.contains_key(&user_id),
        "the map must not grow one entry per account that ever looked up a barcode"
    );
}

#[tokio::test]
async fn barcode_route_rejects_a_forged_session_cookie() {
    let app = router().with_state(test_state(None));
    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri("/api/barcode/8712345678901")
                .header(
                    "cookie",
                    format!("{}=not-a-real-token", auth::SESSION_COOKIE_NAME),
                )
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("request should complete");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[test]
fn provider_request_limits_stay_at_the_shipped_numbers() {
    assert_eq!(PROVIDER_REQUEST_TIMEOUT, Duration::from_secs(5));
    assert_eq!(ALBERT_HEIJN_TOKEN_TIMEOUT, Duration::from_secs(4));
    assert_eq!(MAX_PROVIDER_RESPONSE_BYTES, 2 * 1024 * 1024);
}

async fn spawn_provider_stub(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("stub listener should bind");
    let addr = listener.local_addr().expect("stub address should exist");
    tokio::spawn(async move {
        axum::serve(listener, app)
            .await
            .expect("stub server should run");
    });
    format!("http://{addr}")
}

async fn spawn_padded_open_food_facts_stub(padding: usize) -> String {
    let body = json!({
        "status": 1,
        "product": {
            "product_name": "Padded Product",
            "nutriments": { "proteins_100g": 1.0 },
            "padding": "x".repeat(padding)
        }
    })
    .to_string();
    let app = Router::new().route(
        "/api/v2/product/{*path}",
        get(move || {
            let body = body.clone();
            async move {
                (
                    [(axum::http::header::CONTENT_TYPE, "application/json")],
                    body,
                )
            }
        }),
    );
    spawn_provider_stub(app).await
}

#[tokio::test]
async fn open_food_facts_lookup_enforces_the_size_cap() {
    for (padding, expected) in [
        (
            MAX_PROVIDER_RESPONSE_BYTES - 1024,
            Some(json!("Padded Product")),
        ),
        (MAX_PROVIDER_RESPONSE_BYTES, None),
    ] {
        let base_url = spawn_padded_open_food_facts_stub(padding).await;
        let state = test_state(Some(&base_url));

        let outcome = lookup_open_food_facts(&state, "8712345678901").await;

        match expected {
            Some(name) => assert!(
                matches!(outcome, ProviderOutcome::Found(product) if product["name"] == name),
                "a body just under the cap must be accepted (padding {padding})"
            ),
            None => assert!(
                matches!(outcome, ProviderOutcome::Unavailable),
                "an unreadable body is unavailability, not a confirmed miss (padding {padding})"
            ),
        }
    }
}

/// Chunked and without `Content-Length`, so only the per-chunk check can stop this body.
async fn spawn_chunked_open_food_facts_stub() -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("stub listener should bind");
    let addr = listener.local_addr().expect("stub address should exist");
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request).await;
                let headers = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n";
                if stream.write_all(headers.as_bytes()).await.is_err() {
                    return;
                }

                let padding = "x".repeat(64 * 1024);
                let mut chunks = vec![
                    r#"{"status":1,"product":{"product_name":"Streamed Product","#.to_string(),
                    r#""nutriments":{"proteins_100g":1.0},"padding":""#.to_string(),
                ];
                chunks.extend(std::iter::repeat_n(
                    padding.clone(),
                    MAX_PROVIDER_RESPONSE_BYTES / padding.len() + 2,
                ));
                chunks.push(r#""}}"#.to_string());

                for chunk in chunks {
                    let framed = format!("{:x}\r\n{chunk}\r\n", chunk.len());
                    if stream.write_all(framed.as_bytes()).await.is_err() {
                        return;
                    }
                }
                let _ = stream.write_all(b"0\r\n\r\n").await;
            });
        }
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn open_food_facts_lookup_drops_a_streamed_body_over_the_size_cap() {
    let base_url = spawn_chunked_open_food_facts_stub().await;
    let state = test_state(Some(&base_url));

    assert!(matches!(
        lookup_open_food_facts(&state, "8712345678901").await,
        ProviderOutcome::Unavailable
    ));
}

#[tokio::test]
async fn provider_fetch_gives_up_when_the_upstream_stalls_past_its_deadline() {
    let base_url = spawn_provider_stub(Router::new().route(
        "/stall",
        get(|| async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            Json(json!({ "ok": true }))
        }),
    ))
    .await;
    let client = reqwest::Client::new();

    let started = Instant::now();
    let body = fetch_provider_json_result(
        client.get(format!("{base_url}/stall")),
        Duration::from_millis(50),
    )
    .await;

    assert!(matches!(body, Err(())));
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn provider_fetch_rejects_a_failing_status_before_reading_the_body() {
    let base_url = spawn_provider_stub(Router::new().route(
        "/failing",
        get(|| async {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "status": 1 })),
            )
        }),
    ))
    .await;
    let client = reqwest::Client::new();

    let body = fetch_provider_json_result(
        client.get(format!("{base_url}/failing")),
        PROVIDER_REQUEST_TIMEOUT,
    )
    .await;

    assert!(matches!(body, Err(())));
}

/// SEC-03: browser photo requests must prove same-origin; direct non-browser clients stay allowed.
#[test]
fn browser_photo_requests_require_same_origin_metadata() {
    let trusted = vec!["https://macro.example.com".to_string()];

    let mut same_site = HeaderMap::new();
    same_site.insert(header::ORIGIN, "https://evil.example.com".parse().unwrap());
    same_site.insert("sec-fetch-site", "same-site".parse().unwrap());
    assert!(
        !same_origin_browser_request(&same_site, &trusted),
        "a same-site sibling origin must be refused"
    );

    let mut cross_site = HeaderMap::new();
    cross_site.insert(header::ORIGIN, "https://evil.example.com".parse().unwrap());
    cross_site.insert("sec-fetch-site", "cross-site".parse().unwrap());
    assert!(!same_origin_browser_request(&cross_site, &trusted));

    let mut same_origin = HeaderMap::new();
    same_origin.insert("sec-fetch-site", "same-origin".parse().unwrap());
    assert!(same_origin_browser_request(&same_origin, &trusted));

    let mut configured_origin = HeaderMap::new();
    configured_origin.insert(header::ORIGIN, "https://macro.example.com".parse().unwrap());
    assert!(same_origin_browser_request(&configured_origin, &trusted));

    let mut contradictory = HeaderMap::new();
    contradictory.insert(header::ORIGIN, "https://macro.example.com".parse().unwrap());
    contradictory.insert("sec-fetch-site", "cross-site".parse().unwrap());
    assert!(
        !same_origin_browser_request(&contradictory, &trusted),
        "fetch metadata wins over a trusted Origin header"
    );

    // A direct non-browser client sends neither header.
    assert!(same_origin_browser_request(&HeaderMap::new(), &trusted));
}

/// API-04 stubs: what each provider answers for the barcode chain.
#[derive(Clone)]
enum StubAnswer {
    Json(Value),
    Raw(&'static str),
    Status(StatusCode),
}

impl StubAnswer {
    fn into_response(self) -> Response {
        match self {
            StubAnswer::Json(value) => Json(value).into_response(),
            StubAnswer::Raw(body) => (
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                body,
            )
                .into_response(),
            StubAnswer::Status(status) => status.into_response(),
        }
    }
}

#[derive(Clone)]
struct ProviderStubConfig {
    open_food_facts: StubAnswer,
    albert_heijn_token: StubAnswer,
    albert_heijn_search: StubAnswer,
    jumbo_search: StubAnswer,
}

impl ProviderStubConfig {
    fn all(answer: StubAnswer) -> Self {
        Self {
            open_food_facts: answer.clone(),
            albert_heijn_token: answer.clone(),
            albert_heijn_search: answer.clone(),
            jumbo_search: answer,
        }
    }

    /// Every provider answers successfully, but none carries the product.
    fn missing_products() -> Self {
        Self {
            open_food_facts: StubAnswer::Json(json!({ "status": 0 })),
            albert_heijn_token: StubAnswer::Json(json!({ "access_token": "test-token" })),
            albert_heijn_search: StubAnswer::Json(json!({ "cards": [] })),
            jumbo_search: StubAnswer::Json(json!({ "products": { "data": [] } })),
        }
    }
}

async fn spawn_provider_scenario_stub(config: ProviderStubConfig) -> String {
    let open_food_facts = config.open_food_facts.clone();
    let albert_heijn_token = config.albert_heijn_token.clone();
    let albert_heijn_search = config.albert_heijn_search.clone();
    let jumbo_search = config.jumbo_search.clone();
    let app = Router::new()
        .route(
            "/api/v2/product/{*path}",
            get(move || {
                let answer = open_food_facts.clone();
                async move { answer.into_response() }
            }),
        )
        .route(
            "/mobile-auth/v1/auth/token/anonymous",
            post(move || {
                let answer = albert_heijn_token.clone();
                async move { answer.into_response() }
            }),
        )
        .route(
            "/mobile-services/product/search/v2",
            get(move || {
                let answer = albert_heijn_search.clone();
                async move { answer.into_response() }
            }),
        )
        .route(
            "/v17/search",
            get(move || {
                let answer = jumbo_search.clone();
                async move { answer.into_response() }
            }),
        );

    spawn_provider_stub(app).await
}

async fn response_json(response: Response) -> Value {
    let body = response
        .into_body()
        .collect()
        .await
        .expect("response body should collect")
        .to_bytes();
    serde_json::from_slice(&body).expect("response should be json")
}

/// API-04: three provider outages must be reported as retryable unavailability, not as a missing product.
#[tokio::test]
async fn provider_outage_is_reported_as_unavailable_not_as_a_missing_product() {
    let base_url = spawn_provider_scenario_stub(ProviderStubConfig::all(StubAnswer::Status(
        StatusCode::SERVICE_UNAVAILABLE,
    )))
    .await;
    let state = test_state(Some(&base_url));

    let response = lookup_barcode_for_user(&state, "8712345678901".to_string()).await;

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let payload = response_json(response).await;
    assert_eq!(payload["found"], json!(false));
    assert_eq!(payload["retryable"], json!(true));
}

/// API-04: unusable provider bodies are unavailability too, not absence.
#[tokio::test]
async fn malformed_provider_bodies_are_reported_as_unavailable() {
    let base_url = spawn_provider_scenario_stub(ProviderStubConfig::all(StubAnswer::Raw(
        "<html>maintenance</html>",
    )))
    .await;
    let state = test_state(Some(&base_url));

    let response = lookup_barcode_for_user(&state, "8712345678901".to_string()).await;

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let payload = response_json(response).await;
    assert_eq!(payload["found"], json!(false));
    assert_eq!(payload["retryable"], json!(true));
}

/// API-04: a genuine miss plus a failed fallback cannot establish absence.
#[tokio::test]
async fn a_genuine_miss_with_a_failed_fallback_stays_retryable() {
    let mut config = ProviderStubConfig::missing_products();
    config.albert_heijn_token = StubAnswer::Status(StatusCode::SERVICE_UNAVAILABLE);
    let base_url = spawn_provider_scenario_stub(config).await;
    let state = test_state(Some(&base_url));

    let response = lookup_barcode_for_user(&state, "8712345678901".to_string()).await;

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let payload = response_json(response).await;
    assert_eq!(payload["found"], json!(false));
    assert_eq!(payload["retryable"], json!(true));
}

/// API-04: only every provider answering "no" produces the authoritative miss.
#[tokio::test]
async fn all_genuine_misses_still_return_not_found() {
    let base_url = spawn_provider_scenario_stub(ProviderStubConfig::missing_products()).await;
    let state = test_state(Some(&base_url));

    let response = lookup_barcode_for_user(&state, "8712345678901".to_string()).await;

    assert_eq!(response.status(), StatusCode::OK);
    let payload = response_json(response).await;
    assert_eq!(payload["found"], json!(false));
    assert_eq!(payload.get("retryable"), None);
}

/// API-04: a successful fallback wins even while another provider is down.
#[tokio::test]
async fn a_successful_fallback_wins_over_an_outage() {
    let mut config = ProviderStubConfig::missing_products();
    config.open_food_facts = StubAnswer::Status(StatusCode::SERVICE_UNAVAILABLE);
    config.albert_heijn_search = StubAnswer::Status(StatusCode::SERVICE_UNAVAILABLE);
    config.jumbo_search = StubAnswer::Json(json!({
        "products": { "data": [{ "title": "Jumbo Test Product", "id": "jumbo-1" }] }
    }));
    let base_url = spawn_provider_scenario_stub(config).await;
    let state = test_state(Some(&base_url));

    let response = lookup_barcode_for_user(&state, "8712345678901".to_string()).await;

    assert_eq!(response.status(), StatusCode::OK);
    let payload = response_json(response).await;
    assert_eq!(payload["found"], json!(true));
    assert_eq!(payload["product"]["source"], json!("jumbo"));
}
