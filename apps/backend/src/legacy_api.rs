use crate::{AppState, auth, db};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Multipart, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64ct::{Base64, Encoding};
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use uuid::Uuid;

/// Effort suffixes are parsed by CLIProxyAPI and mapped to the reasoning
/// parameter of the Codex backend; the fallback bumps effort in case low
/// returns unparseable JSON (invalid_json failures are retryable).
const DEFAULT_FOOD_PHOTO_MODELS: &[&str] = &["gpt-5.6-luna(low)", "gpt-5.6-luna(medium)"];
/// Reasoning happens inside the output-token budget on the Codex backend, so
/// the cap must leave room for thinking tokens on top of the ~300 tokens of
/// JSON the prompt asks for.
const FOOD_PHOTO_MAX_TOKENS: u16 = 4_000;
/// Reasoning models need headroom per attempt even at low effort.
const FOOD_PHOTO_MODEL_TIMEOUT_MS_DEFAULT: u64 = 20_000;
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const FOOD_PHOTO_BODY_LIMIT_BYTES: usize = MAX_IMAGE_BYTES + 1024 * 1024;
const FOOD_PHOTO_SLOT_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
const FOOD_PHOTO_UPLOAD_TIMEOUT: Duration = Duration::from_secs(15);
const FOOD_PHOTO_REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
const BENCHMARK_ROUTE_RUNTIME_BUDGET_MS: u64 = 270_000;
const BENCHMARK_RUN_LOCK_TTL: Duration = Duration::from_secs(300);

/// The benchmark run currently believed to be in flight.
///
/// API-08: this used to be a bare expiry stamp, and the guard's `Drop` set it
/// back to `None` unconditionally. A run that overran [`BENCHMARK_RUN_LOCK_TTL`]
/// would therefore clear the stamp of the run that had legitimately replaced
/// it, letting a third run start alongside the second — two concurrent
/// benchmarks, twice the upstream spend. The generation makes the release
/// conditional on still owning the lock.
#[derive(Clone, Copy)]
struct BenchmarkRun {
    generation: u64,
    expires_at: Instant,
}

static BENCHMARK_LOCK: OnceLock<Mutex<Option<BenchmarkRun>>> = OnceLock::new();
static BENCHMARK_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Each in-flight photo holds the decoded upload plus its base64 data URL, so
/// peak footprint is a multiple of `MAX_IMAGE_BYTES` per request. Cap how many
/// can be resident at once; excess requests wait rather than all buffering
/// concurrently.
const MAX_CONCURRENT_FOOD_PHOTO_UPLOADS: usize = 4;
static FOOD_PHOTO_SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

fn food_photo_slots() -> &'static tokio::sync::Semaphore {
    FOOD_PHOTO_SLOTS.get_or_init(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_FOOD_PHOTO_UPLOADS))
}

/// How many of the global slots any one account may hold at once.
///
/// API-04: the global semaphore alone was not enough. A single account could
/// take all four permits and hold them from before the multipart read through
/// the entire 25s upstream round trip, so every other user hit the 2s wait
/// timeout and got a 503 — one account starving the feature for everyone. Two
/// leaves room for a retry while an upload is still in flight and still keeps
/// half the capacity available to other accounts.
const MAX_FOOD_PHOTO_UPLOADS_PER_USER: usize = 2;
static FOOD_PHOTO_USER_SLOTS: OnceLock<Mutex<HashMap<Uuid, usize>>> = OnceLock::new();

fn food_photo_user_slots() -> &'static Mutex<HashMap<Uuid, usize>> {
    FOOD_PHOTO_USER_SLOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Held for the lifetime of one food-photo request; releases the account's slot
/// on drop, including on an early return or a panic.
struct FoodPhotoUserSlot {
    user_id: Uuid,
}

impl Drop for FoodPhotoUserSlot {
    fn drop(&mut self) {
        let mut slots = food_photo_user_slots()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(count) = slots.get_mut(&self.user_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                // Keeps the map bounded by the number of accounts actually
                // in flight rather than by every account that ever uploaded.
                slots.remove(&self.user_id);
            }
        }
    }
}

/// Takes one of `user_id`'s slots, or `None` if the account is already at its
/// cap. Deliberately does not wait: an account at its own limit should be told
/// so immediately rather than sitting in the shared queue.
fn acquire_food_photo_user_slot(user_id: Uuid) -> Option<FoodPhotoUserSlot> {
    let mut slots = food_photo_user_slots()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let count = slots.get(&user_id).copied().unwrap_or(0);
    if count >= MAX_FOOD_PHOTO_UPLOADS_PER_USER {
        return None;
    }
    slots.insert(user_id, count + 1);
    Some(FoodPhotoUserSlot { user_id })
}

/// Barcode lookups fan out to up to five upstream requests, each of which
/// buffers a JSON body. Bound how many lookups may be in flight at once so a
/// burst cannot multiply into unbounded concurrent reads against the
/// supermarket APIs (which rate-limit by source IP).
const MAX_CONCURRENT_BARCODE_LOOKUPS: usize = 8;
const BARCODE_LOOKUP_SLOT_WAIT_TIMEOUT: Duration = Duration::from_secs(3);
static BARCODE_LOOKUP_SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

fn barcode_lookup_slots() -> &'static tokio::sync::Semaphore {
    BARCODE_LOOKUP_SLOTS.get_or_init(|| tokio::sync::Semaphore::new(MAX_CONCURRENT_BARCODE_LOOKUPS))
}

/// Length window a barcode must fall in. Shared with `api.rs` so the public
/// token API and this session-authenticated route agree on what a barcode is
/// (API-11).
pub(crate) const MIN_BARCODE_LENGTH: usize = 4;
pub(crate) const MAX_BARCODE_LENGTH: usize = 20;

/// Largest provider response we will buffer. Without this, `response.json()`
/// reads whatever the upstream sends straight into memory.
const MAX_PROVIDER_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// Reads a JSON body with a hard byte budget, returning `None` if the upstream
/// exceeds it (or sends something that is not JSON).
async fn read_capped_json(response: reqwest::Response) -> Option<Value> {
    read_capped_json_result(response).await.ok().flatten()
}

/// [`read_capped_json`] that keeps the transport error.
///
/// `Ok(None)` means the upstream answered but the body was over budget or not
/// JSON; `Err` means the read itself failed, which the food-photo path needs in
/// order to tell a timeout from a malformed response.
async fn read_capped_json_result(
    mut response: reqwest::Response,
) -> Result<Option<Value>, reqwest::Error> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PROVIDER_RESPONSE_BYTES as u64)
    {
        return Ok(None);
    }

    let mut buffer: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if buffer.len() + chunk.len() > MAX_PROVIDER_RESPONSE_BYTES {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk);
    }

    Ok(serde_json::from_slice(&buffer).ok())
}

async fn acquire_food_photo_slot(
    slots: &tokio::sync::Semaphore,
    wait_timeout: Duration,
) -> Option<tokio::sync::SemaphorePermit<'_>> {
    tokio::time::timeout(wait_timeout, slots.acquire())
        .await
        .ok()?
        .ok()
}

#[derive(Debug)]
struct FoodPhotoUpload {
    image: Option<(Bytes, String)>,
    clarification: String,
}

async fn read_food_photo_upload(mut multipart: Multipart) -> Result<FoodPhotoUpload, ()> {
    let mut image = None;
    let mut clarification = String::new();

    loop {
        let Some(field) = multipart.next_field().await.map_err(|_| ())? else {
            break;
        };
        let name = field.name().unwrap_or_default().to_string();
        if name == "clarification" {
            clarification = field.text().await.map_err(|_| ())?;
            continue;
        }
        if name == "image" {
            let content_type = field
                .content_type()
                .map(str::to_string)
                .unwrap_or_else(|| "application/octet-stream".to_string());
            image = Some((field.bytes().await.map_err(|_| ())?, content_type));
        }
    }

    Ok(FoodPhotoUpload {
        image,
        clarification,
    })
}

#[derive(Debug, PartialEq, Eq)]
enum FoodPhotoUploadError {
    Invalid,
    TimedOut,
}

async fn await_food_photo_upload<F>(
    upload: F,
    upload_timeout: Duration,
) -> Result<FoodPhotoUpload, FoodPhotoUploadError>
where
    F: Future<Output = Result<FoodPhotoUpload, ()>>,
{
    match tokio::time::timeout(upload_timeout, upload).await {
        Ok(Ok(upload)) => Ok(upload),
        Ok(Err(())) => Err(FoodPhotoUploadError::Invalid),
        Err(_) => Err(FoodPhotoUploadError::TimedOut),
    }
}

fn retryable_food_photo_failure(error: &str) -> Response {
    legacy_json(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({ "ok": false, "error": error, "retryable": true }),
    )
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/barcode/{barcode}", get(lookup_barcode))
        .route(
            "/api/ai/food-photo",
            post(food_photo).layer(DefaultBodyLimit::max(FOOD_PHOTO_BODY_LIMIT_BYTES)),
        )
        .route("/api/admin/ai-model-benchmark", post(admin_benchmark))
}

async fn lookup_barcode(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(barcode): Path<String>,
) -> Response {
    // Every cache miss fans out to as many as five upstream requests, so this
    // has to sit behind an account gate — otherwise the backend is an open
    // amplifier for anyone who can reach it.
    //
    // API-14: this used to verify the session *signature* only, on the grounds
    // that the lookup is not user-scoped. But session tokens live for seven
    // days and are renewed on use, so a deleted or de-onboarded account kept
    // full access to the fan-out. `/api/v1/barcodes/{barcode}` gates the same
    // capability on the user record plus onboarding; the two now agree, at the
    // cost of one primary-key read per scan.
    let user = match auth::current_user_from_headers(State(state.clone()), headers).await {
        Ok(user) => user,
        Err(_) => {
            return legacy_json(
                StatusCode::UNAUTHORIZED,
                json!({ "found": false, "barcode": barcode, "error": "Authentication required." }),
            );
        }
    };
    if user.onboarding_completed_at.is_none() {
        return legacy_json(
            StatusCode::FORBIDDEN,
            json!({ "found": false, "barcode": barcode, "error": "Complete onboarding first." }),
        );
    }

    lookup_barcode_for_user(&state, barcode).await
}

async fn lookup_barcode_for_user(state: &AppState, barcode: String) -> Response {
    if barcode.len() < MIN_BARCODE_LENGTH || barcode.len() > MAX_BARCODE_LENGTH {
        return legacy_json(
            StatusCode::BAD_REQUEST,
            json!({ "found": false, "barcode": barcode, "error": "Invalid barcode" }),
        );
    }

    if let Ok(product) = db::rpc_json(
        &state.db,
        "lookupBarcodeFoodProduct",
        json!({ "barcode": barcode }),
    )
    .await
        && !product.is_null()
    {
        return legacy_json(
            StatusCode::OK,
            json!({
                "found": true,
                "product": {
                    "productId": product.get("id").cloned().unwrap_or(Value::Null),
                    "name": product.get("name").cloned().unwrap_or(Value::Null),
                    "brands": product.get("brand").cloned().unwrap_or(Value::Null),
                    "barcode": product.get("barcode").cloned().unwrap_or(Value::Null),
                    "proteinG": product.get("proteinPer100").cloned().unwrap_or(json!(0)),
                    "carbsG": product.get("carbsPer100").cloned().unwrap_or(json!(0)),
                    "fatG": product.get("fatPer100").cloned().unwrap_or(json!(0)),
                    "caloriesKcal": product.get("caloriesPer100").cloned().unwrap_or(json!(0)),
                    "servingSizeG": product.get("servingWeightG").cloned().unwrap_or(Value::Null),
                    "imageUrl": Value::Null,
                    "source": "custom"
                }
            }),
        );
    }

    match lookup_barcode_provider_chain(state, &barcode).await {
        BarcodeLookup::Found(product) => {
            legacy_json(StatusCode::OK, json!({ "found": true, "product": product }))
        }
        BarcodeLookup::NotFound => legacy_json(
            StatusCode::OK,
            json!({ "found": false, "barcode": barcode }),
        ),
        // Overload is not evidence that the product is missing. Reporting it as
        // a miss would send the user off to re-enter a product that may well
        // exist.
        BarcodeLookup::Busy => legacy_json(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({
                "found": false,
                "barcode": barcode,
                "error": "Barcode lookup is busy. Please try again.",
                "retryable": true
            }),
        ),
    }
}

async fn food_photo(
    State(state): State<AppState>,
    headers: HeaderMap,
    multipart: Multipart,
) -> Response {
    let user = match auth::current_user_from_headers(State(state.clone()), headers).await {
        Ok(user) => user,
        Err(_) => {
            return legacy_json(
                StatusCode::UNAUTHORIZED,
                json!({ "ok": false, "error": "Unauthorized." }),
            );
        }
    };
    // API-14: `/api/v1` refuses token calls until onboarding is finished; this
    // route skipped that check even though it spends money upstream.
    if user.onboarding_completed_at.is_none() {
        return legacy_json(
            StatusCode::FORBIDDEN,
            json!({ "ok": false, "error": "Complete onboarding first.", "kind": "unknown" }),
        );
    }

    // Taken before the shared permit so an account at its own limit is told
    // immediately instead of consuming the shared wait budget (API-04).
    let _user_slot = match acquire_food_photo_user_slot(user.id) {
        Some(slot) => slot,
        None => {
            return retryable_food_photo_failure(
                "You already have photo analyses running. Wait for one to finish and try again.",
            );
        }
    };

    // Held until the response is built, so the permit covers both the buffered
    // upload and the base64 payload derived from it.
    let _slot =
        match acquire_food_photo_slot(food_photo_slots(), FOOD_PHOTO_SLOT_WAIT_TIMEOUT).await {
            Some(slot) => slot,
            None => {
                return retryable_food_photo_failure("Food photo analysis is unavailable.");
            }
        };

    let upload = match await_food_photo_upload(
        read_food_photo_upload(multipart),
        FOOD_PHOTO_UPLOAD_TIMEOUT,
    )
    .await
    {
        Ok(upload) => upload,
        Err(FoodPhotoUploadError::Invalid) => {
            return legacy_json(
                StatusCode::BAD_REQUEST,
                json!({ "ok": false, "error": "A food photo is required.", "kind": "invalid_image" }),
            );
        }
        Err(FoodPhotoUploadError::TimedOut) => {
            return retryable_food_photo_failure("Food photo upload timed out. Please try again.");
        }
    };
    let Some((image_bytes, mime_type)) = upload.image else {
        return legacy_json(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": "A food photo is required." }),
        );
    };

    let result = analyze_food_photo_bytes(
        &state,
        image_bytes,
        &mime_type,
        &upload.clarification,
        None,
        &user.id.to_string(),
        false,
    )
    .await;
    let status = result
        .get("statusCode")
        .and_then(Value::as_u64)
        .and_then(|status| StatusCode::from_u16(status as u16).ok())
        .unwrap_or(if result.get("ok").and_then(Value::as_bool) == Some(true) {
            StatusCode::OK
        } else {
            StatusCode::BAD_REQUEST
        });
    legacy_json(status, result)
}

/// A benchmark request is a model id, a fixture count, a mode and at most one
/// previously returned baseline. Generous, but far below the 2 MB an
/// unauthenticated caller used to be able to make the server parse.
const MAX_BENCHMARK_REQUEST_BYTES: usize = 256 * 1024;

async fn admin_benchmark(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let content_type_is_json = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value
                .split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
        });

    let admin_user = match auth::current_user_from_headers(State(state.clone()), headers).await {
        Ok(user) => user,
        Err(_) => {
            return legacy_json(
                StatusCode::UNAUTHORIZED,
                json!({ "ok": false, "error": "Unauthorized." }),
            );
        }
    };

    if !matches!(admin_user.role.as_str(), "admin" | "owner") {
        return legacy_json(
            StatusCode::NOT_FOUND,
            json!({ "ok": false, "error": "Not found." }),
        );
    }

    // API-09: the body is read and parsed only once the caller is known to be
    // an admin. With `Json<Value>` in the signature the extractor ran first, so
    // an unauthenticated caller got 400 for malformed JSON and 401 for valid
    // JSON — a reliable existence probe for a route that deliberately 404s to
    // authenticated non-admins — and could make the server parse a 2 MB body
    // with no credentials at all. The `application/json` requirement is kept
    // from `Json<Value>`: this route authenticates from the session cookie, so
    // accepting a CORS-safelisted content type would open it to form CSRF.
    if !content_type_is_json {
        return legacy_json(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            json!({ "ok": false, "error": "Expected application/json." }),
        );
    }
    let payload = match axum::body::to_bytes(body, MAX_BENCHMARK_REQUEST_BYTES).await {
        Ok(bytes) => match serde_json::from_slice::<Value>(&bytes) {
            Ok(payload) => payload,
            Err(_) => {
                return legacy_json(
                    StatusCode::BAD_REQUEST,
                    json!({ "ok": false, "error": "Request body must be valid JSON." }),
                );
            }
        },
        Err(_) => {
            return legacy_json(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({ "ok": false, "error": "Request body is too large." }),
            );
        }
    };

    let candidate_model = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty() && model.len() <= 160)
        .filter(|model| {
            model.chars().all(|ch| {
                ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '/' | '-' | '(' | ')')
            })
        });
    let Some(candidate_model) = candidate_model else {
        return legacy_json(
            StatusCode::BAD_REQUEST,
            json!({
                "ok": false,
                "error": "Enter a model id, for example gpt-5.6-luna(low)."
            }),
        );
    };

    let fixture_limit = match payload.get("fixtureLimit").and_then(Value::as_u64) {
        Some(4) => 4,
        Some(8) => 8,
        Some(12) => 12,
        Some(18) => BENCHMARK_FIXTURES.len(),
        _ => 4,
    };
    let mode = if payload.get("mode").and_then(Value::as_str) == Some("candidate_only") {
        "candidate_only"
    } else {
        "compare"
    };

    let Some(_benchmark_lock) = acquire_benchmark_lock() else {
        return (
            StatusCode::CONFLICT,
            [("Retry-After", "10")],
            Json(json!({ "ok": false, "error": "A benchmark run is already in progress. Try again shortly." })),
        )
        .into_response();
    };

    let result = run_macro_benchmark(
        &state,
        &admin_user.id.to_string(),
        candidate_model,
        fixture_limit,
        mode,
        payload.get("baseline").cloned(),
    )
    .await;

    match result {
        Ok(result) => legacy_json(StatusCode::OK, json!({ "ok": true, "result": result })),
        Err(message) => legacy_json(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "ok": false, "error": message }),
        ),
    }
}

async fn lookup_open_food_facts(state: &AppState, barcode: &str) -> Option<Value> {
    let url = format!(
        "{}/api/v2/product/{}.json",
        state.config.open_food_facts_base_url.trim_end_matches('/'),
        url::form_urlencoded::byte_serialize(barcode.as_bytes()).collect::<String>()
    );
    let response = tokio::time::timeout(Duration::from_secs(5), state.http.get(url).send())
        .await
        .ok()?
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let data: Value = read_capped_json(response).await?;
    if data.get("status").and_then(Value::as_i64) != Some(1) {
        return None;
    }
    let product = data.get("product")?;
    let nutriments = product.get("nutriments").unwrap_or(&Value::Null);
    let name = product
        .get("product_name")
        .or_else(|| product.get("product_name_nl"))
        .or_else(|| product.get("product_name_en"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Unknown product");
    let serving_size_g = product
        .get("serving_quantity")
        .and_then(number_from_value)
        .filter(|value| *value > 0.0)
        .map(|value| json!(value))
        .unwrap_or(Value::Null);

    Some(json!({
        "name": name,
        "brands": product.get("brands").and_then(Value::as_str).unwrap_or(""),
        "barcode": barcode,
        "proteinG": safe_number(nutriments.get("proteins_100g")),
        "carbsG": safe_number(nutriments.get("carbohydrates_100g")),
        "fatG": safe_number(nutriments.get("fat_100g")),
        "caloriesKcal": safe_number(nutriments.get("energy-kcal_100g")).round() as i64,
        "servingSizeG": serving_size_g,
        "imageUrl": product.get("image_front_small_url").or_else(|| product.get("image_url")).and_then(Value::as_str),
        "source": "openfoodfacts"
    }))
}

/// Distinguishes "the catalogue does not have it" from "we could not ask".
#[derive(Debug)]
enum BarcodeLookup {
    Found(Value),
    NotFound,
    /// The concurrency limiter was saturated; the caller should retry.
    Busy,
}

async fn lookup_barcode_provider_chain(state: &AppState, barcode: &str) -> BarcodeLookup {
    // Held for the whole fan-out; dropped when this future returns.
    let slot = tokio::time::timeout(
        BARCODE_LOOKUP_SLOT_WAIT_TIMEOUT,
        barcode_lookup_slots().acquire(),
    )
    .await;

    let _slot = match slot {
        Ok(Ok(permit)) => permit,
        // Timed out waiting, or the semaphore was closed.
        Ok(Err(_)) | Err(_) => return BarcodeLookup::Busy,
    };

    // OpenFoodFacts stays a standalone first hop: it covers most barcodes, and
    // keeping it alone means a hit costs exactly one outbound request.
    if let Some(product) = lookup_open_food_facts(state, barcode).await {
        return BarcodeLookup::Found(product);
    }

    // Start both supermarket fallbacks together. Albert Heijn keeps priority,
    // but a hit there returns immediately instead of waiting for Jumbo.
    match prefer_primary_provider(
        lookup_albert_heijn(state, barcode),
        lookup_jumbo(state, barcode),
    )
    .await
    {
        Some(product) => BarcodeLookup::Found(product),
        None => BarcodeLookup::NotFound,
    }
}

async fn prefer_primary_provider<T, Primary, Fallback>(
    primary: Primary,
    fallback: Fallback,
) -> Option<T>
where
    Primary: Future<Output = Option<T>>,
    Fallback: Future<Output = Option<T>>,
{
    tokio::pin!(primary);
    tokio::pin!(fallback);

    tokio::select! {
        primary_result = &mut primary => match primary_result {
            Some(value) => Some(value),
            None => fallback.await,
        },
        fallback_result = &mut fallback => primary.await.or(fallback_result),
    }
}

async fn lookup_albert_heijn(state: &AppState, barcode: &str) -> Option<Value> {
    let token = get_albert_heijn_token(state).await?;
    let headers = |request: reqwest::RequestBuilder| {
        request
            .header("User-Agent", "Appie/8.8.2 Model/phone Android/7.0-API24")
            .header("x-application", "AHWEBSHOP")
            .bearer_auth(&token)
    };
    let base_url = state.config.albert_heijn_base_url.trim_end_matches('/');
    let search_url = format!(
        "{base_url}/mobile-services/product/search/v2?query={}&size=1",
        url::form_urlencoded::byte_serialize(barcode.as_bytes()).collect::<String>()
    );
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        headers(state.http.get(search_url)).send(),
    )
    .await
    .ok()?
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let search_data: Value = read_capped_json(response).await?;
    let product = first_albert_heijn_product(&search_data)?;

    let name = string_field(product, &["title", "description"]).unwrap_or("Unknown product");
    let brands = string_field(product, &["brand"]).unwrap_or("Albert Heijn");
    let image_url = product
        .get("images")
        .and_then(Value::as_array)
        .and_then(|images| images.first())
        .and_then(|image| image.get("url"))
        .and_then(Value::as_str)
        .or_else(|| product.get("image").and_then(Value::as_str));

    let mut calories_kcal = 0.0;
    let mut protein_g = 0.0;
    let mut carbs_g = 0.0;
    let mut fat_g = 0.0;

    if let Some(product_id) = string_field(product, &["webshopId", "hqId", "id", "productId"]) {
        let detail_url = format!(
            "{base_url}/mobile-services/product/detail/v4/fir/{}",
            url::form_urlencoded::byte_serialize(product_id.as_bytes()).collect::<String>()
        );
        if let Ok(Ok(response)) = tokio::time::timeout(
            Duration::from_secs(5),
            headers(state.http.get(detail_url)).send(),
        )
        .await
            && response.status().is_success()
            && let Some(detail) = read_capped_json(response).await
            && let Some(macros) = parse_albert_heijn_nutrients(
                detail
                    .get("nutritionInfo")
                    .or_else(|| detail.get("nutritionTable"))
                    .or_else(|| detail.get("nutrients"))
                    .or_else(|| detail.get("nix")),
            )
        {
            calories_kcal = macros.calories_kcal;
            protein_g = macros.protein_g;
            carbs_g = macros.carbs_g;
            fat_g = macros.fat_g;
        }
    }

    Some(json!({
        "name": name,
        "brands": brands,
        "barcode": barcode,
        "proteinG": protein_g,
        "carbsG": carbs_g,
        "fatG": fat_g,
        "caloriesKcal": calories_kcal,
        "servingSizeG": Value::Null,
        "imageUrl": image_url,
        "source": "albert_heijn"
    }))
}

async fn get_albert_heijn_token(state: &AppState) -> Option<String> {
    let url = format!(
        "{}/mobile-auth/v1/auth/token/anonymous",
        state.config.albert_heijn_base_url.trim_end_matches('/')
    );
    let response = tokio::time::timeout(
        Duration::from_secs(4),
        state
            .http
            .post(url)
            .header("Content-Type", "application/json")
            .header("User-Agent", "Appie/8.8.2 Model/phone Android/7.0-API24")
            .header("x-application", "AHWEBSHOP")
            .json(&json!({ "clientId": "appie" }))
            .send(),
    )
    .await
    .ok()?
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    read_capped_json(response)
        .await?
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

async fn lookup_jumbo(state: &AppState, barcode: &str) -> Option<Value> {
    let base_url = state.config.jumbo_base_url.trim_end_matches('/');
    let search_url = format!(
        "{base_url}/v17/search?q={}&offset=0&limit=1",
        url::form_urlencoded::byte_serialize(barcode.as_bytes()).collect::<String>()
    );
    let user_agent = "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36";
    let response = tokio::time::timeout(
        Duration::from_secs(5),
        state
            .http
            .get(search_url)
            .header("User-Agent", user_agent)
            .send(),
    )
    .await
    .ok()?
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let search_data: Value = read_capped_json(response).await?;
    let product = search_data
        .get("products")
        .and_then(|products| products.get("data"))
        .and_then(Value::as_array)
        .and_then(|products| products.first())?;
    let name = product
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Unknown product");
    let image_url = get_path(product, &["imageInfo", "primaryView"])
        .and_then(Value::as_array)
        .and_then(|images| images.first())
        .and_then(|image| image.get("url"))
        .and_then(Value::as_str);

    let mut calories_kcal = 0.0;
    let mut protein_g = 0.0;
    let mut carbs_g = 0.0;
    let mut fat_g = 0.0;
    if let Some(product_id) = product.get("id").and_then(Value::as_str) {
        let detail_url = format!(
            "{base_url}/v17/products/{}",
            url::form_urlencoded::byte_serialize(product_id.as_bytes()).collect::<String>()
        );
        if let Ok(Ok(response)) = tokio::time::timeout(
            Duration::from_secs(5),
            state
                .http
                .get(detail_url)
                .header("User-Agent", user_agent)
                .send(),
        )
        .await
            && response.status().is_success()
            && let Some(detail) = read_capped_json(response).await
            && let Some(macros) = parse_jumbo_nutrients(
                get_path(&detail, &["product", "data", "nutritionInfo"])
                    .or_else(|| get_path(&detail, &["product", "data", "nutrients"]))
                    .or_else(|| get_path(&detail, &["data", "nutritionInfo"]))
                    .or_else(|| get_path(&detail, &["data", "nutrients"]))
                    .or_else(|| detail.get("nutritionInfo"))
                    .or_else(|| detail.get("nutrients")),
            )
        {
            calories_kcal = macros.calories_kcal;
            protein_g = macros.protein_g;
            carbs_g = macros.carbs_g;
            fat_g = macros.fat_g;
        }
    }

    Some(json!({
        "name": name,
        "brands": "Jumbo",
        "barcode": barcode,
        "proteinG": protein_g,
        "carbsG": carbs_g,
        "fatG": fat_g,
        "caloriesKcal": calories_kcal,
        "servingSizeG": Value::Null,
        "imageUrl": image_url,
        "source": "jumbo"
    }))
}

#[derive(Default)]
struct ParsedMacros {
    calories_kcal: f64,
    protein_g: f64,
    carbs_g: f64,
    fat_g: f64,
}

fn first_albert_heijn_product(data: &Value) -> Option<&Value> {
    let cards = data
        .get("cards")
        .or_else(|| data.get("products"))
        .and_then(Value::as_array)
        .or_else(|| data.as_array())?;
    let first = cards.first()?;
    first
        .get("products")
        .and_then(Value::as_array)
        .and_then(|products| products.first())
        .or(Some(first))
}

fn string_field<'a>(value: &'a Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| value.get(*name).and_then(Value::as_str))
}

fn get_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
}

fn parse_albert_heijn_nutrients(raw: Option<&Value>) -> Option<ParsedMacros> {
    let mut macros = ParsedMacros::default();
    let mut found = false;
    fn walk(items: &[Value], macros: &mut ParsedMacros, found: &mut bool) {
        for item in items {
            let name = string_field(item, &["name", "title", "key"])
                .unwrap_or_default()
                .to_ascii_lowercase();
            let value = item
                .get("value")
                .or_else(|| item.get("valuePer100g"))
                .or_else(|| item.get("per100g"))
                .and_then(number_from_value)
                .unwrap_or(0.0);
            let unit = item
                .get("unit")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            assign_nutrient(&name, &unit, value, macros, found);
            if let Some(children) = item
                .get("nutrients")
                .or_else(|| item.get("children"))
                .or_else(|| item.get("subNutrients"))
                .and_then(Value::as_array)
            {
                walk(children, macros, found);
            }
        }
    }

    match raw? {
        Value::Array(items) => walk(items, &mut macros, &mut found),
        Value::Object(object) => {
            for key in ["nutrients", "nutritionTable", "values"] {
                if let Some(items) = object.get(key).and_then(Value::as_array) {
                    walk(items, &mut macros, &mut found);
                }
            }
        }
        _ => {}
    }
    found.then_some(macros)
}

fn parse_jumbo_nutrients(raw: Option<&Value>) -> Option<ParsedMacros> {
    let mut macros = ParsedMacros::default();
    let mut found = false;
    match raw? {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                let name = string_field(item, &["name", "key"])
                    .map(str::to_string)
                    .unwrap_or_else(|| index.to_string())
                    .to_ascii_lowercase();
                let value = item
                    .get("value")
                    .or_else(|| item.get("per100g"))
                    .and_then(number_from_value)
                    .unwrap_or_else(|| number_from_value(item).unwrap_or(0.0));
                assign_nutrient(&name, "", value, &mut macros, &mut found);
            }
        }
        Value::Object(object) => {
            for (key, value) in object {
                let nutrient_value = value
                    .get("value")
                    .or_else(|| value.get("per100g"))
                    .and_then(number_from_value)
                    .unwrap_or_else(|| number_from_value(value).unwrap_or(0.0));
                assign_nutrient(
                    &key.to_ascii_lowercase(),
                    "",
                    nutrient_value,
                    &mut macros,
                    &mut found,
                );
            }
        }
        _ => {}
    }
    found.then_some(macros)
}

fn assign_nutrient(
    name: &str,
    unit: &str,
    value: f64,
    macros: &mut ParsedMacros,
    found: &mut bool,
) {
    if name.contains("energie") || name.contains("energy") || name.contains("calor") {
        if unit.contains("kcal") || name.contains("kcal") {
            macros.calories_kcal = value.round();
            *found = true;
        }
    } else if name.contains("eiwit") || name.contains("protein") {
        macros.protein_g = round1(value);
        *found = true;
    } else if name.contains("koolhydra") || name.contains("carb") {
        if !name.contains("suiker") && !name.contains("sugar") {
            macros.carbs_g = round1(value);
            *found = true;
        }
    } else if (name.contains("vet") || name.contains("fat"))
        && !name.contains("verzadigd")
        && !name.contains("saturat")
        && !name.contains("onverzadigd")
    {
        macros.fat_g = round1(value);
        *found = true;
    }
}

async fn analyze_food_photo_bytes(
    state: &AppState,
    image_bytes: Bytes,
    mime_type: &str,
    clarification: &str,
    requested_model: Option<&str>,
    user_id: &str,
    force_ready: bool,
) -> Value {
    if !matches!(
        mime_type,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    ) {
        return photo_failure(
            "Upload a PNG, JPEG, WebP, or GIF image.",
            "invalid_image",
            None,
            None,
        );
    }
    if image_bytes.len() > MAX_IMAGE_BYTES {
        return photo_failure(
            "Image is too large. Use an image under 8 MB.",
            "invalid_image",
            None,
            None,
        );
    }
    let image_url = format!(
        "data:{mime_type};base64,{}",
        Base64::encode_string(&image_bytes)
    );
    analyze_food_photo_url(
        state,
        &image_url,
        clarification,
        requested_model,
        user_id,
        force_ready,
    )
    .await
}

async fn analyze_food_photo_url(
    state: &AppState,
    image_url: &str,
    clarification: &str,
    requested_model: Option<&str>,
    user_id: &str,
    force_ready: bool,
) -> Value {
    let Some(gateway_url) = state.config.ai_gateway_url.as_deref() else {
        tracing::error!("AI_GATEWAY_URL is not configured on the server");
        return photo_failure(
            "Photo analysis is not available on this server.",
            "missing_api_key",
            None,
            None,
        );
    };
    let model_timeout = Duration::from_millis(
        state
            .config
            .ai_gateway_model_timeout_ms
            .unwrap_or(FOOD_PHOTO_MODEL_TIMEOUT_MS_DEFAULT)
            .clamp(3_000, 30_000),
    );
    analyze_food_photo_url_with_limits(
        state,
        image_url,
        clarification,
        requested_model,
        user_id,
        force_ready,
        FoodPhotoRequestLimits {
            chat_completions_url: gateway_url,
            model_timeout,
            request_timeout: FOOD_PHOTO_REQUEST_TIMEOUT,
        },
    )
    .await
}

#[derive(Clone, Copy)]
struct FoodPhotoRequestLimits<'a> {
    chat_completions_url: &'a str,
    model_timeout: Duration,
    request_timeout: Duration,
}

async fn analyze_food_photo_url_with_limits(
    state: &AppState,
    image_url: &str,
    clarification: &str,
    requested_model: Option<&str>,
    user_id: &str,
    force_ready: bool,
    limits: FoodPhotoRequestLimits<'_>,
) -> Value {
    let FoodPhotoRequestLimits {
        chat_completions_url,
        model_timeout,
        request_timeout,
    } = limits;
    let Some(api_key) = state.config.ai_gateway_api_key.as_deref() else {
        tracing::error!("AI_GATEWAY_API_KEY is not configured on the server");
        return photo_failure(
            "Photo analysis is not available on this server.",
            "missing_api_key",
            None,
            None,
        );
    };

    if !image_url.starts_with("data:image/") {
        match url::Url::parse(image_url) {
            Ok(parsed) if parsed.scheme() == "https" => {}
            Ok(_) => {
                return photo_failure(
                    "Benchmark image URLs must use HTTPS or data:image URLs.",
                    "invalid_image",
                    None,
                    None,
                );
            }
            Err(_) => {
                return photo_failure(
                    "Benchmark image URL is invalid.",
                    "invalid_image",
                    None,
                    None,
                );
            }
        }
    }

    // API-13: the free-model allowlist that used to reject a caller-named model
    // here is gone with the OpenRouter path, so this is no longer a place where
    // "the caller asked for a model we refuse" can happen. The only remaining
    // source of `unsupported_model` is `classify_food_photo_failure` — the
    // gateway telling us the model cannot accept an image — and that is just as
    // reachable for a model out of `AI_GATEWAY_MODELS` as for a benchmark-named
    // one. It is therefore reported through `upstream_photo_failure`, which
    // owns the status (502) rather than blaming the caller with a 400.
    let models = requested_model
        .map(|model| vec![model.trim().to_string()])
        .unwrap_or_else(|| configured_food_photo_models(&state.config));

    let deadline = Instant::now() + request_timeout;
    let mut last_failure = None;
    for model in models {
        let remaining_budget = deadline.saturating_duration_since(Instant::now());
        if remaining_budget.is_zero() {
            return food_photo_timeout_failure(request_timeout);
        }
        let attempt_timeout = model_timeout.min(remaining_budget);
        let attempt_uses_remaining_budget = remaining_budget <= model_timeout;
        let request = state
            .http
            .post(chat_completions_url)
            .timeout(attempt_timeout)
            .bearer_auth(api_key)
            .header("Content-Type", "application/json")
            .json(&build_food_photo_request_body(
                &model,
                image_url,
                clarification,
                user_id,
                force_ready,
            ));

        match request.send().await {
            Ok(response) if !response.status().is_success() => {
                let status = response.status().as_u16();
                let error = read_upstream_error(response).await;
                if Instant::now() >= deadline {
                    return food_photo_timeout_failure(request_timeout);
                }
                let kind = classify_food_photo_failure(&error, Some(status));
                let retryable = is_retryable_upstream_error(&error, Some(status));
                let failure = upstream_photo_failure(&error, kind, Some(status), retryable);
                if !retryable {
                    return failure;
                }
                last_failure = Some(failure);
            }
            // CLEAN-C1: the same byte budget every barcode provider is read
            // under. `response.json()` buffered whatever the gateway sent.
            Ok(response) => match read_capped_json_result(response).await {
                Ok(None) => {
                    let failure = upstream_photo_failure(
                        "provider body was not JSON within the size budget",
                        "empty_response",
                        None,
                        true,
                    );
                    last_failure = Some(failure);
                    continue;
                }
                Ok(Some(payload)) => {
                    if let Some(message) = payload
                        .get("error")
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                    {
                        let kind = classify_food_photo_failure(message, None);
                        let retryable = is_retryable_upstream_error(message, None);
                        let failure = upstream_photo_failure(message, kind, None, retryable);
                        if !retryable {
                            return failure;
                        }
                        last_failure = Some(failure);
                        continue;
                    }

                    let choice = payload
                        .get("choices")
                        .and_then(Value::as_array)
                        .and_then(|choices| choices.first());
                    if choice
                        .and_then(|item| item.get("finish_reason"))
                        .and_then(Value::as_str)
                        == Some("error")
                    {
                        let error = choice
                            .and_then(|item| item.get("error"))
                            .and_then(|error| error.get("message"))
                            .and_then(Value::as_str)
                            .unwrap_or("The AI provider returned an error.");
                        let kind = classify_food_photo_failure(error, None);
                        let retryable = is_retryable_upstream_error(error, None);
                        let failure = upstream_photo_failure(error, kind, None, retryable);
                        if !retryable {
                            return failure;
                        }
                        last_failure = Some(failure);
                        continue;
                    }

                    let content = choice
                        .and_then(|item| item.get("message"))
                        .and_then(|message| message.get("content"))
                        .and_then(extract_message_content);
                    // API-02: the upstream payload used to be echoed back as
                    // `aiResponse`. It carries `provider`, `model`, `usage`
                    // (token counts and spend) and any provider-side error
                    // text, so it goes to the log and never to the browser —
                    // the same rule every other upstream failure follows.
                    let Some(content) = content else {
                        last_failure = Some(upstream_photo_failure(
                            &payload.to_string(),
                            "empty_response",
                            None,
                            true,
                        ));
                        continue;
                    };
                    match parse_food_photo_analysis(&content) {
                        Ok(analysis) => return json!({ "ok": true, "analysis": analysis }),
                        Err(error) => {
                            last_failure = Some(upstream_photo_failure(
                                &format!("{error} Model output: {content}"),
                                "invalid_json",
                                None,
                                true,
                            ));
                        }
                    }
                }
                Err(error) => {
                    if error.is_timeout() && attempt_uses_remaining_budget {
                        return food_photo_timeout_failure(request_timeout);
                    }
                    let retryable = error.is_timeout();
                    let failure = upstream_photo_failure(
                        &error.to_string(),
                        "provider_error",
                        None,
                        retryable,
                    );
                    if !retryable {
                        return failure;
                    }
                    last_failure = Some(failure);
                }
            },
            Err(error) => {
                if error.is_timeout() && attempt_uses_remaining_budget {
                    return food_photo_timeout_failure(request_timeout);
                }
                let retryable = error.is_timeout();
                // API-12: `reqwest::Error`'s Display embeds the request URL, so
                // the raw string must not reach the caller.
                let failure =
                    upstream_photo_failure(&error.to_string(), "provider_error", None, retryable);
                if !retryable {
                    return failure;
                }
                last_failure = Some(failure);
            }
        }
    }

    last_failure.unwrap_or_else(|| {
        json!({ "ok": false, "error": "The AI request failed.", "kind": "unknown", "retryable": false })
    })
}

fn food_photo_timeout_failure(request_timeout: Duration) -> Value {
    photo_failure(
        &format!(
            "Food photo AI request timed out after {}ms.",
            request_timeout.as_millis()
        ),
        "provider_error",
        None,
        Some(false),
    )
}

#[derive(Serialize)]
struct ChatSystemMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct ChatUserMessage<'a> {
    role: &'a str,
    content: (ChatTextContent, ChatImageContent<'a>),
}

#[derive(Serialize)]
struct ChatTextContent {
    #[serde(rename = "type")]
    kind: &'static str,
    text: String,
}

#[derive(Serialize)]
struct ChatImageContent<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    image_url: ChatImageUrl<'a>,
}

#[derive(Serialize)]
struct ChatImageUrl<'a> {
    url: &'a str,
}

/// Chat-completions body for the AI gateway (an OpenAI-compatible endpoint,
/// normally CLIProxyAPI in front of the Codex backend). Reasoning effort
/// travels in the model id suffix, e.g. `gpt-5.6-luna(low)`. `temperature`
/// is omitted because reasoning models reject it; JSON-only output is
/// enforced by the prompt and re-checked by the parser.
#[derive(Serialize)]
struct FoodPhotoRequest<'a> {
    model: &'a str,
    messages: (ChatSystemMessage<'a>, ChatUserMessage<'a>),
    user: &'a str,
    max_tokens: u16,
}

fn build_food_photo_request_body<'a>(
    model: &'a str,
    image_url: &'a str,
    clarification: &str,
    user_id: &'a str,
    force_ready: bool,
) -> FoodPhotoRequest<'a> {
    FoodPhotoRequest {
        model,
        messages: (
            ChatSystemMessage {
                role: "system",
                content: food_photo_system_prompt(),
            },
            ChatUserMessage {
                role: "user",
                content: (
                    ChatTextContent {
                        kind: "text",
                        text: build_prompt(clarification, force_ready),
                    },
                    ChatImageContent {
                        kind: "image_url",
                        image_url: ChatImageUrl { url: image_url },
                    },
                ),
            },
        ),
        // CLEAN-C2: deliberate. The chat-completions `user` field is the
        // per-end-user abuse-attribution and rate-limiting key, so a stable
        // per-account identifier is required for a shared API key not to be
        // throttled as one caller. The
        // account UUID is an opaque internal identifier — no email, name or
        // other personal data is sent — and it is the same value the rest of
        // the system already logs.
        user: user_id,
        max_tokens: FOOD_PHOTO_MAX_TOKENS,
    }
}

async fn read_upstream_error(response: reqwest::Response) -> String {
    let status = response.status();
    match response.json::<Value>().await {
        Ok(payload) => {
            let message = payload
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .or_else(|| payload.get("message").and_then(Value::as_str))
                .map(str::to_string)
                .unwrap_or_else(|| format!("AI request failed with status {}.", status.as_u16()));
            let detail = payload
                .get("error")
                .and_then(|error| error.get("metadata"))
                .and_then(metadata_detail)
                .or_else(|| {
                    payload
                        .get("openrouter_metadata")
                        .and_then(|metadata| metadata.get("summary"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            detail.map_or(message.clone(), |detail| format!("{message} ({detail})"))
        }
        Err(_) => format!("AI request failed with status {}.", status.as_u16()),
    }
}

fn parse_food_photo_analysis(content: &str) -> Result<Value, String> {
    let parsed: Value = serde_json::from_str(strip_markdown_fence(content))
        .map_err(|_| "The AI returned an invalid response.".to_string())?;
    let Some(record) = parsed.as_object() else {
        return Err("The AI returned an invalid response.".to_string());
    };

    if record.get("status").and_then(Value::as_str) == Some("needs_clarification") {
        let question = record
            .get("question")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if question.is_empty() {
            return Err("The AI did not include a clarification question.".to_string());
        }
        return Ok(
            json!({ "status": "needs_clarification", "question": question, "estimate": Value::Null }),
        );
    }

    if record.get("status").and_then(Value::as_str) != Some("ready") {
        return Err("The AI returned an unknown status.".to_string());
    }
    let estimate = normalize_estimate(record.get("estimate"))
        .ok_or_else(|| "The AI did not include a usable nutrition estimate.".to_string())?;
    Ok(json!({ "status": "ready", "question": Value::Null, "estimate": estimate }))
}

fn normalize_estimate(value: Option<&Value>) -> Option<Value> {
    let record = value?.as_object()?;
    let label = record.get("label")?.as_str()?.trim();
    if label.is_empty() {
        return None;
    }
    let calories = number_from_value(record.get("caloriesKcal")?)?;
    let protein = number_from_value(record.get("proteinG")?)?;
    let carbs = number_from_value(record.get("carbsG")?)?;
    let fat = number_from_value(record.get("fatG")?)?;
    let confidence = number_from_value(record.get("confidence")?)?;
    if ![calories, protein, carbs, fat, confidence]
        .iter()
        .all(|value| value.is_finite())
    {
        return None;
    }
    let notes = record
        .get("notes")
        .and_then(Value::as_array)
        .map(|notes| {
            notes
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|note| !note.is_empty())
                .take(3)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Some(json!({
        "label": label,
        "caloriesKcal": calories.round().max(0.0) as i64,
        "proteinG": round1(protein).max(0.0),
        "carbsG": round1(carbs).max(0.0),
        "fatG": round1(fat).max(0.0),
        "confidence": round2(confidence.clamp(0.0, 1.0)),
        "notes": notes
    }))
}

fn configured_food_photo_models(config: &crate::config::Config) -> Vec<String> {
    let mut seen = Vec::<String>::new();
    for model in config
        .ai_gateway_models
        .as_deref()
        .unwrap_or_default()
        .split([',', '\n'])
        .map(str::trim)
        .filter(|model| !model.is_empty())
    {
        if !seen.iter().any(|seen_model| seen_model == model) {
            seen.push(model.to_string());
        }
    }
    if seen.is_empty() {
        return DEFAULT_FOOD_PHOTO_MODELS
            .iter()
            .map(|model| model.to_string())
            .collect();
    }
    seen
}

async fn run_macro_benchmark(
    state: &AppState,
    user_id: &str,
    candidate_model: &str,
    fixture_limit: usize,
    mode: &str,
    baseline: Option<Value>,
) -> Result<Value, String> {
    let current_model = configured_food_photo_models(&state.config)
        .first()
        .cloned()
        .unwrap_or_else(|| DEFAULT_FOOD_PHOTO_MODELS[0].to_string());
    let fixtures = BENCHMARK_FIXTURES
        .iter()
        .take(fixture_limit)
        .collect::<Vec<_>>();
    let compared_same_model = mode == "compare" && candidate_model == current_model;
    let baseline_created_at = baseline
        .as_ref()
        .and_then(|value| value.get("createdAt"))
        .and_then(Value::as_str)
        .filter(|_| mode == "compare")
        .map(str::to_string);
    let used_baseline = baseline_created_at.is_some();
    let deadline = Instant::now() + Duration::from_millis(BENCHMARK_ROUTE_RUNTIME_BUDGET_MS);
    let mut cases = Vec::new();
    let mut current_results = Vec::new();
    let mut candidate_results = Vec::new();

    for fixture in &fixtures {
        let current = if mode == "candidate_only" {
            skipped_result(&current_model, "Not run in candidate-only mode.", "unknown")
        } else if Instant::now() >= deadline {
            skipped_result(
                &current_model,
                "Skipped to keep the benchmark within the route runtime budget.",
                "skipped",
            )
        } else {
            run_fixture_for_model(state, fixture, &current_model, user_id).await
        };
        let candidate = if compared_same_model {
            current.clone()
        } else if Instant::now() >= deadline {
            skipped_result(
                candidate_model,
                "Skipped to keep the benchmark within the route runtime budget.",
                "skipped",
            )
        } else {
            run_fixture_for_model(state, fixture, candidate_model, user_id).await
        };
        current_results.push(current.clone());
        candidate_results.push(candidate.clone());
        cases.push(json!({
            "fixtureId": fixture.id,
            "fixtureName": fixture.name,
            "servingDescription": fixture.serving_description,
            "thumbnailUrl": format!("/benchmark-foods/{}", fixture.asset_file_name),
            "imageSourceUrl": fixture.image_source_url,
            "expected": fixture.expected_json(),
            "expectedSource": fixture.expected_source,
            "category": fixture.category,
            "current": current,
            "candidate": candidate
        }));
    }

    Ok(json!({
        "currentModel": current_model,
        "candidateModel": candidate_model,
        "fixtureCount": fixtures.len(),
        "totalFixtureCount": BENCHMARK_FIXTURES.len(),
        "comparedSameModel": compared_same_model,
        "mode": mode,
        "usedBaseline": used_baseline,
        "baselineCreatedAt": baseline_created_at,
        "fixtures": fixtures.iter().map(|fixture| fixture.as_json()).collect::<Vec<_>>(),
        "cases": cases,
        "summaries": {
            "current": if mode == "candidate_only" { Value::Null } else { summarize_model(&current_model, &current_results, &fixtures) },
            "candidate": summarize_model(candidate_model, &candidate_results, &fixtures)
        }
    }))
}

async fn run_fixture_for_model(
    state: &AppState,
    fixture: &BenchmarkFixture,
    model: &str,
    user_id: &str,
) -> Value {
    let started = Instant::now();
    let clarification = format!("Benchmark fixture: {}", fixture.serving_description);
    let result = analyze_food_photo_url(
        state,
        // The direct file URL, not the Commons article page — see
        // `BenchmarkFixture::image_url`.
        fixture.image_url,
        &clarification,
        Some(model),
        user_id,
        true,
    )
    .await;
    let latency_ms = started.elapsed().as_millis() as i64;
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return json!({
            "model": model,
            "ok": false,
            "latencyMs": latency_ms,
            "estimate": Value::Null,
            "absoluteError": Value::Null,
            "normalizedErrorPct": Value::Null,
            "error": result.get("error").and_then(Value::as_str).unwrap_or("The AI request failed."),
            "failureKind": result.get("kind").and_then(Value::as_str).unwrap_or("unknown"),
            "retryable": result.get("retryable").and_then(Value::as_bool)
        });
    }
    let estimate = result
        .get("analysis")
        .and_then(|analysis| analysis.get("estimate"))
        .cloned()
        .unwrap_or(Value::Null);
    let error = calculate_error(&estimate, fixture);
    json!({
        "model": model,
        "ok": true,
        "latencyMs": latency_ms,
        "estimate": estimate,
        "absoluteError": error.0,
        "normalizedErrorPct": error.1,
        "error": Value::Null
    })
}

fn calculate_error(estimate: &Value, fixture: &BenchmarkFixture) -> (Value, f64) {
    let calories = estimate
        .get("caloriesKcal")
        .and_then(number_from_value)
        .unwrap_or(0.0);
    let protein = estimate
        .get("proteinG")
        .and_then(number_from_value)
        .unwrap_or(0.0);
    let carbs = estimate
        .get("carbsG")
        .and_then(number_from_value)
        .unwrap_or(0.0);
    let fat = estimate
        .get("fatG")
        .and_then(number_from_value)
        .unwrap_or(0.0);
    let abs_calories = (calories - fixture.calories).abs();
    let abs_protein = (protein - fixture.protein).abs();
    let abs_carbs = (carbs - fixture.carbs).abs();
    let abs_fat = (fat - fixture.fat).abs();
    let normalized = ((abs_calories / fixture.calories.max(50.0))
        + (abs_protein / fixture.protein.max(5.0))
        + (abs_carbs / fixture.carbs.max(5.0))
        + (abs_fat / fixture.fat.max(5.0)))
        / 4.0
        * 100.0;
    (
        json!({
            "caloriesKcal": abs_calories.round() as i64,
            "proteinG": round1(abs_protein),
            "carbsG": round1(abs_carbs),
            "fatG": round1(abs_fat)
        }),
        round1(normalized),
    )
}

fn summarize_model(model: &str, results: &[Value], fixtures: &[&BenchmarkFixture]) -> Value {
    let successful = results
        .iter()
        .filter(|result| result.get("ok").and_then(Value::as_bool) == Some(true))
        .collect::<Vec<_>>();
    let attempted = results
        .iter()
        .filter(|result| {
            result.get("wasSkipped").and_then(Value::as_bool) != Some(true)
                && result.get("latencyMs").and_then(Value::as_i64).is_some()
        })
        .collect::<Vec<_>>();
    let mut failure_breakdown = empty_failure_breakdown();
    for result in results {
        if result.get("wasSkipped").and_then(Value::as_bool) == Some(true) {
            increment_breakdown(&mut failure_breakdown, "skipped");
        } else if result.get("ok").and_then(Value::as_bool) != Some(true) {
            let kind = result
                .get("failureKind")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            increment_breakdown(&mut failure_breakdown, kind);
        }
    }
    let mut category_averages = empty_category_averages();
    for category in CATEGORIES {
        let values = results
            .iter()
            .enumerate()
            .filter_map(|(index, result)| {
                if fixtures
                    .get(index)
                    .is_some_and(|fixture| fixture.category == category)
                {
                    result.get("normalizedErrorPct").and_then(number_from_value)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>();
        if !values.is_empty() {
            category_averages.insert(category.to_string(), json!(round1(average(&values))));
        }
    }
    let latencies = attempted
        .iter()
        .filter_map(|result| {
            result
                .get("latencyMs")
                .and_then(Value::as_i64)
                .map(|value| value as f64)
        })
        .collect::<Vec<_>>();
    let errors = successful
        .iter()
        .filter_map(|result| result.get("normalizedErrorPct").and_then(number_from_value))
        .collect::<Vec<_>>();
    json!({
        "model": model,
        "completedCases": successful.len(),
        "failedCases": results.iter().filter(|result| result.get("ok").and_then(Value::as_bool) != Some(true) && result.get("wasSkipped").and_then(Value::as_bool) != Some(true)).count(),
        "skippedCases": results.iter().filter(|result| result.get("wasSkipped").and_then(Value::as_bool) == Some(true)).count(),
        "averageLatencyMs": if latencies.is_empty() { Value::Null } else { json!(average(&latencies).round() as i64) },
        "averageErrorPct": if errors.is_empty() { Value::Null } else { json!(round1(average(&errors))) },
        "reliabilityPct": if results.is_empty() { 0.0 } else { round1((successful.len() as f64 / results.len() as f64) * 100.0) },
        "failureBreakdown": failure_breakdown,
        "categoryAverages": category_averages
    })
}

fn skipped_result(model: &str, error: &str, failure_kind: &str) -> Value {
    json!({
        "model": model,
        "ok": false,
        "latencyMs": Value::Null,
        "estimate": Value::Null,
        "absoluteError": Value::Null,
        "normalizedErrorPct": Value::Null,
        "error": error,
        "failureKind": if failure_kind == "skipped" { "unknown" } else { failure_kind },
        "retryable": false,
        "wasSkipped": true
    })
}

struct BenchmarkLockGuard {
    generation: u64,
}

impl Drop for BenchmarkLockGuard {
    fn drop(&mut self) {
        release_benchmark_lock(self.generation);
    }
}

fn acquire_benchmark_lock() -> Option<BenchmarkLockGuard> {
    acquire_benchmark_lock_with_ttl(BENCHMARK_RUN_LOCK_TTL)
}

fn acquire_benchmark_lock_with_ttl(ttl: Duration) -> Option<BenchmarkLockGuard> {
    let lock = BENCHMARK_LOCK.get_or_init(|| Mutex::new(None));
    // Poison recovery: the guarded value is a plain stamp, so a panic elsewhere
    // must not permanently wedge the benchmark route.
    let mut active = lock.lock().unwrap_or_else(|error| error.into_inner());
    if active.is_some_and(|run| run.expires_at > Instant::now()) {
        return None;
    }
    let generation = BENCHMARK_GENERATION.fetch_add(1, Ordering::Relaxed);
    *active = Some(BenchmarkRun {
        generation,
        expires_at: Instant::now() + ttl,
    });
    Some(BenchmarkLockGuard { generation })
}

/// Clears the lock only if `generation` still owns it. A run that outlived its
/// TTL has already been replaced, so its release is a no-op.
fn release_benchmark_lock(generation: u64) {
    let lock = BENCHMARK_LOCK.get_or_init(|| Mutex::new(None));
    let mut active = lock.lock().unwrap_or_else(|error| error.into_inner());
    if active.is_some_and(|run| run.generation == generation) {
        *active = None;
    }
}

fn legacy_json(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

/// Copy shown to the user for an upstream AI-provider failure.
///
/// The provider's own message is never forwarded: it can carry
/// `metadata.raw`, `provider_name`, and — for a misconfigured deployment —
/// details of *our* server-side problem dressed up as the caller's fault.
fn public_provider_message(kind: &str) -> &'static str {
    match kind {
        "provider_quota" => "Photo analysis is temporarily unavailable. Please try again later.",
        "provider_rate_limit" => "Photo analysis is busy right now. Please try again in a minute.",
        "provider_image_access" => "That image could not be read. Try taking the photo again.",
        "unsupported_model" => "Photo analysis is temporarily unavailable. Please try again later.",
        "empty_response" => "The AI did not return a response. Please try again.",
        "invalid_json" => "The AI returned a result we could not read. Please try again.",
        _ => "Photo analysis failed. Please try again.",
    }
}

/// Status *we* own for an upstream failure. The provider's status is logged,
/// never reflected: a provider 401 (our key) or 402 (our credits) must not
/// reach the browser as an authentication or payment error.
fn public_provider_status(kind: &str) -> u16 {
    match kind {
        "provider_rate_limit" => 429,
        _ => 502,
    }
}

/// Builds a failure from an upstream response, logging the raw provider text
/// and exposing only the stable `kind` plus server-owned copy and status.
fn upstream_photo_failure(
    provider_error: &str,
    kind: &str,
    provider_status: Option<u16>,
    retryable: bool,
) -> Value {
    tracing::warn!(
        provider_status = ?provider_status,
        kind,
        provider_error,
        "food photo provider request failed"
    );

    photo_failure(
        public_provider_message(kind),
        kind,
        Some(public_provider_status(kind)),
        Some(retryable),
    )
}

fn photo_failure(
    error: &str,
    kind: &str,
    status_code: Option<u16>,
    retryable: Option<bool>,
) -> Value {
    let mut object = Map::from_iter([
        ("ok".to_string(), Value::Bool(false)),
        ("error".to_string(), Value::String(error.to_string())),
        ("kind".to_string(), Value::String(kind.to_string())),
    ]);
    if let Some(status_code) = status_code {
        object.insert("statusCode".to_string(), json!(status_code));
    }
    if let Some(retryable) = retryable {
        object.insert("retryable".to_string(), json!(retryable));
    }
    Value::Object(object)
}

fn extract_message_content(value: &Value) -> Option<String> {
    if let Some(content) = value.as_str() {
        return Some(content.to_string());
    }
    value
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<String>()
                .trim()
                .to_string()
        })
        .filter(|content| !content.is_empty())
}

fn strip_markdown_fence(content: &str) -> &str {
    let trimmed = content.trim();
    if trimmed.starts_with("```") && trimmed.ends_with("```") {
        let without_start = trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim();
        without_start.trim_end_matches("```").trim()
    } else {
        trimmed
    }
}

fn metadata_detail(metadata: &Value) -> Option<String> {
    let raw = metadata
        .get("raw")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let provider = metadata
        .get("provider_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let details = [
        (!provider.is_empty()).then(|| format!("Provider: {provider}")),
        (!raw.is_empty()).then(|| raw.to_string()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(". ");
    (!details.is_empty()).then_some(details)
}

fn classify_food_photo_failure(error: &str, status_code: Option<u16>) -> &'static str {
    let lower = error.to_lowercase();
    if lower.contains("insufficient_quota")
        || lower.contains("insufficient funds")
        || lower.contains("insufficient_funds")
        || lower.contains("balance is too low")
        || lower.contains("/billing")
    {
        return "provider_quota";
    }
    if lower.contains("free-models-per-min")
        || lower.contains("rate limit")
        || lower.contains("rate-limit")
        || lower.contains("rate limited")
        || lower.contains("temporarily rate-limited")
        || status_code == Some(429)
    {
        return "provider_rate_limit";
    }
    if status_code == Some(403)
        && lower.contains("forbidden")
        && (lower.contains("image")
            || lower.contains(".jpg")
            || lower.contains(".jpeg")
            || lower.contains(".png")
            || lower.contains(".webp"))
    {
        return "provider_image_access";
    }
    if lower.contains("unsupported image")
        || lower.contains("does not support image")
        || lower.contains("doesn't support image")
        || lower.contains("vision is not supported")
        || lower.contains("not support vision")
    {
        return "unsupported_model";
    }
    if status_code.is_some() {
        return "provider_error";
    }
    "unknown"
}

fn is_retryable_upstream_error(error: &str, status_code: Option<u16>) -> bool {
    let lower = error.to_lowercase();
    let kind = classify_food_photo_failure(error, status_code);
    if matches!(
        kind,
        "provider_quota" | "provider_image_access" | "unsupported_model"
    ) {
        return false;
    }
    matches!(status_code, Some(408 | 409 | 429))
        || status_code.is_some_and(|status| status >= 500)
        || lower.contains("rate-limit")
        || lower.contains("rate limited")
        || lower.contains("temporarily")
        || lower.contains("timeout")
        || lower.contains("overload")
        || lower.contains("upstream")
}

/// API-05: the `clarification` multipart field had no cap while the image field
/// was capped at [`MAX_IMAGE_BYTES`], so a caller could push ~9 MB of prose
/// straight into the model prompt while holding a concurrency slot — paying for
/// the tokens and the latency. A clarification is one sentence of context ("the
/// bowl is 300 ml"); anything past this is not a clarification.
const MAX_CLARIFICATION_CHARS: usize = 500;

fn build_prompt(clarification: &str, force_ready: bool) -> String {
    let clarification = clarification.trim();
    let clarification = match clarification.char_indices().nth(MAX_CLARIFICATION_CHARS) {
        Some((byte_index, _)) => &clarification[..byte_index],
        None => clarification,
    };
    let ready_line = if force_ready {
        "This is a benchmark fixture with a known serving size. Do not ask a clarification question; return status ready."
    } else {
        "If the photo is too ambiguous, return status needs_clarification with one question."
    };
    [
        "Estimate calories, protein, carbs, and fat for the visible edible portion.",
        "If clarification is already provided, use it and return the best estimate.",
        ready_line,
        "Keep notes short and only include assumptions.",
        "Return only the JSON object matching the schema.",
        clarification,
    ]
    .into_iter()
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n")
}

fn food_photo_system_prompt() -> &'static str {
    "You are a food photo nutrition estimator for a macro tracking app.\n\
You must return exactly one valid JSON object and no other text.\n\
The first character of your response must be { and the last character must be }.\n\
Do not wrap the JSON in markdown fences.\n\
All numeric values must describe the visible edible portion in the photo, not per 100g unless the visible portion is 100g.\n\
Use grams for proteinG, carbsG, and fatG. Use kilocalories for caloriesKcal.\n\
Use confidence as a number from 0 to 1.\n\
If the main food or portion size is too ambiguous, ask exactly one concise question.\n\
Ready response format:\n\
{\"status\":\"ready\",\"question\":null,\"estimate\":{\"label\":\"short food name\",\"caloriesKcal\":0,\"proteinG\":0,\"carbsG\":0,\"fatG\":0,\"confidence\":0.8,\"notes\":[\"short assumption\"]}}\n\
Clarification response format:\n\
{\"status\":\"needs_clarification\",\"question\":\"one short question\",\"estimate\":null}"
}

fn safe_number(value: Option<&Value>) -> f64 {
    value.and_then(number_from_value).map(round1).unwrap_or(0.0)
}

fn number_from_value(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().replace(',', ".").parse::<f64>().ok(),
        _ => None,
    }
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn average(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}

fn empty_failure_breakdown() -> Map<String, Value> {
    [
        "missing_api_key",
        "invalid_image",
        "provider_rate_limit",
        "provider_quota",
        "provider_image_access",
        "provider_error",
        "empty_response",
        "invalid_json",
        "unsupported_model",
        "unknown",
        "skipped",
    ]
    .into_iter()
    .map(|kind| (kind.to_string(), json!(0)))
    .collect()
}

fn increment_breakdown(map: &mut Map<String, Value>, kind: &str) {
    let current = map.get(kind).and_then(Value::as_i64).unwrap_or(0);
    map.insert(kind.to_string(), json!(current + 1));
}

#[cfg(test)]
mod tests {
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
            config: test_config(provider_base_url),
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
        state.config.ai_gateway_url = Some(endpoint.to_string());
        state.config.ai_gateway_api_key = Some("test-gateway-key".to_string());
        state.config.ai_gateway_models = models.map(str::to_string);
        state
    }

    #[tokio::test]
    async fn barcode_provider_race_returns_fast_ah_without_waiting_for_slow_jumbo() {
        let result = tokio::time::timeout(
            Duration::from_millis(50),
            prefer_primary_provider(
                async { Some(json!("albert_heijn")) },
                std::future::pending::<Option<Value>>(),
            ),
        )
        .await
        .expect("a fast Albert Heijn hit should not wait for Jumbo");

        assert_eq!(result, Some(json!("albert_heijn")));
    }

    #[tokio::test]
    async fn barcode_provider_race_returns_jumbo_after_ah_miss() {
        let result =
            prefer_primary_provider(async { None::<Value> }, async { Some(json!("jumbo")) }).await;

        assert_eq!(result, Some(json!("jumbo")));
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
        // The provider's 401 is our misconfiguration, not the caller's: it must
        // surface as a server-owned 502 with none of the upstream text.
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
        state.config.ai_gateway_api_key = None;

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
        // Reasoning models reject temperature pins, and provider-specific
        // routing fields would be meaningless or rejected upstream.
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
        // API-02: a 200 whose payload carries no usable `choices[0].message
        // .content` is a common outcome. The payload names the provider, the
        // model and the token spend; none of it may be echoed.
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
        // API-02, second branch: the model answered, but not with the JSON we
        // asked for. The raw text is logged, not returned.
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

    #[tokio::test]
    async fn a_transport_failure_never_reports_the_upstream_url() {
        // API-12: `reqwest::Error`'s Display embeds the request URL. Point the
        // client at a closed port so `send()` fails outright.
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
        // API-13, re-decided against the gateway code. The free-model allowlist
        // is gone, so `unsupported_model` no longer describes a model the
        // *caller* named — here it comes out of a server-configured model in
        // `AI_GATEWAY_MODELS`, which is a deployment problem. It must not be
        // returned as the caller's 400, and the provider's wording (which names
        // the model) must not be forwarded either.
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
        // API-05: `clarification` had no cap while the image field was capped
        // at 8 MB, so ~9 MB of prose could be billed as prompt tokens.
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
        // CONCERN-C3: every fixture used to hand the provider a
        // `commons.wikimedia.org/wiki/File:...` article URL, which serves
        // `text/html`. Every benchmark was scoring models against a web page.
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
        // `loremflickr.com` redirects to a different random photo per request,
        // so these fixtures score models against an image nobody chose and
        // cannot be compared across runs. Pinned so the set cannot grow
        // unnoticed and so replacing them is visible as a test change.
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

    /// `BENCHMARK_LOCK` is process-global, so the tests that drive it have to
    /// take turns.
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
        // API-08: run A overruns the TTL, so run B legitimately takes the lock.
        // A finishing afterwards must not clear B's stamp — doing so let a
        // third run start alongside B and doubled the upstream spend.
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
                post(food_photo_test_handler)
                    .layer(DefaultBodyLimit::max(FOOD_PHOTO_BODY_LIMIT_BYTES)),
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

    #[tokio::test]
    async fn barcode_route_falls_back_to_albert_heijn_after_open_food_facts_miss() {
        // Drives the post-authentication half of the route: the account gate
        // added for API-14 needs a real database, which this stub-backed test
        // deliberately does not have.
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
        // Drain every permit so the next acquisition times out. Reporting that
        // as `found: false` would send the user off to re-enter a product that
        // may well exist.
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
        // API-14: a correctly signed cookie used to be sufficient, so a 7-day
        // session belonging to a deleted account still fanned out to five
        // upstream providers. The account must now resolve.
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
        // API-09: `Json<Value>` ran before the admin check, so malformed JSON
        // returned 400 and well-formed JSON returned 401 — a reliable way for
        // an unauthenticated caller to confirm a route that deliberately 404s
        // to authenticated non-admins.
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
        // API-04: without per-user accounting a single account could take all
        // four global permits and hold them for the full upstream round trip.
        let noisy = Uuid::new_v4();
        let other = Uuid::new_v4();

        let held = (0..MAX_FOOD_PHOTO_UPLOADS_PER_USER)
            .map(|_| {
                acquire_food_photo_user_slot(noisy).expect("slots up to the cap should be granted")
            })
            .collect::<Vec<_>>();

        assert!(
            acquire_food_photo_user_slot(noisy).is_none(),
            "an account past its cap must be refused"
        );
        assert!(
            acquire_food_photo_user_slot(other).is_some(),
            "one noisy account must not starve everyone else"
        );

        drop(held);
        assert!(
            acquire_food_photo_user_slot(noisy).is_some(),
            "finishing an upload must return the slot"
        );
    }

    #[test]
    fn released_food_photo_slots_do_not_accumulate_per_account() {
        let user_id = Uuid::new_v4();

        drop(acquire_food_photo_user_slot(user_id).expect("slot should be granted"));

        let slots = food_photo_user_slots()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        assert!(
            !slots.contains_key(&user_id),
            "the map must not grow one entry per account that ever uploaded"
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
}

fn empty_category_averages() -> Map<String, Value> {
    CATEGORIES
        .into_iter()
        .map(|category| (category.to_string(), Value::Null))
        .collect()
}

#[derive(Clone, Copy)]
struct BenchmarkFixture {
    id: &'static str,
    name: &'static str,
    serving_description: &'static str,
    asset_file_name: &'static str,
    /// The URL whose bytes are handed to the model.
    ///
    /// For the Wikimedia fixtures this is the direct `upload.wikimedia.org`
    /// file URL. **Do not "tidy" it back into a
    /// `commons.wikimedia.org/wiki/File:...` article URL** — those serve
    /// `text/html`, so every run would score the model against a web page
    /// instead of a photo. The pasta fixture keeps its parentheses
    /// percent-encoded for the same reason.
    ///
    /// The ten `loremflickr.com` fixtures are **not** yet resolved: that
    /// service redirects to a different random keyword-matching photo on every
    /// request, so those fixtures cannot be reproducible and their expected
    /// macros describe a serving no particular photo shows. They are left
    /// as-is pending replacement images.
    image_url: &'static str,
    /// Human-facing Commons article page, linked from the admin UI for
    /// attribution and licensing. Never fetched.
    image_source_url: &'static str,
    expected_source: &'static str,
    category: &'static str,
    calories: f64,
    protein: f64,
    carbs: f64,
    fat: f64,
}

impl BenchmarkFixture {
    fn expected_json(&self) -> Value {
        json!({
            "caloriesKcal": self.calories,
            "proteinG": self.protein,
            "carbsG": self.carbs,
            "fatG": self.fat
        })
    }

    fn as_json(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "servingDescription": self.serving_description,
            "assetFileName": self.asset_file_name,
            "thumbnailUrl": format!("/benchmark-foods/{}", self.asset_file_name),
            "imageSourceUrl": self.image_source_url,
            "expected": self.expected_json(),
            "expectedSource": self.expected_source,
            "category": self.category
        })
    }
}

const CATEGORIES: [&str; 7] = [
    "fruit",
    "protein",
    "grain",
    "vegetable",
    "dairy",
    "fat",
    "legume",
];

const BENCHMARK_FIXTURES: &[BenchmarkFixture] = &[
    BenchmarkFixture {
        id: "medium-banana",
        name: "Medium banana",
        serving_description: "One medium banana, edible portion only.",
        asset_file_name: "banana.jpg",
        image_url: "https://upload.wikimedia.org/wikipedia/commons/8/8a/Banana-Single.jpg",
        image_source_url: "https://commons.wikimedia.org/wiki/File:Banana-Single.jpg",
        expected_source: "USDA FoodData Central, one medium banana, rounded.",
        category: "fruit",
        calories: 105.0,
        protein: 1.3,
        carbs: 27.0,
        fat: 0.4,
    },
    BenchmarkFixture {
        id: "medium-red-apple",
        name: "Medium red apple",
        serving_description: "One medium raw apple with skin.",
        asset_file_name: "apple.jpg",
        image_url: "https://upload.wikimedia.org/wikipedia/commons/1/15/Red_Apple.jpg",
        image_source_url: "https://commons.wikimedia.org/wiki/File:Red_Apple.jpg",
        expected_source: "USDA FoodData Central, one medium apple with skin, rounded.",
        category: "fruit",
        calories: 95.0,
        protein: 0.5,
        carbs: 25.1,
        fat: 0.3,
    },
    BenchmarkFixture {
        id: "large-hard-boiled-egg",
        name: "Large hard-boiled egg",
        serving_description: "One large hard-boiled egg.",
        asset_file_name: "hard-boiled-egg.jpg",
        image_url: "https://upload.wikimedia.org/wikipedia/commons/c/c3/Hard_boiled_egg.jpg",
        image_source_url: "https://commons.wikimedia.org/wiki/File:Hard_boiled_egg.jpg",
        expected_source: "USDA FoodData Central, one large hard-boiled egg, rounded.",
        category: "protein",
        calories: 78.0,
        protein: 6.3,
        carbs: 0.6,
        fat: 5.3,
    },
    BenchmarkFixture {
        id: "medium-orange",
        name: "Medium orange",
        serving_description: "One medium raw orange, peeled edible portion.",
        asset_file_name: "orange.jpg",
        image_url: "https://upload.wikimedia.org/wikipedia/commons/4/43/Ambersweet_oranges.jpg",
        image_source_url: "https://commons.wikimedia.org/wiki/File:Ambersweet_oranges.jpg",
        expected_source: "USDA FoodData Central, one medium orange, rounded.",
        category: "fruit",
        calories: 62.0,
        protein: 1.2,
        carbs: 15.4,
        fat: 0.2,
    },
    BenchmarkFixture {
        id: "cooked-white-rice-cup",
        name: "Cooked white rice",
        serving_description: "One cup cooked long-grain white rice.",
        asset_file_name: "white-rice.jpg",
        image_url: "https://upload.wikimedia.org/wikipedia/commons/1/16/Cooked_white_rice.jpg",
        image_source_url: "https://commons.wikimedia.org/wiki/File:Cooked_white_rice.jpg",
        expected_source: "USDA FoodData Central, one cup cooked white rice, rounded.",
        category: "grain",
        calories: 205.0,
        protein: 4.3,
        carbs: 44.5,
        fat: 0.4,
    },
    BenchmarkFixture {
        id: "cooked-pasta-cup",
        name: "Cooked spaghetti",
        serving_description: "One cup cooked plain spaghetti pasta.",
        asset_file_name: "pasta.jpg",
        image_url: "https://upload.wikimedia.org/wikipedia/commons/3/3f/%28Pasta%29_by_David_Adam_Kess_%28pic.2%29.jpg",
        image_source_url: "https://commons.wikimedia.org/wiki/File:(Pasta)_by_David_Adam_Kess_(pic.2).jpg",
        expected_source: "USDA FoodData Central, one cup cooked spaghetti, rounded.",
        category: "grain",
        calories: 221.0,
        protein: 8.1,
        carbs: 43.2,
        fat: 1.3,
    },
    BenchmarkFixture {
        id: "half-avocado",
        name: "Half avocado",
        serving_description: "One half medium raw avocado.",
        asset_file_name: "avocado.jpg",
        image_url: "https://upload.wikimedia.org/wikipedia/commons/f/f0/Liat_Portal_for_Foodie_Disorder_-_Avocado_halves.jpg",
        image_source_url: "https://commons.wikimedia.org/wiki/File:Liat_Portal_for_Foodie_Disorder_-_Avocado_halves.jpg",
        expected_source: "USDA FoodData Central, half medium avocado, rounded.",
        category: "fat",
        calories: 120.0,
        protein: 1.5,
        carbs: 6.4,
        fat: 11.0,
    },
    BenchmarkFixture {
        id: "cooked-broccoli-cup",
        name: "Cooked broccoli",
        serving_description: "One cup cooked chopped broccoli.",
        asset_file_name: "broccoli.jpg",
        image_url: "https://upload.wikimedia.org/wikipedia/commons/4/48/Broccoli_florets_on_ice.jpg",
        image_source_url: "https://commons.wikimedia.org/wiki/File:Broccoli_florets_on_ice.jpg",
        expected_source: "USDA FoodData Central, one cup cooked broccoli, rounded.",
        category: "vegetable",
        calories: 55.0,
        protein: 3.7,
        carbs: 11.2,
        fat: 0.6,
    },
    BenchmarkFixture {
        id: "medium-carrot",
        name: "Medium carrot",
        serving_description: "One medium raw carrot.",
        asset_file_name: "carrot.jpg",
        // Unresolved: see `image_url` — this fixture has no stable
        // source image.
        image_url: "https://loremflickr.com/512/512/carrot,food",
        image_source_url: "https://loremflickr.com/512/512/carrot,food",
        expected_source: "USDA FoodData Central, one medium raw carrot, rounded.",
        category: "vegetable",
        calories: 25.0,
        protein: 0.6,
        carbs: 5.8,
        fat: 0.1,
    },
    BenchmarkFixture {
        id: "white-bread-slice",
        name: "White bread slice",
        serving_description: "One regular slice white bread.",
        asset_file_name: "white-bread.jpg",
        // Unresolved: see `image_url` — this fixture has no stable
        // source image.
        image_url: "https://loremflickr.com/512/512/toast,food",
        image_source_url: "https://loremflickr.com/512/512/toast,food",
        expected_source: "USDA FoodData Central, one slice white bread, rounded.",
        category: "grain",
        calories: 75.0,
        protein: 2.6,
        carbs: 13.8,
        fat: 1.0,
    },
    BenchmarkFixture {
        id: "cheddar-ounce",
        name: "Cheddar cheese",
        serving_description: "One ounce cheddar cheese.",
        asset_file_name: "cheddar.jpg",
        // Unresolved: see `image_url` — this fixture has no stable
        // source image.
        image_url: "https://loremflickr.com/512/512/cheddar,food",
        image_source_url: "https://loremflickr.com/512/512/cheddar,food",
        expected_source: "USDA FoodData Central, one ounce cheddar cheese, rounded.",
        category: "dairy",
        calories: 113.0,
        protein: 6.4,
        carbs: 0.9,
        fat: 9.3,
    },
    BenchmarkFixture {
        id: "almonds-ounce",
        name: "Raw almonds",
        serving_description: "One ounce raw almonds.",
        asset_file_name: "almonds.jpg",
        // Unresolved: see `image_url` — this fixture has no stable
        // source image.
        image_url: "https://loremflickr.com/512/512/almonds,food",
        image_source_url: "https://loremflickr.com/512/512/almonds,food",
        expected_source: "USDA FoodData Central, one ounce raw almonds, rounded.",
        category: "fat",
        calories: 164.0,
        protein: 6.0,
        carbs: 6.1,
        fat: 14.2,
    },
    BenchmarkFixture {
        id: "rolled-oats-40g",
        name: "Rolled oats",
        serving_description: "Forty grams dry rolled oats.",
        asset_file_name: "oats.jpg",
        // Unresolved: see `image_url` — this fixture has no stable
        // source image.
        image_url: "https://loremflickr.com/512/512/oats,food",
        image_source_url: "https://loremflickr.com/512/512/oats,food",
        expected_source: "Common nutrition label serving, 40g dry rolled oats.",
        category: "grain",
        calories: 150.0,
        protein: 5.0,
        carbs: 27.0,
        fat: 3.0,
    },
    BenchmarkFixture {
        id: "cooked-shrimp-100g",
        name: "Cooked shrimp",
        serving_description: "One hundred grams cooked shrimp.",
        asset_file_name: "shrimp.jpg",
        // Unresolved: see `image_url` — this fixture has no stable
        // source image.
        image_url: "https://loremflickr.com/512/512/prawn,food",
        image_source_url: "https://loremflickr.com/512/512/prawn,food",
        expected_source: "USDA FoodData Central, 100g cooked shrimp, rounded.",
        category: "protein",
        calories: 99.0,
        protein: 24.0,
        carbs: 0.2,
        fat: 0.3,
    },
    BenchmarkFixture {
        id: "cooked-salmon-100g",
        name: "Cooked salmon",
        serving_description: "One hundred grams cooked Atlantic salmon.",
        asset_file_name: "salmon.jpg",
        // Unresolved: see `image_url` — this fixture has no stable
        // source image.
        image_url: "https://loremflickr.com/512/512/salmon,food",
        image_source_url: "https://loremflickr.com/512/512/salmon,food",
        expected_source: "USDA FoodData Central, 100g cooked Atlantic salmon, rounded.",
        category: "protein",
        calories: 206.0,
        protein: 22.1,
        carbs: 0.0,
        fat: 12.4,
    },
    BenchmarkFixture {
        id: "cooked-lentils-cup",
        name: "Cooked lentils",
        serving_description: "One cup cooked lentils.",
        asset_file_name: "lentils.jpg",
        // Unresolved: see `image_url` — this fixture has no stable
        // source image.
        image_url: "https://loremflickr.com/512/512/lentils,food",
        image_source_url: "https://loremflickr.com/512/512/lentils,food",
        expected_source: "USDA FoodData Central, one cup cooked lentils, rounded.",
        category: "legume",
        calories: 230.0,
        protein: 17.9,
        carbs: 39.9,
        fat: 0.8,
    },
    BenchmarkFixture {
        id: "whole-milk-cup",
        name: "Whole milk",
        serving_description: "One cup whole milk.",
        asset_file_name: "whole-milk.jpg",
        // Unresolved: see `image_url` — this fixture has no stable
        // source image.
        image_url: "https://loremflickr.com/512/512/milk,food",
        image_source_url: "https://loremflickr.com/512/512/milk,food",
        expected_source: "USDA FoodData Central, one cup whole milk, rounded.",
        category: "dairy",
        calories: 149.0,
        protein: 7.7,
        carbs: 11.7,
        fat: 7.9,
    },
    BenchmarkFixture {
        id: "nonfat-greek-yogurt-170g",
        name: "Greek yogurt",
        serving_description: "One 170g serving plain nonfat Greek yogurt.",
        asset_file_name: "greek-yogurt.jpg",
        // Unresolved: see `image_url` — this fixture has no stable
        // source image.
        image_url: "https://loremflickr.com/512/512/yogurt,food",
        image_source_url: "https://loremflickr.com/512/512/yogurt,food",
        expected_source: "USDA FoodData Central, 170g plain nonfat Greek yogurt, rounded.",
        category: "dairy",
        calories: 100.0,
        protein: 17.3,
        carbs: 6.1,
        fat: 0.7,
    },
];
