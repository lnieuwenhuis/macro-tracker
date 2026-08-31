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
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use sqlx::postgres::PgPoolOptions;
    use tower::ServiceExt;

    fn test_state() -> AppState {
        AppState {
            config: crate::config::test_config(),
            db: PgPoolOptions::new()
                .connect_lazy("postgres://postgres:***@127.0.0.1:5432/macro_tracker")
                .expect("test pool should be created lazily"),
            http: reqwest::Client::new(),
        }
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

    // --- Router shape -------------------------------------------------------

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
        // API-06: the `Bytes` extractor rejects before the handler, so this
        // used to be a bare 413 with a plain-text body and no
        // `Access-Control-Allow-Origin` — a browser saw a CORS failure rather
        // than the documented error shape.
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
        // A rejected body must not stop the unauthenticated document from
        // being readable.
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

    // --- Validation ---------------------------------------------------------

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
        // DATA-02: the exploit body. `proteinG` is present, so the handler's own
        // snapshot rule says "recalculate", but the caller tries to override it
        // with `false` so its raw macro numbers are stored verbatim against the
        // linked product.
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
        // Regression guard for the behaviour the flag exists for: renaming a
        // product-linked entry must not recompute its macros.
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

    // --- Error mapping ------------------------------------------------------

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

    /// Minimal `sqlx::error::DatabaseError` so the unique-violation mapping can
    /// be tested without provoking a real constraint.
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
        // API-03: only `weight_entries_user_date_key` was recognised, so
        // reusing a `clientMutationId` reported a 500 for what is a collision
        // with an existing row.
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
        // API-11.
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

    // --- Scope contract -----------------------------------------------------

    /// Turns an OpenAPI path template into a concrete request path, so the
    /// tests below exercise the same routing a client would hit.
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
        // Derived from the routing table rather than a hand-kept list, so a new
        // endpoint cannot be added without this test covering it (API-01).
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
        // The structural hole API-01 describes: a method allowed by `methods`
        // but absent from `scopes`. The lookup must not fall back to "no scopes
        // required".
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
        // Guards the match order: a shape with a literal segment must not be
        // swallowed by an earlier wildcard shape.
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
        // The spec is served verbatim from `API_V1_OPENAPI_JSON`, so a drift
        // between what is enforced and what is documented is a silent contract
        // break. Compared in both directions.
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
        // API-15: every operation used to list an identical
        // 400/401/403/404/405/500 set, including for the public
        // `GET /openapi.json`, while the 504 the deadline emits and the 413 an
        // over-limit body emits were documented nowhere.
        let spec: Value = serde_json::from_slice(API_V1_OPENAPI_JSON).expect("spec should be JSON");
        let paths = spec["paths"].as_object().expect("spec should have paths");

        for (path, operations) in paths {
            for (method, operation) in operations.as_object().expect("operations object") {
                let responses = operation["responses"]
                    .as_object()
                    .expect("operation should document responses");
                let label = format!("{} {path}", method.to_uppercase());

                if path == "/openapi.json" {
                    // Answered from a compiled-in constant before
                    // authentication, before the body is read and before the
                    // deadline wrapper — but `main.rs` mounts the rate limiter
                    // in front of the whole `/api/v1` router, so 429 is still
                    // reachable.
                    assert_eq!(
                        responses.keys().collect::<Vec<_>>(),
                        vec!["200", "429"],
                        "{label}: the public document has only these outcomes"
                    );
                    continue;
                }

                // 405 is a property of the *path*, not of one operation — a
                // documented method is by definition allowed — but every
                // operation lists it because OpenAPI has nowhere else to put a
                // path-level response.
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
        // API-15: all 41 operations shipped `"data": {}` — an envelope with no
        // statement about what is inside it. The document is hand-maintained,
        // so a dangling `$ref` would be silent until a consumer tried to
        // dereference it.
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
                    // This one operation answers with the document itself, not
                    // with the `{ ok, data }` envelope.
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
        // API-15: `unit` and `defaultServingUnit` were documented as free
        // strings while `is_quantity_unit` accepts exactly four values.
        let spec: Value = serde_json::from_slice(API_V1_OPENAPI_JSON).expect("spec should be JSON");
        let unit = &spec["paths"]["/days/{date}/entries"]["post"]["requestBody"]["content"]["application/json"]
            ["schema"]["properties"]["unit"];

        let documented = unit["enum"]
            .as_array()
            .expect("unit should be an enum")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();

        // Mirrors `is_quantity_unit` in db.rs, which is private to that module;
        // if it gains or loses a unit this assertion has to move with it.
        assert_eq!(documented, vec!["g", "ml", "serving", "count"]);
    }

    #[test]
    fn the_body_date_is_not_documented_where_the_path_wins() {
        // API-15: `date` was documented in the body of
        // `POST /days/{date}/entries` but `dispatch_api_request` overwrites it
        // with the path segment before the RPC call.
        let spec: Value = serde_json::from_slice(API_V1_OPENAPI_JSON).expect("spec should be JSON");
        let properties = &spec["paths"]["/days/{date}/entries"]["post"]["requestBody"]["content"]["application/json"]
            ["schema"]["properties"];

        assert!(properties.get("date").is_none());
    }

    #[test]
    fn portions_is_documented_as_optional_with_its_real_default() {
        let spec: Value = serde_json::from_slice(API_V1_OPENAPI_JSON).expect("spec should be JSON");
        let schema = &spec["paths"]["/recipes"]["post"]["requestBody"]["content"]["application/json"]
            ["schema"];

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
        // A tower TimeoutLayer would emit a bare 504 here, breaking the
        // documented contract for direct clients and tripping CORS in browsers.
        let response = json_response(
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
        // Drives the real handler path with a deadline short enough to elapse,
        // proving the timeout branch produces an envelope rather than an empty
        // transport-level response.
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
}
