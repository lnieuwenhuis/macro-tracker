use crate::{AppState, auth, db};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64ct::{Base64, Encoding};
use serde_json::{Map, Value, json};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const OPENROUTER_CHAT_COMPLETIONS_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_FOOD_PHOTO_MODEL: &str = "google/gemma-4-26b-a4b-it:free";
const DEFAULT_FOOD_PHOTO_FALLBACK_MODELS: &[&str] = &[
    "google/gemma-4-31b-it:free",
    "nvidia/nemotron-nano-12b-v2-vl:free",
    "openrouter/free",
];
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const FOOD_PHOTO_BODY_LIMIT_BYTES: usize = MAX_IMAGE_BYTES + 1024 * 1024;
const FOOD_PHOTO_REQUEST_TIMEOUT: Duration = Duration::from_secs(25);
const BENCHMARK_ROUTE_RUNTIME_BUDGET_MS: u64 = 270_000;
const BENCHMARK_RUN_LOCK_TTL: Duration = Duration::from_secs(300);

static BENCHMARK_LOCK: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/barcode/{barcode}", get(lookup_barcode))
        .route(
            "/api/ai/food-photo",
            post(food_photo).layer(DefaultBodyLimit::max(FOOD_PHOTO_BODY_LIMIT_BYTES)),
        )
        .route("/api/admin/ai-model-benchmark", post(admin_benchmark))
}

async fn lookup_barcode(State(state): State<AppState>, Path(barcode): Path<String>) -> Response {
    if barcode.len() < 4 || barcode.len() > 20 {
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
    {
        if !product.is_null() {
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
    }

    match lookup_barcode_provider_chain(&state, &barcode).await {
        Some(product) => legacy_json(StatusCode::OK, json!({ "found": true, "product": product })),
        None => legacy_json(
            StatusCode::OK,
            json!({ "found": false, "barcode": barcode }),
        ),
    }
}

async fn food_photo(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
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

    let mut image: Option<(Vec<u8>, String)> = None;
    let mut clarification = String::new();

    while let Ok(Some(field)) = multipart.next_field().await {
        let name = field.name().unwrap_or_default().to_string();
        if name == "clarification" {
            clarification = field.text().await.unwrap_or_default();
            continue;
        }
        if name == "image" {
            let content_type = field
                .content_type()
                .map(str::to_string)
                .unwrap_or_else(|| "application/octet-stream".to_string());
            let bytes = match field.bytes().await {
                Ok(bytes) => bytes,
                Err(_) => {
                    return legacy_json(
                        StatusCode::BAD_REQUEST,
                        json!({ "ok": false, "error": "A food photo is required.", "kind": "invalid_image" }),
                    );
                }
            };
            image = Some((bytes.to_vec(), content_type));
        }
    }

    let Some((image_bytes, mime_type)) = image else {
        return legacy_json(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": "A food photo is required." }),
        );
    };

    let result = analyze_food_photo_bytes(
        &state,
        image_bytes,
        &mime_type,
        &clarification,
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

async fn admin_benchmark(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
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

    let candidate_model = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty() && model.len() <= 160)
        .filter(|model| {
            model
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | ':' | '/' | '-'))
        });
    let Some(candidate_model) = candidate_model else {
        return legacy_json(
            StatusCode::BAD_REQUEST,
            json!({
                "ok": false,
                "error": "Enter an OpenRouter model id, for example google/gemma-4-31b-it:free."
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
    let data: Value = response.json().await.ok()?;
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

async fn lookup_barcode_provider_chain(state: &AppState, barcode: &str) -> Option<Value> {
    if let Some(product) = lookup_open_food_facts(state, barcode).await {
        return Some(product);
    }
    if let Some(product) = lookup_albert_heijn(state, barcode).await {
        return Some(product);
    }
    lookup_jumbo(state, barcode).await
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
    let search_data: Value = response.json().await.ok()?;
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
            && let Ok(detail) = response.json::<Value>().await
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
    response
        .json::<Value>()
        .await
        .ok()?
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
    let search_data: Value = response.json().await.ok()?;
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
            && let Ok(detail) = response.json::<Value>().await
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
    } else if name.contains("vet") || name.contains("fat") {
        if !name.contains("verzadigd") && !name.contains("saturat") && !name.contains("onverzadigd")
        {
            macros.fat_g = round1(value);
            *found = true;
        }
    }
}

async fn analyze_food_photo_bytes(
    state: &AppState,
    image_bytes: Vec<u8>,
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
    let model_timeout = Duration::from_millis(
        state
            .config
            .openrouter_model_timeout_ms
            .unwrap_or(10_000)
            .clamp(3_000, 30_000),
    );
    analyze_food_photo_url_with_limits(
        state,
        image_url,
        clarification,
        requested_model,
        user_id,
        force_ready,
        OPENROUTER_CHAT_COMPLETIONS_URL,
        model_timeout,
        FOOD_PHOTO_REQUEST_TIMEOUT,
    )
    .await
}

async fn analyze_food_photo_url_with_limits(
    state: &AppState,
    image_url: &str,
    clarification: &str,
    requested_model: Option<&str>,
    user_id: &str,
    force_ready: bool,
    openrouter_url: &str,
    model_timeout: Duration,
    request_timeout: Duration,
) -> Value {
    let Some(api_key) = state.config.openrouter_api_key.as_deref() else {
        return photo_failure(
            "OPENROUTER_API_KEY is not configured on the server.",
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

    let models = requested_model
        .map(|model| vec![model.trim().to_string()])
        .unwrap_or_else(|| configured_food_photo_models(&state.config));
    if let Some(non_free_model) = models.iter().find(|model| !is_free_openrouter_model(model)) {
        return json!({
            "ok": false,
            "error": format!("Food photo AI only permits free OpenRouter models. \"{non_free_model}\" is not allowed."),
            "kind": "unsupported_model",
            "retryable": false
        });
    }

    let deadline = Instant::now() + request_timeout;
    let mut last_failure = None;
    for model in models {
        let remaining_budget = deadline.saturating_duration_since(Instant::now());
        if remaining_budget.is_zero() {
            return food_photo_timeout_failure(request_timeout);
        }
        let attempt_timeout = model_timeout.min(remaining_budget);
        let attempt_uses_remaining_budget = remaining_budget <= model_timeout;
        let body =
            build_openrouter_request_body(&model, image_url, clarification, user_id, force_ready);
        let request = state
            .http
            .post(openrouter_url)
            .timeout(attempt_timeout)
            .bearer_auth(api_key)
            .header("Content-Type", "application/json")
            .header("HTTP-Referer", &state.config.app_url)
            .header("X-OpenRouter-Title", "Macro Tracker")
            .header("X-OpenRouter-Metadata", "enabled")
            .json(&body);

        match request.send().await {
            Ok(response) if !response.status().is_success() => {
                let status = response.status().as_u16();
                let error = read_openrouter_error(response).await;
                if Instant::now() >= deadline {
                    return food_photo_timeout_failure(request_timeout);
                }
                let kind = classify_food_photo_failure(&error, Some(status));
                let retryable = is_retryable_openrouter_error(&error, Some(status));
                let failure = photo_failure(&error, kind, Some(status), Some(retryable));
                if !retryable {
                    return failure;
                }
                last_failure = Some(failure);
            }
            Ok(response) => match response.json::<Value>().await {
                Ok(payload) => {
                    if let Some(message) = payload
                        .get("error")
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                    {
                        let kind = classify_food_photo_failure(message, None);
                        let retryable = is_retryable_openrouter_error(message, None);
                        let failure = photo_failure(message, kind, None, Some(retryable));
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
                        let retryable = is_retryable_openrouter_error(error, None);
                        let failure = photo_failure(error, kind, None, Some(retryable));
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
                    let Some(content) = content else {
                        last_failure = Some(json!({
                            "ok": false,
                            "error": "The AI did not return a response.",
                            "kind": "empty_response",
                            "aiResponse": payload.to_string(),
                            "retryable": true
                        }));
                        continue;
                    };
                    match parse_food_photo_analysis(&content) {
                        Ok(analysis) => return json!({ "ok": true, "analysis": analysis }),
                        Err(error) => {
                            last_failure = Some(json!({
                                "ok": false,
                                "error": error,
                                "kind": "invalid_json",
                                "aiResponse": content,
                                "retryable": true
                            }));
                        }
                    }
                }
                Err(error) => {
                    if error.is_timeout() && attempt_uses_remaining_budget {
                        return food_photo_timeout_failure(request_timeout);
                    }
                    let retryable = error.is_timeout();
                    let failure =
                        photo_failure(&error.to_string(), "provider_error", None, Some(retryable));
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
                let failure =
                    photo_failure(&error.to_string(), "provider_error", None, Some(retryable));
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

fn build_openrouter_request_body(
    model: &str,
    image_url: &str,
    clarification: &str,
    user_id: &str,
    force_ready: bool,
) -> Value {
    let prompt = build_prompt(clarification, force_ready);
    json!({
        "model": model,
        "messages": [
            { "role": "system", "content": food_photo_system_prompt() },
            {
                "role": "user",
                "content": [
                    { "type": "text", "text": prompt },
                    { "type": "image_url", "image_url": { "url": image_url } }
                ]
            }
        ],
        "user": user_id,
        "provider": { "allow_fallbacks": true },
        "plugins": [{ "id": "response-healing", "enabled": true }],
        "response_format": { "type": "json_object" },
        "temperature": 0,
        "max_tokens": 300,
        "include_reasoning": false,
        "reasoning": { "enabled": false }
    })
}

async fn read_openrouter_error(response: reqwest::Response) -> String {
    let status = response.status();
    match response.json::<Value>().await {
        Ok(payload) => {
            let message = payload
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .or_else(|| payload.get("message").and_then(Value::as_str))
                .map(str::to_string)
                .unwrap_or_else(|| {
                    format!("OpenRouter request failed with status {}.", status.as_u16())
                });
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
        Err(_) => format!("OpenRouter request failed with status {}.", status.as_u16()),
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
    let configured_primary = config
        .openrouter_model
        .as_deref()
        .map(str::trim)
        .unwrap_or_default();
    let primary = if is_free_openrouter_model(configured_primary)
        && !is_deprecated_food_photo_model(configured_primary)
    {
        configured_primary
    } else {
        DEFAULT_FOOD_PHOTO_MODEL
    };
    let fallbacks: Vec<&str> = config
        .openrouter_fallback_models
        .as_deref()
        .map(|value| {
            value
                .split([',', '\n'])
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .collect()
        })
        .unwrap_or_else(|| DEFAULT_FOOD_PHOTO_FALLBACK_MODELS.to_vec());
    let mut seen = Vec::<String>::new();
    for model in std::iter::once(primary).chain(fallbacks.into_iter()) {
        if is_free_openrouter_model(model)
            && !is_deprecated_food_photo_model(model)
            && !seen.iter().any(|seen_model| seen_model == model)
        {
            seen.push(model.to_string());
        }
    }
    if seen.is_empty() {
        vec![DEFAULT_FOOD_PHOTO_MODEL.to_string()]
    } else {
        seen
    }
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
        .unwrap_or_else(|| DEFAULT_FOOD_PHOTO_MODEL.to_string());
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
        "fixtures": fixtures.iter().map(|fixture| fixture.to_json()).collect::<Vec<_>>(),
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
        fixture.image_source_url,
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

struct BenchmarkLockGuard;

impl Drop for BenchmarkLockGuard {
    fn drop(&mut self) {
        release_benchmark_lock();
    }
}

fn acquire_benchmark_lock() -> Option<BenchmarkLockGuard> {
    let lock = BENCHMARK_LOCK.get_or_init(|| Mutex::new(None));
    let mut active = lock.lock().expect("benchmark lock poisoned");
    if active.is_some_and(|expires_at| expires_at > Instant::now()) {
        return None;
    }
    *active = Some(Instant::now() + BENCHMARK_RUN_LOCK_TTL);
    Some(BenchmarkLockGuard)
}

fn release_benchmark_lock() {
    let lock = BENCHMARK_LOCK.get_or_init(|| Mutex::new(None));
    *lock.lock().expect("benchmark lock poisoned") = None;
}

fn legacy_json(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
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

fn is_retryable_openrouter_error(error: &str, status_code: Option<u16>) -> bool {
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

fn build_prompt(clarification: &str, force_ready: bool) -> String {
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
        clarification.trim(),
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

fn is_free_openrouter_model(model: &str) -> bool {
    let model = model.trim();
    model == "openrouter/free" || model.ends_with(":free")
}

fn is_deprecated_food_photo_model(model: &str) -> bool {
    model.trim() == "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
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
            app_url: "http://localhost:3000".to_string(),
            backend_internal_secret: None,
            database_url: "postgres://postgres:***@127.0.0.1:1/macro_tracker".to_string(),
            port: 4000,
            postgres_pool_max: 1,
            session_secret: "local-test-secret".to_string(),
            shoo_base_url: "https://shoo.dev".to_string(),
            trusted_origins: vec!["http://localhost:3000".to_string()],
            admin_owner_emails: vec![],
            openrouter_api_key: None,
            openrouter_model: None,
            openrouter_fallback_models: None,
            openrouter_model_timeout_ms: None,
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
    struct OpenRouterStubResponse {
        status: StatusCode,
        delay: Duration,
        body: Value,
    }

    struct OpenRouterStubState {
        requests: AtomicUsize,
        responses: Vec<OpenRouterStubResponse>,
    }

    async fn openrouter_stub_handler(
        State(state): State<Arc<OpenRouterStubState>>,
    ) -> impl IntoResponse {
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

    async fn spawn_openrouter_stub(
        responses: Vec<OpenRouterStubResponse>,
    ) -> (String, Arc<OpenRouterStubState>) {
        let state = Arc::new(OpenRouterStubState {
            requests: AtomicUsize::new(0),
            responses,
        });
        let app = Router::new()
            .route("/chat/completions", post(openrouter_stub_handler))
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

    fn openrouter_test_state(models: &str) -> AppState {
        let mut state = test_state(None);
        state.config.openrouter_api_key = Some("test-api-key".to_string());
        state.config.openrouter_model = Some("test/primary:free".to_string());
        state.config.openrouter_fallback_models = Some(models.to_string());
        state
    }

    #[tokio::test]
    async fn food_photo_stops_after_non_retryable_provider_response() {
        let (endpoint, stub) = spawn_openrouter_stub(vec![OpenRouterStubResponse {
            status: StatusCode::UNAUTHORIZED,
            delay: Duration::ZERO,
            body: json!({ "error": { "message": "Invalid API key." } }),
        }])
        .await;

        let result = analyze_food_photo_url_with_limits(
            &openrouter_test_state("test/fallback-1:free,test/fallback-2:free"),
            "data:image/png;base64,AA==",
            "",
            None,
            "test-user",
            false,
            &endpoint,
            Duration::from_millis(100),
            Duration::from_secs(1),
        )
        .await;

        assert_eq!(stub.requests.load(Ordering::SeqCst), 1);
        assert_eq!(result["statusCode"], json!(401));
        assert_eq!(result["retryable"], json!(false));
        assert_eq!(result["error"], json!("Invalid API key."));
    }

    #[tokio::test]
    async fn food_photo_uses_fallback_after_retryable_provider_response() {
        let (endpoint, stub) = spawn_openrouter_stub(vec![
            OpenRouterStubResponse {
                status: StatusCode::SERVICE_UNAVAILABLE,
                delay: Duration::ZERO,
                body: json!({ "error": { "message": "Provider temporarily unavailable." } }),
            },
            OpenRouterStubResponse {
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
            &openrouter_test_state("test/fallback:free"),
            "data:image/png;base64,AA==",
            "",
            None,
            "test-user",
            false,
            &endpoint,
            Duration::from_millis(100),
            Duration::from_secs(1),
        )
        .await;

        assert_eq!(stub.requests.load(Ordering::SeqCst), 2);
        assert_eq!(result["ok"], json!(true));
        assert_eq!(result["analysis"]["estimate"]["label"], json!("Test meal"));
    }

    #[tokio::test]
    async fn food_photo_fallback_chain_cannot_exceed_request_deadline() {
        let delayed_retryable_failure = OpenRouterStubResponse {
            status: StatusCode::SERVICE_UNAVAILABLE,
            delay: Duration::from_millis(40),
            body: json!({ "error": { "message": "Provider temporarily unavailable." } }),
        };
        let (endpoint, stub) = spawn_openrouter_stub(vec![delayed_retryable_failure]).await;
        let started = Instant::now();

        let result = analyze_food_photo_url_with_limits(
            &openrouter_test_state(
                "test/fallback-1:free,test/fallback-2:free,test/fallback-3:free",
            ),
            "data:image/png;base64,AA==",
            "",
            None,
            "test-user",
            false,
            &endpoint,
            Duration::from_millis(60),
            Duration::from_millis(100),
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

    #[test]
    fn benchmark_lock_guard_releases_on_drop() {
        release_benchmark_lock();

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
        release_benchmark_lock();
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
                image = Some((bytes.to_vec(), content_type));
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
        let base_url = spawn_barcode_provider_stub().await;
        let app = router().with_state(test_state(Some(&base_url)));
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

    fn to_json(&self) -> Value {
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
        image_source_url: "https://loremflickr.com/512/512/yogurt,food",
        expected_source: "USDA FoodData Central, 170g plain nonfat Greek yogurt, rounded.",
        category: "dairy",
        calories: 100.0,
        protein: 17.3,
        carbs: 6.1,
        fat: 0.7,
    },
];
