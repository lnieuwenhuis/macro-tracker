use crate::{AppState, db, errors::AppError};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path, State},
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
const API_V1_OPENAPI_JSON: &str = include_str!("generated/api-v1-openapi.json");

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

#[derive(Clone, Copy)]
struct Endpoint {
    methods: &'static [&'static str],
    scopes: &'static [(&'static str, &'static [&'static str])],
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/", any(api_v1_root))
        .route("/{*path}", any(api_v1_request))
}

async fn api_v1_root(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    handle_api_v1(state, method, uri, headers, Vec::new(), body).await
}

async fn api_v1_request(
    State(state): State<AppState>,
    Path(path): Path<String>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let path = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect();
    handle_api_v1(state, method, uri, headers, path, body).await
}

async fn handle_api_v1(
    state: AppState,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    path: Vec<String>,
    body: Bytes,
) -> Response {
    if method == Method::OPTIONS {
        return empty_response(StatusCode::NO_CONTENT, None);
    }

    if method == Method::GET && path.as_slice() == ["openapi.json"] {
        return match serde_json::from_str(API_V1_OPENAPI_JSON) {
            Ok(openapi) => raw_json_response(StatusCode::OK, openapi, None),
            Err(error) => {
                tracing::error!(error = ?error, "API v1 OpenAPI document is invalid");
                json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({
                        "ok": false,
                        "error": {
                            "code": "internal_error",
                            "message": "An internal server error occurred."
                        }
                    }),
                    None,
                )
            }
        };
    }

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

        let scopes = endpoint
            .scopes
            .iter()
            .find_map(|(candidate, scopes)| (*candidate == method_name).then_some(*scopes))
            .unwrap_or(&[]);
        let auth = authenticate_request(&state, &headers, scopes).await?;
        dispatch_api_request(&state, method_name, &uri, &path, body, auth).await
    }
    .await;

    match result {
        Ok((status, data)) => json_response(status, json!({ "ok": true, "data": data }), None),
        Err(failure) => json_response(
            failure.status,
            json!({
                "ok": false,
                "error": {
                    "code": failure.code,
                    "message": failure.message
                }
            }),
            failure.allow.as_deref(),
        ),
    }
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
            let preserve_product_snapshot =
                existing.get("productId").and_then(Value::as_str).is_some()
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
            let mut merged = require_object(existing)?;
            for (key, value) in patch {
                merged.insert(key, value);
            }
            if preserve_product_snapshot {
                merged.insert("__recalculateProductMacros".to_string(), Value::Bool(false));
            }
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
            let entries = rpc(state, "getWeightEntries", json!({ "userId": auth.user_id })).await?;
            let existing = entries
                .as_array()
                .and_then(|items| {
                    items.iter().find(|item| {
                        item.get("id").and_then(Value::as_str) == Some(entry_id.as_str())
                    })
                })
                .cloned()
                .ok_or_else(|| {
                    ApiFailure::new(
                        StatusCode::NOT_FOUND,
                        "not_found",
                        "Weight entry not found.",
                    )
                })?;
            let mut merged = require_object(existing)?;
            for (key, value) in patch {
                merged.insert(key, value);
            }
            let date = require_string_field(&merged, "date", "Date must use YYYY-MM-DD.")?;
            require_date(&date)?;
            match rpc(
                state,
                "updateWeightEntry",
                json!({ "userId": auth.user_id, "entryId": entry_id, "input": merged }),
            )
            .await
            {
                Ok(value) => Ok((StatusCode::OK, value)),
                Err(error) if error.message.contains("weight_entries_user_date_key") => {
                    Err(weight_conflict())
                }
                Err(error) => Err(error),
            }
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

fn endpoint_for(path: &[String]) -> Option<Endpoint> {
    match (
        path.first().map(String::as_str),
        path.get(1).map(String::as_str),
        path.get(2).map(String::as_str),
        path.len(),
    ) {
        (Some("me"), None, None, 1) => Some(endpoint(
            &["GET"],
            &[("GET", &["read:account", "read:goals"])],
        )),
        (Some("goals"), None, None, 1) => Some(endpoint(
            &["GET", "PATCH"],
            &[
                ("GET", &["read:goals"]),
                ("PATCH", &["write:goals", "read:goals"]),
            ],
        )),
        (Some("days"), Some(_), None, 2) => Some(endpoint(&["GET"], &[("GET", &["read:daily"])])),
        (Some("days"), Some(_), Some("entries"), 3) => {
            Some(endpoint(&["POST"], &[("POST", &["write:daily"])]))
        }
        (Some("meal-entries"), Some(_), None, 2) => Some(endpoint(
            &["PATCH", "DELETE"],
            &[
                ("PATCH", &["write:daily", "read:daily"]),
                ("DELETE", &["write:daily"]),
            ],
        )),
        (Some("meal-entries"), Some(_), Some("status"), 3) => Some(endpoint(
            &["PATCH"],
            &[("PATCH", &["write:daily", "read:daily"])],
        )),
        (Some("meal-groups"), None, None, 1) => Some(endpoint(
            &["GET", "POST"],
            &[("GET", &["read:daily"]), ("POST", &["write:daily"])],
        )),
        (Some("meal-groups"), Some("reorder"), None, 2) => {
            Some(endpoint(&["POST"], &[("POST", &["write:daily"])]))
        }
        (Some("meal-groups"), Some(_), None, 2) => Some(endpoint(
            &["PATCH", "DELETE"],
            &[("PATCH", &["write:daily"]), ("DELETE", &["write:daily"])],
        )),
        (Some("foods"), Some("search"), None, 2) => {
            Some(endpoint(&["GET"], &[("GET", &["read:foods"])]))
        }
        (Some("foods"), None, None, 1) => Some(endpoint(&["POST"], &[("POST", &["write:foods"])])),
        (Some("foods"), Some(_), None, 2) => Some(endpoint(
            &["PATCH"],
            &[("PATCH", &["write:foods", "read:foods"])],
        )),
        (Some("barcodes"), Some(_), None, 2) => {
            Some(endpoint(&["GET"], &[("GET", &["read:foods"])]))
        }
        (Some("templates"), Some("from-day"), None, 2) => Some(endpoint(
            &["POST"],
            &[("POST", &["read:daily", "write:templates"])],
        )),
        (Some("templates"), None, None, 1) => Some(endpoint(
            &["GET", "POST"],
            &[("GET", &["read:templates"]), ("POST", &["write:templates"])],
        )),
        (Some("templates"), Some(_), Some("apply"), 3) => Some(endpoint(
            &["POST"],
            &[("POST", &["read:templates", "write:daily"])],
        )),
        (Some("templates"), Some(_), None, 2) => Some(endpoint(
            &["GET", "PATCH", "DELETE"],
            &[
                ("GET", &["read:templates"]),
                ("PATCH", &["write:templates"]),
                ("DELETE", &["write:templates"]),
            ],
        )),
        (Some("recipes"), None, None, 1) => Some(endpoint(
            &["GET", "POST"],
            &[("GET", &["read:recipes"]), ("POST", &["write:recipes"])],
        )),
        (Some("recipes"), Some(_), Some("log"), 3) => Some(endpoint(
            &["POST"],
            &[("POST", &["read:recipes", "write:daily"])],
        )),
        (Some("recipes"), Some(_), None, 2) => Some(endpoint(
            &["GET", "PATCH", "DELETE"],
            &[
                ("GET", &["read:recipes"]),
                ("PATCH", &["write:recipes"]),
                ("DELETE", &["write:recipes"]),
            ],
        )),
        (Some("weight"), None, None, 1) => Some(endpoint(&["GET"], &[("GET", &["read:weight"])])),
        (Some("weight"), Some("entries"), None, 2) => Some(endpoint(
            &["GET", "POST"],
            &[("GET", &["read:weight"]), ("POST", &["write:weight"])],
        )),
        (Some("weight"), Some("entries"), Some(_), 3) => Some(endpoint(
            &["PATCH", "DELETE"],
            &[
                ("PATCH", &["write:weight", "read:weight"]),
                ("DELETE", &["write:weight"]),
            ],
        )),
        (Some("weight"), Some("goal"), None, 2) => Some(endpoint(
            &["GET", "PATCH"],
            &[("GET", &["read:weight"]), ("PATCH", &["write:weight"])],
        )),
        (Some("stats"), None, None, 1) => Some(endpoint(
            &["GET"],
            &[("GET", &["read:stats", "read:weight", "read:goals"])],
        )),
        (Some("summary"), None, None, 1) => Some(endpoint(
            &["GET"],
            &[(
                "GET",
                &["read:stats", "read:daily", "read:goals", "read:weight"],
            )],
        )),
        (Some("leaderboard"), None, None, 1) => {
            Some(endpoint(&["GET"], &[("GET", &["read:stats"])]))
        }
        (Some("openapi.json"), None, None, 1) => Some(endpoint(&["GET"], &[("GET", &[])])),
        _ => None,
    }
}

fn endpoint(
    methods: &'static [&'static str],
    scopes: &'static [(&'static str, &'static [&'static str])],
) -> Endpoint {
    Endpoint { methods, scopes }
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
    let valid = value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .chars()
            .enumerate()
            .all(|(index, ch)| index == 4 || index == 7 || ch.is_ascii_digit())
        && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok();
    if valid {
        Ok(())
    } else {
        Err(bad_request("Date must use YYYY-MM-DD."))
    }
}

fn require_uuid(value: &str) -> ApiResult<String> {
    Uuid::parse_str(value)
        .map(|uuid| uuid.to_string())
        .map_err(|_| bad_request("Path parameter must be a valid UUID."))
}

fn has_non_null(record: &Map<String, Value>, key: &str) -> bool {
    record.get(key).is_some_and(|value| !value.is_null())
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
    match error {
        AppError::BadRequest(message) => bad_request(message),
        AppError::Unauthorized(message) => {
            ApiFailure::new(StatusCode::UNAUTHORIZED, "invalid_token", message)
        }
        AppError::Forbidden(message) => {
            ApiFailure::new(StatusCode::FORBIDDEN, "forbidden", message)
        }
        AppError::NotFound(message) => ApiFailure::new(StatusCode::NOT_FOUND, "not_found", message),
        AppError::Conflict(message) => ApiFailure::new(StatusCode::CONFLICT, "conflict", message),
        AppError::Sqlx(error) => {
            if error
                .as_database_error()
                .and_then(|db| db.constraint())
                .is_some_and(|constraint| constraint == "weight_entries_user_date_key")
            {
                weight_conflict()
            } else {
                tracing::error!(error = ?error, "API v1 storage failure");
                internal_error()
            }
        }
        AppError::Json(error) => {
            tracing::error!(error = ?error, "API v1 JSON failure");
            internal_error()
        }
        AppError::Anyhow(error) => {
            tracing::error!(error = ?error, "API v1 failure");
            internal_error()
        }
        AppError::Upstream(message) => {
            ApiFailure::new(StatusCode::BAD_GATEWAY, "upstream_error", message)
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

fn empty_response(status: StatusCode, allow: Option<&str>) -> Response {
    let mut headers = cors_headers();
    if let Some(allow) = allow {
        headers.insert(header::ALLOW, allow.parse().expect("valid Allow header"));
    }
    (status, headers).into_response()
}

fn cors_headers() -> HeaderMap {
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

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
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
            config: crate::config::Config {
                allow_insecure_internal_auth: false,
                app_url: "http://localhost:3000".to_string(),
                backend_internal_secret: Some("internal-secret-with-at-least-32-chars".to_string()),
                database_url: "postgres://postgres:***@127.0.0.1:5432/macro_tracker".to_string(),
                port: 4000,
                postgres_pool_max: 1,
                session_secret: "session-secret-with-at-least-32-chars".to_string(),
                shoo_base_url: "https://shoo.dev".to_string(),
                trusted_origins: vec!["http://localhost:3000".to_string()],
                admin_owner_emails: vec![],
                openrouter_api_key: None,
                openrouter_model: None,
                openrouter_fallback_models: None,
                openrouter_model_timeout_ms: None,
                open_food_facts_base_url: "https://world.openfoodfacts.org".to_string(),
                albert_heijn_base_url: "https://api.ah.nl".to_string(),
                jumbo_base_url: "https://mobileapi.jumbo.com".to_string(),
            },
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
}
