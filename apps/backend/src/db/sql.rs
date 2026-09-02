//! SQL fragments spelled out once and rendered into the queries in `db.rs`.

/// `@` in a column expression is replaced by the caller's qualifier, so one
/// projection serves both unqualified and aliased selects.
const QUALIFIER_MARKER: char = '@';

const FIELD_SEPARATOR: &str = ",\n          ";

fn fields(columns: &[(&str, &str)], qualifier: &str) -> String {
    columns
        .iter()
        .map(|(key, expression)| {
            format!(
                "'{key}', {}",
                expression.replace(QUALIFIER_MARKER, qualifier)
            )
        })
        .collect::<Vec<_>>()
        .join(FIELD_SEPARATOR)
}

const FOOD_PRODUCT_COLUMNS: &[(&str, &str)] = &[
    ("id", "@id"),
    ("ownerUserId", "@owner_user_id"),
    ("scope", "@scope"),
    ("source", "@source"),
    ("barcode", "@barcode"),
    ("name", "@name"),
    ("brand", "@brand"),
    (
        "defaultServingQuantity",
        "@default_serving_quantity::float8",
    ),
    ("defaultServingUnit", "@default_serving_unit"),
    ("proteinPer100", "@protein_per_100::float8"),
    ("carbsPer100", "@carbs_per_100::float8"),
    ("fatPer100", "@fat_per_100::float8"),
    ("caloriesPer100", "@calories_per_100"),
    ("servingWeightG", "@serving_weight_g::float8"),
    ("servingVolumeMl", "@serving_volume_ml::float8"),
    ("submittedByUserId", "@submitted_by_user_id"),
    ("deletedByUserId", "@deleted_by_user_id"),
    ("sourceProvider", "@source_provider"),
    ("sourceConfidence", "@source_confidence::float8"),
    ("sourceMetadata", "@source_metadata"),
    ("correctedFromProductId", "@corrected_from_product_id"),
    ("createdAt", "@created_at"),
    ("updatedAt", "@updated_at"),
    ("deletedAt", "@deleted_at"),
];

/// `productId` and `sourceLabel` read through the `fp` join every caller adds,
/// so a soft-deleted product is invisible rather than a dangling id (DATA-08).
const MEAL_ENTRY_COLUMNS: &[(&str, &str)] = &[
    ("id", "@id"),
    ("userId", "@user_id"),
    ("date", "@entry_date"),
    ("mealGroupId", "@meal_group_id"),
    ("status", "@status"),
    (
        "productId",
        "CASE WHEN fp.id IS NULL THEN NULL ELSE @product_id END",
    ),
    ("label", "@label"),
    ("sortOrder", "@sort_order"),
    ("quantity", "@quantity::float8"),
    ("unit", "@unit"),
    ("servingMultiplier", "@serving_multiplier::float8"),
    ("proteinG", "@protein_g::float8"),
    ("carbsG", "@carbs_g::float8"),
    ("fatG", "@fat_g::float8"),
    ("caloriesKcal", "@calories_kcal"),
    ("clientMutationId", "@client_mutation_id"),
    ("sourceLabel", "fp.name"),
];

const ADMIN_AUDIT_EVENT_COLUMNS: &[(&str, &str)] = &[
    ("id", "ae.id"),
    ("actorUserId", "ae.actor_user_id"),
    ("actorEmail", "u.email"),
    ("actorDisplayName", "u.display_name"),
    ("actorRole", "ae.actor_role"),
    ("action", "ae.action"),
    ("targetType", "ae.target_type"),
    ("targetId", "ae.target_id"),
    ("details", "ae.details_json"),
    ("createdAt", "ae.created_at"),
];

pub(super) fn food_product_fields(qualifier: &str) -> String {
    fields(FOOD_PRODUCT_COLUMNS, qualifier)
}

pub(super) fn meal_entry_fields(qualifier: &str) -> String {
    fields(MEAL_ENTRY_COLUMNS, qualifier)
}

pub(super) fn admin_audit_event_fields() -> String {
    fields(ADMIN_AUDIT_EVENT_COLUMNS, "")
}

pub(super) const INSERT_MEAL_ENTRY: &str = r#"
        INSERT INTO meal_entries (
          id, user_id, entry_date, meal_group_id, status, product_id, label,
          sort_order, quantity, unit, serving_multiplier, protein_g, carbs_g,
          fat_g, calories_kcal, client_mutation_id
        )
        VALUES (
          $1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
        )
        ON CONFLICT (user_id, client_mutation_id) DO NOTHING
        RETURNING id
        "#;

/// The `VALUES` list stays at each call site: one writes `owner_user_id` as a
/// bind, the other as a literal `NULL`, which shifts every later placeholder.
pub(super) const INSERT_FOOD_PRODUCT_COLUMNS: &str = r#"
        INSERT INTO food_products (
          id, owner_user_id, scope, source, barcode, name, brand,
          default_serving_quantity, default_serving_unit, protein_per_100,
          carbs_per_100, fat_per_100, calories_per_100, serving_weight_g,
          serving_volume_ml, submitted_by_user_id, source_provider,
          source_confidence, source_metadata, corrected_from_product_id,
          updated_at
        )"#;
