use crate::{AppState, db, errors::AppError, shared::round1};
use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{
        Path, State,
        rejection::{BytesRejection, PathRejection},
    },
    http::{HeaderMap, Method, StatusCode, Uri, header},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Map, Value, json};
use uuid::Uuid;

const CORS_ALLOW_ORIGIN: &str = "*";
const CORS_ALLOW_METHODS: &str = "GET, POST, PATCH, DELETE, OPTIONS";
const CORS_ALLOW_HEADERS: &str = "Authorization, Content-Type";
const CORS_MAX_AGE: &str = "86400";
const API_V1_OPENAPI_JSON: &[u8] = include_bytes!("generated/api-v1-openapi.json");
/// Deadline for a single `/api/v1` request. Matches the backend's other data
/// routes; see `handle_api_v1` for why it is not a tower layer.
pub const API_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

type ApiResult<T> = Result<T, ApiFailure>;

#[derive(Debug)]
struct ApiFailure {
    status: StatusCode,
    code: &'static str,
    message: String,
    allow: Option<String>,
}

impl ApiFailure {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            allow: None,
        }
    }

    fn with_allow(mut self, allow: String) -> Self {
        self.allow = Some(allow);
        self
    }
}

/// One `/api/v1` endpoint shape.
///
/// `path` is the OpenAPI path template published at `/openapi.json`; a segment
/// wrapped in braces is a wildcard when routing. Routing and the published
/// contract share this one literal so the scope-contract tests can derive their
/// coverage from [`API_V1_ENDPOINTS`] instead of restating it by hand (API-01).
#[derive(Clone, Copy)]
struct Endpoint {
    path: &'static str,
    methods: &'static [&'static str],
    scopes: &'static [(&'static str, &'static [&'static str])],
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", any(api_v1_root))
        .route("/{*path}", any(api_v1_request))
}

// API-06: `Bytes` and `Path` are taken as `Result`s rather than as plain
// extractors. An extractor that rejects does so *before* the handler runs, so
// an over-limit body came back as a bare `413` with a plain-text body and none
// of the CORS headers below — a browser client saw a CORS failure instead of
// the documented error envelope, and a direct client got a body it could not
// parse. Handling the rejection inside the handler keeps every `/api/v1`
// response one shape.
async fn api_v1_root(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    handle_api_v1(state, method, uri, headers, Ok(Vec::new()), body).await
}

async fn api_v1_request(
    State(state): State<AppState>,
    path: Result<Path<String>, PathRejection>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let path = path.map(|Path(path)| {
        path.split('/')
            .filter(|segment| !segment.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    });
    handle_api_v1(state, method, uri, headers, path, body).await
}

async fn handle_api_v1(
    state: AppState,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    path: Result<Vec<String>, PathRejection>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    if method == Method::OPTIONS {
        return empty_response(StatusCode::NO_CONTENT, None);
    }

    // A path we could not even decode cannot name an endpoint.
    let Ok(path) = path else {
        return failure_response(ApiFailure::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "API endpoint not found.",
        ));
    };

    if method == Method::GET && path.as_slice() == ["openapi.json"] {
        return static_json_response(API_V1_OPENAPI_JSON);
    }

    let body = match body {
        Ok(body) => body,
        Err(rejection) => return failure_response(body_rejection_failure(&rejection)),
    };

    // The deadline is enforced here rather than by a transport-level timeout
    // layer: a layer would emit a bare 504 with no body and none of the CORS
    // headers below, which breaks the documented error envelope for direct API
    // clients and shows up as a CORS failure in browsers.
    let result = async {
        let method_name = method.as_str();
        let endpoint = endpoint_for(&path).ok_or_else(|| {
            ApiFailure::new(
                StatusCode::NOT_FOUND,
                "not_found",
                "API endpoint not found.",
            )
        })?;
        if !endpoint.methods.contains(&method_name) {
            let allow = endpoint
                .methods
                .iter()
                .chain(["OPTIONS"].iter())
                .copied()
                .collect::<Vec<_>>()
                .join(", ");
            return Err(ApiFailure::new(
                StatusCode::METHOD_NOT_ALLOWED,
                "method_not_allowed",
                "Method is not allowed for this endpoint.",
            )
            .with_allow(allow));
        }

        // API-01: an endpoint that allows a method but declares no scopes for it
        // is a server-side contract bug. Refusing is the only safe reading —
        // the previous empty-slice default let any valid token through.
        let Some(scopes) = required_scopes(&endpoint, method_name) else {
            tracing::error!(
                endpoint = endpoint.path,
                method = method_name,
                "endpoint allows a method it declares no scopes for"
            );
            return Err(internal_error());
        };
        let auth = authenticate_request(&state, &headers, scopes).await?;
        dispatch_api_request(&state, method_name, &uri, &path, body, auth).await
    };

    let result = match tokio::time::timeout(API_REQUEST_TIMEOUT, result).await {
        Ok(result) => result,
        Err(_) => Err(ApiFailure::new(
            StatusCode::GATEWAY_TIMEOUT,
            "timeout",
            "The request took too long to complete.",
        )),
    };

    match result {
        Ok((status, data)) => json_response(status, json!({ "ok": true, "data": data }), None),
        Err(failure) => failure_response(failure),
    }
}

fn failure_response(failure: ApiFailure) -> Response {
    json_response(
        failure.status,
        json!({
            "ok": false,
            "error": {
                "code": failure.code,
                "message": failure.message
            }
        }),
        failure.allow.as_deref(),
    )
}

/// Translates an extractor rejection into the documented envelope (API-06).
fn body_rejection_failure(rejection: &BytesRejection) -> ApiFailure {
    if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
        return ApiFailure::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "payload_too_large",
            "Request body is too large.",
        );
    }
    bad_request("Request body could not be read.")
}

#[derive(Clone)]
struct ApiAuth {
    user_id: Uuid,
    scopes: Vec<String>,
}

async fn authenticate_request(
    state: &AppState,
    headers: &HeaderMap,
    scopes: &[&str],
) -> ApiResult<ApiAuth> {
    let token = bearer_token(headers)?;
    let auth = db::authenticate_api_token(&state.db, &token)
        .await
        .map_err(api_failure_from_app_error)?;
    if !auth.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let reason = auth
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("invalid");
        let (code, message) = auth_error(reason);
        return Err(ApiFailure::new(StatusCode::UNAUTHORIZED, code, message));
    }

    let token = auth
        .get("token")
        .and_then(Value::as_object)
        .ok_or_else(internal_error)?;
    let user_id = token
        .get("userId")
        .and_then(Value::as_str)
        .ok_or_else(internal_error)
        .and_then(|value| Uuid::parse_str(value).map_err(|_| internal_error()))?;
    let token_scopes = token
        .get("scopes")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let user = db::get_user_by_id(&state.db, user_id)
        .await
        .map_err(api_failure_from_app_error)?
        .ok_or_else(|| {
            ApiFailure::new(
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                "API token is invalid.",
            )
        })?;
    if user.onboarding_completed_at.is_none() {
        return Err(ApiFailure::new(
            StatusCode::FORBIDDEN,
            "onboarding_required",
            "Complete onboarding before using API tokens.",
        ));
    }
    if let Some(missing) = scopes
        .iter()
        .find(|scope| !token_scopes.iter().any(|owned| owned == **scope))
    {
        return Err(ApiFailure::new(
            StatusCode::FORBIDDEN,
            "insufficient_scope",
            format!("API token is missing required scope: {missing}."),
        ));
    }

    Ok(ApiAuth {
        user_id,
        scopes: token_scopes,
    })
}

async fn dispatch_api_request(
    state: &AppState,
    method: &str,
    uri: &Uri,
    path: &[String],
    body: Bytes,
    auth: ApiAuth,
) -> ApiResult<(StatusCode, Value)> {
    let resource = path.first().map(String::as_str);
    let id = path.get(1).map(String::as_str);
    let action = path.get(2).map(String::as_str);

    match (resource, id, action, method) {
        (Some("me"), None, None, "GET") => {
            let user = rpc(state, "getUserById", json!({ "userId": auth.user_id })).await?;
            let goals = rpc(state, "getUserGoals", json!({ "userId": auth.user_id })).await?;
            Ok((
                StatusCode::OK,
                json!({ "user": map_account(user), "goals": goals }),
            ))
        }
        (Some("goals"), None, None, "GET") => Ok((
            StatusCode::OK,
            rpc(state, "getUserGoals", json!({ "userId": auth.user_id })).await?,
        )),
        (Some("goals"), None, None, "PATCH") => {
            let current = rpc(state, "getUserGoals", json!({ "userId": auth.user_id })).await?;
            let goals = merge_goals(current, read_json(&body)?)?;
            rpc(
                state,
                "saveUserGoals",
                json!({ "userId": auth.user_id, "goals": goals }),
            )
            .await?;
            Ok((
                StatusCode::OK,
                rpc(state, "getUserGoals", json!({ "userId": auth.user_id })).await?,
            ))
        }
        (Some("days"), Some(date), None, "GET") => {
            require_date(date)?;
            Ok((
                StatusCode::OK,
                rpc(
                    state,
                    "getDailySummary",
                    json!({ "userId": auth.user_id, "date": date }),
                )
                .await?,
            ))
        }
        (Some("days"), Some(date), Some("entries"), "POST") => {
            require_date(date)?;
            let mut input = require_object(read_json(&body)?)?;
            if has_non_null(&input, "productId")
                && !auth.scopes.iter().any(|scope| scope == "read:foods")
            {
                return Err(insufficient_scope("read:foods"));
            }
            input.insert("date".to_string(), Value::String(date.to_string()));
            let entry = rpc(
                state,
                "createMealEntry",
                json!({ "userId": auth.user_id, "input": input }),
            )
            .await?;
            Ok((StatusCode::CREATED, entry))
        }
        (Some("meal-entries"), Some(entry_id), None, "PATCH") => {
            let entry_id = require_uuid(entry_id)?;
            let patch = require_object(read_json(&body)?)?;
            if let Some(date) = patch.get("date").and_then(Value::as_str) {
                require_date(date)?;
            } else if patch.contains_key("date") {
                return Err(bad_request("Date must use YYYY-MM-DD."));
            }
            if has_non_null(&patch, "productId")
                && !auth.scopes.iter().any(|scope| scope == "read:foods")
            {
                return Err(insufficient_scope("read:foods"));
            }
            let existing = rpc(
                state,
                "getMealEntryById",
                json!({ "userId": auth.user_id, "entryId": entry_id }),
            )
            .await?;
            if existing.is_null() {
                return Err(ApiFailure::new(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "Meal entry not found.",
                ));
            }
            let merged = merge_meal_entry_patch(require_object(existing)?, patch);
            Ok((
                StatusCode::OK,
                rpc(
                    state,
                    "updateMealEntry",
                    json!({ "userId": auth.user_id, "entryId": entry_id, "input": merged }),
                )
                .await?,
            ))
        }
        (Some("meal-entries"), Some(entry_id), None, "DELETE") => {
            let deleted = rpc(
                state,
                "deleteMealEntry",
                json!({ "userId": auth.user_id, "entryId": require_uuid(entry_id)? }),
            )
            .await?;
            if !deleted.as_bool().unwrap_or(false) {
                return Err(ApiFailure::new(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "Meal entry not found.",
                ));
            }
            Ok((StatusCode::OK, json!({ "deleted": true })))
        }
        (Some("meal-entries"), Some(entry_id), Some("status"), "PATCH") => {
            let status = require_string_field(
                &require_object(read_json(&body)?)?,
                "status",
                "Meal status is invalid.",
            )?;
            if !matches!(status.as_str(), "planned" | "eaten" | "skipped") {
                return Err(bad_request("Meal status is invalid."));
            }
            Ok((StatusCode::OK, rpc(state, "markMealEntryStatus", json!({ "userId": auth.user_id, "entryId": require_uuid(entry_id)?, "status": status })).await?))
        }
        (Some("meal-groups"), None, None, "GET") => Ok((
            StatusCode::OK,
            rpc(state, "getMealGroups", json!({ "userId": auth.user_id })).await?,
        )),
        (Some("meal-groups"), None, None, "POST") => {
            let input = require_object(read_json(&body)?)?;
            require_string_field(&input, "label", "Meal group name is required.")?;
            Ok((
                StatusCode::CREATED,
                rpc(
                    state,
                    "createMealGroup",
                    json!({ "userId": auth.user_id, "input": input }),
                )
                .await?,
            ))
        }
        (Some("meal-groups"), Some("reorder"), None, "POST") => {
            let body = require_object(read_json(&body)?)?;
            let ordered_ids = body
                .get("orderedIds")
                .or_else(|| body.get("groupIds"))
                .cloned()
                .ok_or_else(|| bad_request("orderedIds must be an array of group IDs."))?;
            Ok((
                StatusCode::OK,
                rpc(
                    state,
                    "reorderMealGroups",
                    json!({ "userId": auth.user_id, "orderedIds": ordered_ids }),
                )
                .await?,
            ))
        }
        (Some("meal-groups"), Some(group_id), None, "PATCH") => {
            let input = require_object(read_json(&body)?)?;
            require_string_field(&input, "label", "Meal group name is required.")?;
            Ok((StatusCode::OK, rpc(state, "updateMealGroup", json!({ "userId": auth.user_id, "groupId": require_uuid(group_id)?, "input": input })).await?))
        }
        (Some("meal-groups"), Some(group_id), None, "DELETE") => {
            let deleted = rpc(
                state,
                "deleteMealGroup",
                json!({ "userId": auth.user_id, "groupId": require_uuid(group_id)? }),
            )
            .await?;
            if !deleted.as_bool().unwrap_or(false) {
                return Err(ApiFailure::new(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "Meal group not found.",
                ));
            }
            Ok((StatusCode::OK, json!({ "deleted": true })))
        }
        (Some("foods"), Some("search"), None, "GET") => {
            let products = rpc(state, "searchFoodProducts", json!({ "userId": auth.user_id, "query": query_param(uri, "q").unwrap_or_default() })).await?;
            Ok((StatusCode::OK, map_food_array(products)))
        }
        (Some("foods"), None, None, "POST") => {
            let input = sanitize_api_food_input(read_json(&body)?, None)?;
            let product = rpc(
                state,
                "createPersonalFoodProduct",
                json!({ "userId": auth.user_id, "input": input }),
            )
            .await?;
            Ok((StatusCode::CREATED, map_food_product(product)))
        }
        (Some("foods"), Some(product_id), None, "PATCH") => {
            let product_id = require_uuid(product_id)?;
            let existing = rpc(
                state,
                "getFoodProductByIdForUser",
                json!({ "userId": auth.user_id, "productId": product_id }),
            )
            .await?;
            if existing.is_null()
                || existing.get("ownerUserId").and_then(Value::as_str)
                    != Some(auth.user_id.to_string().as_str())
                || existing.get("scope").and_then(Value::as_str) != Some("personal")
            {
                return Err(ApiFailure::new(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "Food product not found.",
                ));
            }
            let input = sanitize_api_food_input(read_json(&body)?, Some(existing))?;
            let product = rpc(
                state,
                "updatePersonalFoodProduct",
                json!({ "userId": auth.user_id, "productId": product_id, "input": input }),
            )
            .await?;
            Ok((StatusCode::OK, map_food_product(product)))
        }
        (Some("barcodes"), Some(barcode), None, "GET") => {
            require_barcode(barcode)?;
            let product = rpc(
                state,
                "lookupBarcodeFoodProduct",
                json!({ "barcode": barcode }),
            )
            .await?;
            Ok((
                StatusCode::OK,
                if product.is_null() {
                    Value::Null
                } else {
                    map_food_product(product)
                },
            ))
        }
        (Some("templates"), Some("from-day"), None, "POST") => {
            let input = require_object(read_json(&body)?)?;
            let date = require_string_field(&input, "date", "Date must use YYYY-MM-DD.")?;
            require_date(&date)?;
            Ok((
                StatusCode::CREATED,
                rpc(
                    state,
                    "createTemplateFromDate",
                    json!({ "userId": auth.user_id, "input": input }),
                )
                .await?,
            ))
        }
        (Some("templates"), None, None, "GET") => Ok((
            StatusCode::OK,
            rpc(state, "getTemplates", json!({ "userId": auth.user_id })).await?,
        )),
        (Some("templates"), None, None, "POST") => {
            let input = require_object(read_json(&body)?)?;
            Ok((
                StatusCode::CREATED,
                rpc(
                    state,
                    "createTemplate",
                    json!({ "userId": auth.user_id, "input": input }),
                )
                .await?,
            ))
        }
        (Some("templates"), Some(template_id), Some("apply"), "POST") => {
            let mut input = require_object(read_json(&body)?)?;
            let date = require_string_field(&input, "date", "Date must use YYYY-MM-DD.")?;
            require_date(&date)?;
            input.insert(
                "templateId".to_string(),
                Value::String(require_uuid(template_id)?),
            );
            Ok((
                StatusCode::CREATED,
                rpc(
                    state,
                    "applyTemplateToDate",
                    json!({ "userId": auth.user_id, "input": input }),
                )
                .await?,
            ))
        }
        (Some("templates"), Some(template_id), None, "GET") => {
            let template = rpc(
                state,
                "getTemplateById",
                json!({ "userId": auth.user_id, "templateId": require_uuid(template_id)? }),
            )
            .await?;
            if template.is_null() {
                return Err(ApiFailure::new(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "Template not found.",
                ));
            }
            Ok((StatusCode::OK, template))
        }
        (Some("templates"), Some(template_id), None, "PATCH") => {
            let input = require_object(read_json(&body)?)?;
            Ok((StatusCode::OK, rpc(state, "updateTemplate", json!({ "userId": auth.user_id, "templateId": require_uuid(template_id)?, "input": input })).await?))
        }
        (Some("templates"), Some(template_id), None, "DELETE") => {
            let deleted = rpc(
                state,
                "deleteTemplate",
                json!({ "userId": auth.user_id, "templateId": require_uuid(template_id)? }),
            )
            .await?;
            if !deleted.as_bool().unwrap_or(false) {
                return Err(ApiFailure::new(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "Template not found.",
                ));
            }
            Ok((StatusCode::OK, json!({ "deleted": true })))
        }
        (Some("recipes"), None, None, "GET") => Ok((
            StatusCode::OK,
            rpc(state, "getRecipes", json!({ "userId": auth.user_id })).await?,
        )),
        (Some("recipes"), None, None, "POST") => {
            let input = require_object(read_json(&body)?)?;
            Ok((
                StatusCode::CREATED,
                rpc(
                    state,
                    "createRecipe",
                    json!({ "userId": auth.user_id, "input": input }),
                )
                .await?,
            ))
        }
        (Some("recipes"), Some(recipe_id), Some("log"), "POST") => {
            let input = build_recipe_log_input(
                state,
                auth.user_id,
                require_uuid(recipe_id)?,
                read_json(&body)?,
            )
            .await?;
            Ok((
                StatusCode::CREATED,
                rpc(
                    state,
                    "createMealEntry",
                    json!({ "userId": auth.user_id, "input": input }),
                )
                .await?,
            ))
        }
        (Some("recipes"), Some(recipe_id), None, "GET") => {
            let recipe = rpc(
                state,
                "getRecipeById",
                json!({ "userId": auth.user_id, "recipeId": require_uuid(recipe_id)? }),
            )
            .await?;
            if recipe.is_null() {
                return Err(ApiFailure::new(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "Recipe not found.",
                ));
            }
            Ok((StatusCode::OK, recipe))
        }
        (Some("recipes"), Some(recipe_id), None, "PATCH") => {
            let input = require_object(read_json(&body)?)?;
            Ok((StatusCode::OK, rpc(state, "updateRecipe", json!({ "userId": auth.user_id, "recipeId": require_uuid(recipe_id)?, "input": input })).await?))
        }
        (Some("recipes"), Some(recipe_id), None, "DELETE") => {
            let deleted = rpc(
                state,
                "deleteRecipe",
                json!({ "userId": auth.user_id, "recipeId": require_uuid(recipe_id)? }),
            )
            .await?;
            if !deleted.as_bool().unwrap_or(false) {
                return Err(ApiFailure::new(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "Recipe not found.",
                ));
            }
            Ok((StatusCode::OK, json!({ "deleted": true })))
        }
        (Some("weight"), None, None, "GET") => Ok((
            StatusCode::OK,
            rpc(
                state,
                "getWeightPageData",
                json!({ "userId": auth.user_id, "selectedDate": reference_date(uri)? }),
            )
            .await?,
        )),
        (Some("weight"), Some("entries"), None, "GET") => Ok((
            StatusCode::OK,
            rpc(state, "getWeightEntries", json!({ "userId": auth.user_id })).await?,
        )),
        (Some("weight"), Some("entries"), None, "POST") => {
            let input = require_object(read_json(&body)?)?;
            let date = require_string_field(&input, "date", "Date must use YYYY-MM-DD.")?;
            require_date(&date)?;
            let created = rpc(
                state,
                "createWeightEntryNoOverwrite",
                json!({ "userId": auth.user_id, "input": input }),
            )
            .await?;
            if created.is_null() {
                return Err(weight_conflict());
            }
            Ok((StatusCode::CREATED, created))
        }
        (Some("weight"), Some("entries"), Some(entry_id), "PATCH") => {
            let entry_id = require_uuid(entry_id)?;
            let patch = require_object(read_json(&body)?)?;
            if let Some(date) = patch.get("date").and_then(Value::as_str) {
                require_date(date)?;
            } else if patch.contains_key("date") {
                return Err(bad_request("Date must use YYYY-MM-DD."));
            }
            let existing = rpc(
                state,
                "getWeightEntryById",
                json!({ "userId": auth.user_id, "entryId": entry_id }),
            )
            .await?;
            if existing.is_null() {
                return Err(ApiFailure::new(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "Weight entry not found.",
                ));
            }
            let merged = apply_client_patch(require_object(existing)?, patch);
            let date = require_string_field(&merged, "date", "Date must use YYYY-MM-DD.")?;
            require_date(&date)?;
            // The unique-violation is already translated into `weight_conflict()`
            // by `api_failure_from_app_error`, so there is nothing to re-check
            // here.
            let value = rpc(
                state,
                "updateWeightEntry",
                json!({ "userId": auth.user_id, "entryId": entry_id, "input": merged }),
            )
            .await?;
            Ok((StatusCode::OK, value))
        }
        (Some("weight"), Some("entries"), Some(entry_id), "DELETE") => {
            let deleted = rpc(
                state,
                "deleteWeightEntry",
                json!({ "userId": auth.user_id, "entryId": require_uuid(entry_id)? }),
            )
            .await?;
            if !deleted.as_bool().unwrap_or(false) {
                return Err(ApiFailure::new(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "Weight entry not found.",
                ));
            }
            Ok((StatusCode::OK, json!({ "deleted": true })))
        }
        (Some("weight"), Some("goal"), None, "GET") => Ok((
            StatusCode::OK,
            json!({ "goalWeightKg": rpc(state, "getWeightGoal", json!({ "userId": auth.user_id })).await? }),
        )),
        (Some("weight"), Some("goal"), None, "PATCH") => {
            let body = require_object(read_json(&body)?)?;
            let goal_weight_kg = body.get("goalWeightKg").cloned().ok_or_else(|| {
                bad_request("goalWeightKg must be null or a finite positive number.")
            })?;
            if !(goal_weight_kg.is_null()
                || goal_weight_kg
                    .as_f64()
                    .is_some_and(|value| value.is_finite() && value > 0.0 && value < 1000.0))
            {
                return Err(bad_request(
                    "goalWeightKg must be null or a finite positive number.",
                ));
            }
            rpc(
                state,
                "saveWeightGoal",
                json!({ "userId": auth.user_id, "goalWeightKg": goal_weight_kg }),
            )
            .await?;
            Ok((
                StatusCode::OK,
                json!({ "goalWeightKg": rpc(state, "getWeightGoal", json!({ "userId": auth.user_id })).await? }),
            ))
        }
        (Some("stats"), None, None, "GET") => Ok((
            StatusCode::OK,
            rpc(
                state,
                "getStatsPageData",
                json!({ "userId": auth.user_id, "today": reference_date(uri)? }),
            )
            .await?,
        )),
        (Some("summary"), None, None, "GET") => {
            let date = reference_date(uri)?;
            let daily_summary = rpc(
                state,
                "getDailySummary",
                json!({ "userId": auth.user_id, "date": date }),
            )
            .await?;
            let period_averages = rpc(
                state,
                "getPeriodAverages",
                json!({ "userId": auth.user_id, "selectedDate": date }),
            )
            .await?;
            let goals = rpc(state, "getUserGoals", json!({ "userId": auth.user_id })).await?;
            let stats = rpc(
                state,
                "getStatsPageData",
                json!({ "userId": auth.user_id, "today": date }),
            )
            .await?;
            Ok((
                StatusCode::OK,
                json!({ "date": date, "dailySummary": daily_summary, "periodAverages": period_averages, "goals": goals, "stats": stats }),
            ))
        }
        (Some("leaderboard"), None, None, "GET") => Ok((
            StatusCode::OK,
            rpc(
                state,
                "getLeaderboardStats",
                json!({ "userId": auth.user_id, "referenceDate": reference_date(uri)? }),
            )
            .await?,
        )),
        (Some("sync"), Some("healthkit"), None, "GET") => {
            let days = bounded_query_int(uri, "days", 7, 1, 30)?;
            let limit = bounded_query_int(uri, "limit", 100, 1, 200)?;
            Ok((
                StatusCode::OK,
                rpc(
                    state,
                    "getHealthkitSyncEntries",
                    json!({ "userId": auth.user_id, "days": days, "limit": limit }),
                )
                .await?,
            ))
        }
        (Some("sync"), Some("healthkit"), Some("ack"), "POST") => {
            let body = require_object(read_json(&body)?)?;
            let entry_ids = body
                .get("entryIds")
                .cloned()
                .ok_or_else(|| bad_request("entryIds must be an array of meal entry IDs."))?;
            Ok((
                StatusCode::OK,
                rpc(
                    state,
                    "ackHealthkitSyncEntries",
                    json!({ "userId": auth.user_id, "entryIds": entry_ids }),
                )
                .await?,
            ))
        }
        _ => Err(ApiFailure::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "API endpoint not found.",
        )),
    }
}

async fn rpc(state: &AppState, op: &str, args: Value) -> ApiResult<Value> {
    db::rpc_json(&state.db, op, args)
        .await
        .map_err(api_failure_from_app_error)
}

/// Every endpoint the public API serves, matched **in order**: a shape with a
/// literal segment must precede the wildcard shape that would otherwise swallow
/// it (`/foods/search` before `/foods/{id}`).
const API_V1_ENDPOINTS: &[Endpoint] = &[
    Endpoint {
        path: "/me",
        methods: &["GET"],
        scopes: &[("GET", &["read:account", "read:goals"])],
    },
    Endpoint {
        path: "/goals",
        methods: &["GET", "PATCH"],
        scopes: &[
            ("GET", &["read:goals"]),
            ("PATCH", &["write:goals", "read:goals"]),
        ],
    },
    Endpoint {
        path: "/days/{date}",
        methods: &["GET"],
        scopes: &[("GET", &["read:daily"])],
    },
    Endpoint {
        path: "/days/{date}/entries",
        methods: &["POST"],
        scopes: &[("POST", &["write:daily"])],
    },
    Endpoint {
        path: "/meal-entries/{id}",
        methods: &["PATCH", "DELETE"],
        scopes: &[
            ("PATCH", &["write:daily", "read:daily"]),
            ("DELETE", &["write:daily"]),
        ],
    },
    Endpoint {
        path: "/meal-entries/{id}/status",
        methods: &["PATCH"],
        scopes: &[("PATCH", &["write:daily", "read:daily"])],
    },
    Endpoint {
        path: "/meal-groups",
        methods: &["GET", "POST"],
        scopes: &[("GET", &["read:daily"]), ("POST", &["write:daily"])],
    },
    Endpoint {
        path: "/meal-groups/reorder",
        methods: &["POST"],
        scopes: &[("POST", &["write:daily"])],
    },
    Endpoint {
        path: "/meal-groups/{id}",
        methods: &["PATCH", "DELETE"],
        scopes: &[("PATCH", &["write:daily"]), ("DELETE", &["write:daily"])],
    },
    Endpoint {
        path: "/foods/search",
        methods: &["GET"],
        scopes: &[("GET", &["read:foods"])],
    },
    Endpoint {
        path: "/foods",
        methods: &["POST"],
        scopes: &[("POST", &["write:foods"])],
    },
    Endpoint {
        path: "/foods/{id}",
        methods: &["PATCH"],
        scopes: &[("PATCH", &["write:foods", "read:foods"])],
    },
    Endpoint {
        path: "/barcodes/{barcode}",
        methods: &["GET"],
        scopes: &[("GET", &["read:foods"])],
    },
    Endpoint {
        path: "/templates/from-day",
        methods: &["POST"],
        scopes: &[("POST", &["read:daily", "write:templates"])],
    },
    Endpoint {
        path: "/templates",
        methods: &["GET", "POST"],
        scopes: &[("GET", &["read:templates"]), ("POST", &["write:templates"])],
    },
    Endpoint {
        path: "/templates/{id}/apply",
        methods: &["POST"],
        scopes: &[("POST", &["read:templates", "write:daily"])],
    },
    Endpoint {
        path: "/templates/{id}",
        methods: &["GET", "PATCH", "DELETE"],
        scopes: &[
            ("GET", &["read:templates"]),
            ("PATCH", &["write:templates"]),
            ("DELETE", &["write:templates"]),
        ],
    },
    Endpoint {
        path: "/recipes",
        methods: &["GET", "POST"],
        scopes: &[("GET", &["read:recipes"]), ("POST", &["write:recipes"])],
    },
    Endpoint {
        path: "/recipes/{id}/log",
        methods: &["POST"],
        scopes: &[("POST", &["read:recipes", "write:daily"])],
    },
    Endpoint {
        path: "/recipes/{id}",
        methods: &["GET", "PATCH", "DELETE"],
        scopes: &[
            ("GET", &["read:recipes"]),
            ("PATCH", &["write:recipes"]),
            ("DELETE", &["write:recipes"]),
        ],
    },
    Endpoint {
        path: "/weight",
        methods: &["GET"],
        scopes: &[("GET", &["read:weight"])],
    },
    Endpoint {
        path: "/weight/entries",
        methods: &["GET", "POST"],
        scopes: &[("GET", &["read:weight"]), ("POST", &["write:weight"])],
    },
    Endpoint {
        path: "/weight/entries/{id}",
        methods: &["PATCH", "DELETE"],
        scopes: &[
            ("PATCH", &["write:weight", "read:weight"]),
            ("DELETE", &["write:weight"]),
        ],
    },
    Endpoint {
        path: "/weight/goal",
        methods: &["GET", "PATCH"],
        scopes: &[("GET", &["read:weight"]), ("PATCH", &["write:weight"])],
    },
    Endpoint {
        path: "/stats",
        methods: &["GET"],
        scopes: &[("GET", &["read:stats", "read:weight", "read:goals"])],
    },
    Endpoint {
        path: "/summary",
        methods: &["GET"],
        scopes: &[(
            "GET",
            &["read:stats", "read:daily", "read:goals", "read:weight"],
        )],
    },
    Endpoint {
        path: "/leaderboard",
        methods: &["GET"],
        scopes: &[("GET", &["read:stats"])],
    },
    Endpoint {
        path: "/sync/healthkit",
        methods: &["GET"],
        scopes: &[("GET", &["read:daily"])],
    },
    Endpoint {
        path: "/sync/healthkit/ack",
        methods: &["POST"],
        scopes: &[("POST", &["write:daily"])],
    },
    // Answered before authentication in `handle_api_v1`. The empty scope list
    // is the contract published for it, not a routing default.
    Endpoint {
        path: "/openapi.json",
        methods: &["GET"],
        scopes: &[("GET", &[])],
    },
];

fn endpoint_for(path: &[String]) -> Option<Endpoint> {
    API_V1_ENDPOINTS
        .iter()
        .find(|endpoint| path_template_matches(endpoint.path, path))
        .copied()
}

/// A template segment in braces matches any single path segment; every other
/// segment must match exactly, and the two lengths must agree.
fn path_template_matches(template: &str, path: &[String]) -> bool {
    let mut matched = 0usize;
    for segment in template.split('/').filter(|segment| !segment.is_empty()) {
        let Some(actual) = path.get(matched) else {
            return false;
        };
        if !segment.starts_with('{') && segment != actual {
            return false;
        }
        matched += 1;
    }
    matched == path.len()
}

/// Required scopes for `method` on `endpoint`, or `None` when the endpoint
/// declares none for it.
///
/// API-01: this lookup used to end in `.unwrap_or(&[])`, so a method listed in
/// `Endpoint::methods` but missing from `Endpoint::scopes` silently required no
/// scope at all and any valid token could call it. The caller now refuses such
/// a request, making the default deny.
fn required_scopes(endpoint: &Endpoint, method: &str) -> Option<&'static [&'static str]> {
    endpoint
        .scopes
        .iter()
        .find_map(|(candidate, scopes)| (*candidate == method).then_some(*scopes))
}

fn bearer_token(headers: &HeaderMap) -> ApiResult<String> {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return Err(ApiFailure::new(
            StatusCode::UNAUTHORIZED,
            "missing_token",
            "Missing bearer token.",
        ));
    };
    let parts = value.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 2 || !parts[0].eq_ignore_ascii_case("bearer") {
        return Err(ApiFailure::new(
            StatusCode::UNAUTHORIZED,
            "malformed_token",
            "Authorization must use Bearer <token>.",
        ));
    }
    Ok(parts[1].to_string())
}

fn auth_error(reason: &str) -> (&'static str, &'static str) {
    match reason {
        "missing" => ("missing_token", "Missing bearer token."),
        "malformed" => ("malformed_token", "Authorization must use Bearer <token>."),
        "expired" => ("expired_token", "API token has expired."),
        "revoked" => ("revoked_token", "API token has been revoked."),
        _ => ("invalid_token", "API token is invalid."),
    }
}

fn read_json(body: &Bytes) -> ApiResult<Value> {
    serde_json::from_slice(body).map_err(|_| bad_request("Request body must be valid JSON."))
}

fn require_object(value: Value) -> ApiResult<Map<String, Value>> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| bad_request("Request body is required."))
}

fn require_string_field(
    record: &Map<String, Value>,
    key: &str,
    message: &'static str,
) -> ApiResult<String> {
    record
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| bad_request(message))
}

fn require_date(value: &str) -> ApiResult<()> {
    // Same rule the internal RPC path enforces, so both entry points agree on
    // what a date is.
    crate::db::ensure_date_string(value).map_err(|_| bad_request("Date must use YYYY-MM-DD."))
}

/// API-11: `/api/v1/barcodes/{barcode}` accepted anything while its
/// session-authenticated twin in `legacy_api.rs` has always required 4–20
/// characters. Not exploitable — the lookup is a parameterised equality — but
/// two entry points to one capability should not disagree about what a barcode
/// is, so both now read the same bounds.
fn require_barcode(value: &str) -> ApiResult<()> {
    use crate::legacy_api::{MAX_BARCODE_LENGTH, MIN_BARCODE_LENGTH};

    if value.len() < MIN_BARCODE_LENGTH || value.len() > MAX_BARCODE_LENGTH {
        return Err(bad_request(format!(
            "Barcode must be {MIN_BARCODE_LENGTH} to {MAX_BARCODE_LENGTH} characters."
        )));
    }
    Ok(())
}

fn require_uuid(value: &str) -> ApiResult<String> {
    Uuid::parse_str(value)
        .map(|uuid| uuid.to_string())
        .map_err(|_| bad_request("Path parameter must be a valid UUID."))
}

fn has_non_null(record: &Map<String, Value>, key: &str) -> bool {
    record.get(key).is_some_and(|value| !value.is_null())
}

/// Prefix reserved for control flags that this module adds to an RPC `input`
/// map. `db.rs` reads them back out of that same map, so they are part of the
/// internal calling convention and must never be settable by a client.
const PRIVATE_INPUT_KEY_PREFIX: &str = "__";

/// Copies a client patch onto a stored record, dropping every reserved key.
///
/// DATA-02: `PATCH` handlers merge the raw request body onto the row they just
/// read and hand the result to the RPC layer as `input`. Copying every key
/// meant a caller could inject `__recalculateProductMacros`, the private flag
/// that decides whether a product-linked entry's macros are recomputed from the
/// product row or taken verbatim from the request — i.e. the client could
/// choose to have its own macro numbers stored against someone else's product
/// snapshot. Reserved keys are stripped here; only the callers below may add
/// one back.
fn apply_client_patch(
    mut record: Map<String, Value>,
    patch: Map<String, Value>,
) -> Map<String, Value> {
    for (key, value) in patch {
        if key.starts_with(PRIVATE_INPUT_KEY_PREFIX) {
            continue;
        }
        record.insert(key, value);
    }
    record
}

/// Merges a meal-entry patch and re-derives the product-snapshot flag.
///
/// The flag is set only when the entry is product-linked and the patch touches
/// none of the fields the product snapshot is derived from — patching any of
/// them means the caller wants the entry recalculated. It is computed from the
/// stored row and the patch's *key set*, never from a client-supplied value.
fn merge_meal_entry_patch(
    existing: Map<String, Value>,
    patch: Map<String, Value>,
) -> Map<String, Value> {
    let preserve_product_snapshot = existing.get("productId").and_then(Value::as_str).is_some()
        && !patch.contains_key("productId")
        && ![
            "quantity",
            "unit",
            "servingMultiplier",
            "proteinG",
            "carbsG",
            "fatG",
            "caloriesKcal",
        ]
        .iter()
        .any(|key| patch.contains_key(*key));
    let mut merged = apply_client_patch(existing, patch);
    if preserve_product_snapshot {
        merged.insert("__recalculateProductMacros".to_string(), Value::Bool(false));
    }
    merged
}

fn merge_goals(current: Value, patch: Value) -> ApiResult<Value> {
    let current = require_object(current)?;
    let patch = require_object(patch)?;
    let mut merged = Map::new();
    for key in ["caloriesKcal", "proteinG", "carbsG", "fatG"] {
        let value = patch
            .get(key)
            .or_else(|| current.get(key))
            .cloned()
            .unwrap_or(Value::Null);
        if !(value.is_null() || value.as_f64().is_some()) {
            return Err(bad_request(format!(
                "{key} must be null or a finite non-negative number."
            )));
        }
        if value
            .as_f64()
            .is_some_and(|number| number < 0.0 || !number.is_finite())
        {
            return Err(bad_request(format!(
                "{key} must be null or a finite non-negative number."
            )));
        }
        if key == "caloriesKcal" && value.as_f64().is_some_and(|number| number.fract() != 0.0) {
            return Err(bad_request("caloriesKcal must be an integer."));
        }
        merged.insert(key.to_string(), value);
    }
    Ok(Value::Object(merged))
}

fn sanitize_api_food_input(value: Value, existing: Option<Value>) -> ApiResult<Map<String, Value>> {
    let body = require_object(value)?;
    let existing = existing.and_then(|value| value.as_object().cloned());
    let required = existing.is_none();
    let mut input = Map::new();
    for key in [
        "name",
        "brand",
        "barcode",
        "defaultServingQuantity",
        "defaultServingUnit",
        "proteinPer100",
        "carbsPer100",
        "fatPer100",
        "caloriesPer100",
        "servingWeightG",
        "servingVolumeMl",
    ] {
        let value = body
            .get(key)
            .cloned()
            .or_else(|| existing.as_ref().and_then(|item| item.get(key).cloned()));
        if let Some(value) = value {
            input.insert(key.to_string(), value);
        }
    }
    if required && !input.contains_key("name") {
        return Err(bad_request("Product name is required."));
    }
    input.insert("scope".to_string(), Value::String("personal".to_string()));
    input.insert("source".to_string(), Value::String("manual".to_string()));
    Ok(input)
}

fn map_account(user: Value) -> Value {
    if user.is_null() {
        return Value::Null;
    }
    json!({
        "id": user.get("id").cloned().unwrap_or(Value::Null),
        "email": user.get("email").cloned().unwrap_or(Value::Null),
        "displayName": user.get("displayName").cloned().unwrap_or(Value::Null),
        "pictureUrl": user.get("pictureUrl").cloned().unwrap_or(Value::Null),
        "createdAt": user.get("createdAt").cloned().unwrap_or(Value::Null),
        "lastLoginAt": user.get("lastLoginAt").cloned().unwrap_or(Value::Null),
        "onboardingCompletedAt": user.get("onboardingCompletedAt").cloned().unwrap_or(Value::Null),
        "preferredWeightUnit": user.get("preferredWeightUnit").cloned().unwrap_or(Value::Null)
    })
}

fn map_food_array(products: Value) -> Value {
    Value::Array(
        products
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(map_food_product)
            .collect(),
    )
}

fn map_food_product(product: Value) -> Value {
    let Some(mut object) = product.as_object().cloned() else {
        return product;
    };
    for key in [
        "ownerUserId",
        "submittedByUserId",
        "deletedByUserId",
        "sourceProvider",
        "sourceConfidence",
        "sourceMetadata",
        "correctedFromProductId",
    ] {
        object.remove(key);
    }
    Value::Object(object)
}

async fn build_recipe_log_input(
    state: &AppState,
    user_id: Uuid,
    recipe_id: String,
    body: Value,
) -> ApiResult<Map<String, Value>> {
    let body = require_object(body)?;
    let date = require_string_field(&body, "date", "Date must use YYYY-MM-DD.")?;
    require_date(&date)?;
    let recipe = rpc(
        state,
        "getRecipeById",
        json!({ "userId": user_id, "recipeId": recipe_id }),
    )
    .await?;
    if recipe.is_null() {
        return Err(ApiFailure::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "Recipe not found.",
        ));
    }
    let portion_count = match body.get("portionCount") {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(_) => f64::NAN,
        None => 1.0,
    };
    if !portion_count.is_finite() || portion_count <= 0.0 {
        return Err(bad_request(
            "portionCount must be a finite positive number.",
        ));
    }
    let grams_consumed = match body.get("gramsConsumed") {
        Some(Value::Number(number)) => Some(number.as_f64().unwrap_or(f64::NAN)),
        Some(_) => Some(f64::NAN),
        None => None,
    };
    if grams_consumed.is_some_and(|value| !value.is_finite() || value <= 0.0) {
        return Err(bad_request(
            "gramsConsumed must be a finite positive number.",
        ));
    }
    let status = match body.get("status") {
        Some(Value::String(status)) => status.to_string(),
        Some(_) => return Err(bad_request("Meal status is invalid.")),
        None => {
            if date > chrono::Utc::now().date_naive().to_string() {
                "planned".to_string()
            } else {
                "eaten".to_string()
            }
        }
    };
    if !matches!(status.as_str(), "planned" | "eaten" | "skipped") {
        return Err(bad_request("Meal status is invalid."));
    }
    let per_portion = recipe
        .get("perPortionMacros")
        .and_then(Value::as_object)
        .ok_or_else(internal_error)?;
    let factor = if let Some(grams_consumed) = grams_consumed {
        let cooked_weight = recipe
            .get("totalCookedWeightG")
            .and_then(Value::as_f64)
            .filter(|value| *value > 0.0)
            .ok_or_else(|| bad_request("Recipe cooked weight is required to log grams."))?;
        grams_consumed / cooked_weight
            * recipe
                .get("portions")
                .and_then(Value::as_f64)
                .unwrap_or(1.0)
    } else {
        portion_count
    };
    let label = if let Some(grams_consumed) = grams_consumed {
        format!(
            "{} ({}g)",
            recipe
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("Recipe"),
            grams_consumed
        )
    } else {
        format!(
            "{} ({} portion{})",
            recipe
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or("Recipe"),
            portion_count,
            if (portion_count - 1.0).abs() < f64::EPSILON {
                ""
            } else {
                "s"
            }
        )
    };
    Ok(Map::from_iter([
        ("date".to_string(), Value::String(date)),
        ("status".to_string(), Value::String(status)),
        ("label".to_string(), Value::String(label)),
        (
            "quantity".to_string(),
            json!(grams_consumed.unwrap_or(portion_count)),
        ),
        (
            "unit".to_string(),
            Value::String(
                if grams_consumed.is_some() {
                    "g"
                } else {
                    "serving"
                }
                .to_string(),
            ),
        ),
        (
            "proteinG".to_string(),
            json!(round1(
                per_portion
                    .get("proteinG")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                    * factor
            )),
        ),
        (
            "carbsG".to_string(),
            json!(round1(
                per_portion
                    .get("carbsG")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                    * factor
            )),
        ),
        (
            "fatG".to_string(),
            json!(round1(
                per_portion
                    .get("fatG")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                    * factor
            )),
        ),
        (
            "caloriesKcal".to_string(),
            json!(
                (per_portion
                    .get("caloriesKcal")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
                    * factor)
                    .round() as i32
            ),
        ),
    ]))
}

fn query_param(uri: &Uri, name: &str) -> Option<String> {
    uri.query().and_then(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .find_map(|(key, value)| (key == name).then(|| value.into_owned()))
    })
}

fn reference_date(uri: &Uri) -> ApiResult<String> {
    let date =
        query_param(uri, "date").unwrap_or_else(|| chrono::Utc::now().date_naive().to_string());
    require_date(&date)?;
    Ok(date)
}

fn bounded_query_int(uri: &Uri, name: &str, default: i64, min: i64, max: i64) -> ApiResult<i64> {
    match query_param(uri, name) {
        None => Ok(default),
        Some(raw) => raw
            .parse::<i64>()
            .ok()
            .filter(|value| (min..=max).contains(value))
            .ok_or_else(|| {
                bad_request(format!(
                    "{name} must be an integer between {min} and {max}."
                ))
            }),
    }
}

fn bad_request(message: impl Into<String>) -> ApiFailure {
    ApiFailure::new(StatusCode::BAD_REQUEST, "bad_request", message)
}

fn insufficient_scope(scope: &'static str) -> ApiFailure {
    ApiFailure::new(
        StatusCode::FORBIDDEN,
        "insufficient_scope",
        format!("API token is missing required scope: {scope}."),
    )
}

/// Named once: the mapping below and the DB schema have to agree on it.
const WEIGHT_ENTRY_DATE_CONSTRAINT: &str = "weight_entries_user_date_key";

fn weight_conflict() -> ApiFailure {
    ApiFailure::new(
        StatusCode::CONFLICT,
        "weight_entry_date_conflict",
        "A weight entry already exists for this date.",
    )
}

fn internal_error() -> ApiFailure {
    ApiFailure::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal_error",
        "An internal server error occurred.",
    )
}

fn api_failure_from_app_error(error: AppError) -> ApiFailure {
    // Everything the backend already classifies is taken straight from
    // `AppError`, so the status/code strings live in exactly one place. Only
    // the two genuine API-surface divergences are spelled out.
    match error {
        // The public API authenticates with Bearer tokens, so an auth failure
        // is reported as `invalid_token` rather than the internal
        // `unauthorized`.
        AppError::Unauthorized(message) => {
            ApiFailure::new(StatusCode::UNAUTHORIZED, "invalid_token", message)
        }
        // API-03: only the weight-date constraint used to be recognised, so
        // every other unique violation — reusing a `clientMutationId`, say —
        // surfaced as a 500 `internal_error`, telling the caller the server
        // broke when in fact their request collided with an existing row. The
        // constraint name is logged, never returned: it names internal schema.
        AppError::Sqlx(ref sqlx_error)
            if sqlx_error
                .as_database_error()
                .is_some_and(|db| db.is_unique_violation()) =>
        {
            let constraint = sqlx_error
                .as_database_error()
                .and_then(|db| db.constraint())
                .unwrap_or_default();
            if constraint == WEIGHT_ENTRY_DATE_CONSTRAINT {
                return weight_conflict();
            }
            tracing::warn!(constraint, "API v1 unique violation");
            ApiFailure::new(
                StatusCode::CONFLICT,
                "conflict",
                "That value is already used by another record.",
            )
        }
        AppError::Sqlx(_) | AppError::Json(_) | AppError::Anyhow(_) => {
            tracing::error!(error = ?error, "API v1 failure");
            internal_error()
        }
        _ => {
            let status = error.status();
            let code = error.api_code();
            ApiFailure::new(status, code, error.to_string())
        }
    }
}

fn json_response(status: StatusCode, body: Value, allow: Option<&str>) -> Response {
    raw_json_response(status, body, allow)
}

fn raw_json_response(status: StatusCode, body: Value, allow: Option<&str>) -> Response {
    let mut headers = cors_headers();
    if let Some(allow) = allow {
        headers.insert(header::ALLOW, allow.parse().expect("valid Allow header"));
    }
    (status, headers, Json(body)).into_response()
}

fn static_json_response(body: &'static [u8]) -> Response {
    let mut headers = cors_headers();
    headers.insert(
        header::CONTENT_TYPE,
        "application/json".parse().expect("valid content type"),
    );
    (
        StatusCode::OK,
        headers,
        Body::from(Bytes::from_static(body)),
    )
        .into_response()
}

fn empty_response(status: StatusCode, allow: Option<&str>) -> Response {
    let mut headers = cors_headers();
    if let Some(allow) = allow {
        headers.insert(header::ALLOW, allow.parse().expect("valid Allow header"));
    }
    (status, headers).into_response()
}

pub(crate) fn cors_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        CORS_ALLOW_ORIGIN.parse().unwrap(),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        CORS_ALLOW_METHODS.parse().unwrap(),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        CORS_ALLOW_HEADERS.parse().unwrap(),
    );
    headers.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        CORS_MAX_AGE.parse().unwrap(),
    );
    headers
}

#[cfg(test)]
mod tests;
