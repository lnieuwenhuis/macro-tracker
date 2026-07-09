use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacroGoals {
    pub protein_g: Option<f64>,
    pub carbs_g: Option<f64>,
    pub fat_g: Option<f64>,
    pub calories_kcal: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUser {
    pub user_id: Uuid,
    pub email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUser {
    pub id: Uuid,
    pub email: String,
    pub shoo_pairwise_sub: String,
    pub display_name: Option<String>,
    pub picture_url: Option<String>,
    pub role: String,
    pub created_at: DateTime<Utc>,
    pub last_login_at: DateTime<Utc>,
    pub goal_calories_kcal: Option<i32>,
    pub goal_protein_g: Option<f64>,
    pub goal_carbs_g: Option<f64>,
    pub goal_fat_g: Option<f64>,
    pub goal_weight_kg: Option<f64>,
    pub onboarding_completed_at: Option<DateTime<Utc>>,
    pub preferred_weight_unit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShooProfile {
    pub pairwise_sub: String,
    pub email: String,
    pub display_name: Option<String>,
    pub picture_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalRpcRequest {
    pub op: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OkResponse<T: Serialize> {
    pub ok: bool,
    pub data: T,
}

pub fn ok<T: Serialize>(data: T) -> OkResponse<T> {
    OkResponse { ok: true, data }
}
