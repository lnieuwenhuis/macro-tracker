//! Regression coverage for the accepted data-integrity findings (DATA-01..DATA-17, API-05).

use super::*;
use crate::db::weight as db_weight;
use chrono::{DateTime, Duration, Utc};

/// Deterministic product fixture with a usable serving weight for linked-meal maths.
async fn seed_product(
    pool: &PgPool,
    user_id: Uuid,
    name: &str,
    protein_per_100: f64,
    calories_per_100: i32,
    serving_weight_g: Option<f64>,
) -> Uuid {
    let product_id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO food_products (
          id, owner_user_id, scope, source, name, brand,
          default_serving_quantity, default_serving_unit,
          protein_per_100, carbs_per_100, fat_per_100, calories_per_100,
          serving_weight_g
        )
        VALUES ($1, $2, 'personal', 'manual', $3, '', 1, 'serving', $4, 0, 0, $5, $6)
        "#,
    )
    .bind(product_id)
    .bind(user_id)
    .bind(name)
    .bind(protein_per_100)
    .bind(calories_per_100)
    .bind(serving_weight_g)
    .execute(pool)
    .await
    .expect("product fixture should insert");
    product_id
}

async fn insert_weight_entry(pool: &PgPool, user_id: Uuid, date: &str, weight_kg: f64) -> Uuid {
    let entry_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO weight_entries (id, user_id, entry_date, weight_kg) VALUES ($1, $2, $3::date, $4)",
    )
    .bind(entry_id)
    .bind(user_id)
    .bind(date)
    .bind(weight_kg)
    .execute(pool)
    .await
    .expect("weight fixture should insert");
    entry_id
}

/// DATA-01: a patch must merge onto the locked row, so a concurrent committed change survives.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn meal_patches_merge_under_the_row_lock_without_losing_a_concurrent_status_change() {
    let test_db = test_db_with_connections(3).await;
    let user_id = insert_test_user(&test_db.pool).await;
    let entry_id = insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-06-20",
        "planned",
        "Oats",
        0,
        (10.0, 20.0, 5.0, 165),
    )
    .await;

    // Simulate the concurrent writer holding the row lock with an uncommitted status change.
    let mut blocker = test_db.pool.begin().await.expect("blocker transaction");
    sqlx::query("UPDATE meal_entries SET status = 'eaten' WHERE id = $1")
        .bind(entry_id)
        .execute(&mut *blocker)
        .await
        .expect("blocker should hold the row lock");

    let patch = meal_payload(&[("label", json!("Breakfast oats"))]);
    let patch_task = {
        let pool = test_db.pool.clone();
        tokio::spawn(async move { update_meal_entry_json(&pool, user_id, entry_id, &patch).await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    blocker.commit().await.expect("release the row lock");

    let updated = patch_task
        .await
        .expect("patch task should join")
        .expect("patch should succeed");
    assert_eq!(updated["label"], json!("Breakfast oats"));
    assert_eq!(
        updated["status"],
        json!("eaten"),
        "the concurrently committed status change must not be overwritten: {updated}"
    );
    test_db.cleanup().await;
}

/// DATA-02: group/label edits keep the stored snapshot; nutrition input changes recalculate.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn non_nutrition_meal_edits_preserve_the_product_snapshot() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let product_id = seed_product(&test_db.pool, user_id, "Yogurt", 20.0, 400, Some(100.0)).await;

    let created = create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[
            ("date", json!("2026-06-20")),
            ("productId", json!(product_id)),
            ("quantity", json!(1.0)),
            ("unit", json!("serving")),
            ("servingMultiplier", json!(1.0)),
        ]),
    )
    .await
    .expect("product-linked meal should be created");
    assert_eq!(created["proteinG"].as_f64(), Some(20.0));

    // The product is corrected after the meal was logged.
    sqlx::query(
        "UPDATE food_products SET protein_per_100 = 30, calories_per_100 = 600 WHERE id = $1",
    )
    .bind(product_id)
    .execute(&test_db.pool)
    .await
    .expect("product correction should apply");

    // A full web-style draft with the stored values and only the label changed.
    let renamed = update_meal_entry_json(
        &test_db.pool,
        user_id,
        Uuid::parse_str(created["id"].as_str().unwrap()).unwrap(),
        &meal_payload(&[
            ("date", json!("2026-06-20")),
            ("productId", json!(product_id)),
            ("label", json!("Renamed yogurt")),
            ("quantity", json!(1.0)),
            ("unit", json!("serving")),
            ("servingMultiplier", json!(1.0)),
            ("proteinG", json!(20.0)),
            ("carbsG", json!(0.0)),
            ("fatG", json!(0.0)),
            ("caloriesKcal", json!(400)),
        ]),
    )
    .await
    .expect("rename should succeed");
    assert_eq!(
        renamed["proteinG"].as_f64(),
        Some(20.0),
        "a non-nutrition edit must keep the stored snapshot: {renamed}"
    );
    assert_eq!(renamed["caloriesKcal"], json!(400));

    // Changing the quantity still recalculates from the current product.
    let resized = update_meal_entry_json(
        &test_db.pool,
        user_id,
        Uuid::parse_str(created["id"].as_str().unwrap()).unwrap(),
        &meal_payload(&[
            ("date", json!("2026-06-20")),
            ("productId", json!(product_id)),
            ("quantity", json!(2.0)),
            ("unit", json!("serving")),
            ("servingMultiplier", json!(1.0)),
        ]),
    )
    .await
    .expect("quantity change should succeed");
    assert_eq!(resized["proteinG"].as_f64(), Some(60.0));
    assert_eq!(resized["caloriesKcal"], json!(1200));

    // An explicit client macro patch on a linked row recalculates from the product instead of
    // pinning the supplied value.
    let pinned = update_meal_entry_json(
        &test_db.pool,
        user_id,
        Uuid::parse_str(created["id"].as_str().unwrap()).unwrap(),
        &meal_payload(&[
            ("date", json!("2026-06-20")),
            ("productId", json!(product_id)),
            ("quantity", json!(2.0)),
            ("unit", json!("serving")),
            ("servingMultiplier", json!(1.0)),
            ("proteinG", json!(1.0)),
            ("caloriesKcal", json!(1)),
        ]),
    )
    .await
    .expect("macro patch should succeed");
    assert_eq!(pinned["proteinG"].as_f64(), Some(60.0));
    test_db.cleanup().await;
}

/// DATA-03: a zero-calorie eaten day with positive macros counts in stats.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn zero_calorie_eaten_days_count_in_stats() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-06-18",
        "eaten",
        "Protein only",
        0,
        (20.0, 0.0, 0.0, 0),
    )
    .await;
    insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-06-19",
        "eaten",
        "Ordinary day",
        0,
        (10.0, 20.0, 5.0, 165),
    )
    .await;
    // A planned day with no eaten entry must stay untracked.
    insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-06-17",
        "planned",
        "Planned only",
        0,
        (10.0, 20.0, 5.0, 165),
    )
    .await;

    let stats = stats_page_data_json(&test_db.pool, user_id, "2026-06-20")
        .await
        .expect("stats should load");
    assert_eq!(stats.data["totalDaysTracked"], json!(2));
    assert_eq!(stats.data["totalProteinG"].as_f64(), Some(30.0));
    assert_eq!(stats.data["totalCaloriesKcal"], json!(165));

    let daily = daily_summary_json(&test_db.pool, user_id, "2026-06-18")
        .await
        .expect("daily summary should load");
    assert_eq!(daily["totals"]["proteinG"].as_f64(), Some(20.0));
    assert_eq!(daily["totals"]["caloriesKcal"], json!(0));

    // Entirely-zero nutrition is still rejected at the write boundary.
    let all_zero = create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[
            ("date", json!("2026-06-20")),
            ("proteinG", json!(0.0)),
            ("carbsG", json!(0.0)),
            ("fatG", json!(0.0)),
            ("caloriesKcal", json!(0)),
        ]),
    )
    .await
    .expect_err("an entirely zero meal must be rejected");
    assert_eq!(
        bad_request_message(Err::<(), _>(all_zero)),
        "At least one macro or calorie value must be greater than zero."
    );
    test_db.cleanup().await;
}

/// DATA-04: the window, eligibility and `sampleTime` follow the client's local day.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn healthkit_sample_time_follows_the_client_local_day() {
    let test_db = test_db().await;

    for offset_minutes in [840_i32, -300, 0] {
        let user_id = insert_test_user(&test_db.pool).await;
        let local_today = (Utc::now() + Duration::minutes(offset_minutes as i64)).date_naive();
        let date = local_today.format("%Y-%m-%d").to_string();
        insert_test_meal_entry(
            &test_db.pool,
            user_id,
            &date,
            "eaten",
            "Local day",
            0,
            (10.0, 20.0, 5.0, 165),
        )
        .await;
        let future_date = (local_today + Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        insert_test_meal_entry(
            &test_db.pool,
            user_id,
            &future_date,
            "eaten",
            "Future day",
            1,
            (10.0, 20.0, 5.0, 165),
        )
        .await;

        let payload =
            healthkit::healthkit_sync_entries_json(&test_db.pool, user_id, 7, 100, offset_minutes)
                .await
                .expect("healthkit sync should load");
        let entries = payload["entries"]
            .as_array()
            .expect("entries should be an array");
        assert_eq!(
            entries.len(),
            1,
            "only the local-today entry is eligible at offset {offset_minutes}: {payload}"
        );
        let sample = entries[0]["sampleTime"]
            .as_str()
            .expect("sampleTime should be a string");
        let sample_utc = DateTime::parse_from_rfc3339(sample)
            .expect("sampleTime should parse")
            .with_timezone(&Utc);
        let sample_local = sample_utc + Duration::minutes(offset_minutes as i64);
        assert_eq!(
            sample_local.date_naive(),
            local_today,
            "sampleTime must map back to the entry's local date at offset {offset_minutes}"
        );
        assert!(
            sample_utc <= Utc::now() + Duration::seconds(2),
            "sampleTime must not be future-dated: {sample}"
        );
    }

    test_db.cleanup().await;
}

/// DATA-05: quantities that persist as `0.00` are rejected before nutrition maths.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn linked_quantities_round_to_persistence_precision() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let product_id = seed_product(&test_db.pool, user_id, "Yogurt", 100.0, 400, Some(100.0)).await;

    let rejected = create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[
            ("date", json!("2026-06-20")),
            ("productId", json!(product_id)),
            ("quantity", json!(0.004)),
            ("unit", json!("serving")),
            ("servingMultiplier", json!(1.0)),
        ]),
    )
    .await
    .expect_err("0.004 must not persist as zero");
    assert_eq!(
        bad_request_message(Err::<(), _>(rejected)),
        "Quantity must be at least 0.01."
    );

    let created = create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[
            ("date", json!("2026-06-20")),
            ("productId", json!(product_id)),
            ("quantity", json!(0.005)),
            ("unit", json!("serving")),
            ("servingMultiplier", json!(1.0)),
        ]),
    )
    .await
    .expect("0.005 rounds to a representable 0.01");
    assert_eq!(created["quantity"].as_f64(), Some(0.01));
    assert_eq!(created["proteinG"].as_f64(), Some(1.0));

    let rejected_default = create_food_product_json(
        &test_db.pool,
        user_id,
        &food_payload(&[("defaultServingQuantity", json!(0.004))]),
        true,
    )
    .await
    .expect_err("a default serving that rounds to zero is unusable");
    assert_eq!(
        bad_request_message(Err::<(), _>(rejected_default)),
        "Default serving quantity must be a positive number."
    );

    let product = create_food_product_json(
        &test_db.pool,
        user_id,
        &food_payload(&[("defaultServingQuantity", json!(0.005))]),
        true,
    )
    .await
    .expect("0.005 rounds to a representable default");
    assert_eq!(product["defaultServingQuantity"], json!(0.01));

    // The serving multiplier follows the same precision rule.
    let rejected_multiplier = create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[
            ("date", json!("2026-06-21")),
            ("productId", json!(product_id)),
            ("servingMultiplier", json!(0.004)),
        ]),
    )
    .await
    .expect_err("a multiplier that rounds to zero must be rejected");
    assert_eq!(
        bad_request_message(Err::<(), _>(rejected_multiplier)),
        "Serving multiplier must be at least 0.01."
    );

    // A saved quantity round-trips through a later non-nutrition edit.
    let saved = create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[
            ("date", json!("2026-06-21")),
            ("productId", json!(product_id)),
            ("quantity", json!(0.005)),
            ("unit", json!("serving")),
            ("servingMultiplier", json!(1.0)),
        ]),
    )
    .await
    .expect("0.005 quantity saves as 0.01");
    let stored_quantity = saved["quantity"].as_f64().expect("quantity");
    let renamed = update_meal_entry_json(
        &test_db.pool,
        user_id,
        Uuid::parse_str(saved["id"].as_str().unwrap()).unwrap(),
        &meal_payload(&[
            ("date", json!("2026-06-21")),
            ("productId", json!(product_id)),
            ("label", json!("Renamed")),
            ("quantity", json!(stored_quantity)),
            ("unit", json!("serving")),
            ("servingMultiplier", json!(1.0)),
            ("proteinG", saved["proteinG"].clone()),
            ("carbsG", saved["carbsG"].clone()),
            ("fatG", saved["fatG"].clone()),
            ("caloriesKcal", saved["caloriesKcal"].clone()),
        ]),
    )
    .await
    .expect("a later edit must accept the persisted quantity");
    assert_eq!(renamed["quantity"].as_f64(), Some(stored_quantity));
    test_db.cleanup().await;
}

/// DATA-06: applying a template appends the block in template order.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn template_items_append_in_template_order() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-06-20",
        "planned",
        "Existing A",
        0,
        (1.0, 1.0, 1.0, 10),
    )
    .await;
    insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-06-20",
        "planned",
        "Existing B",
        1,
        (1.0, 1.0, 1.0, 10),
    )
    .await;

    let template = rpc_json(
        &test_db.pool,
        "createTemplate",
        json!({
            "userId": user_id,
            "input": {
                "type": "day",
                "label": "Two items",
                "items": [
                    { "label": "First", "quantity": 1.0, "unit": "serving", "servingMultiplier": 1.0, "proteinG": 1.0, "carbsG": 1.0, "fatG": 1.0, "caloriesKcal": 10 },
                    { "label": "Second", "quantity": 1.0, "unit": "serving", "servingMultiplier": 1.0, "proteinG": 1.0, "carbsG": 1.0, "fatG": 1.0, "caloriesKcal": 10 }
                ]
            }
        }),
    )
    .await
    .expect("template should save");
    let template_id = template["id"].as_str().unwrap();

    for expected_base in [2_i32, 4] {
        let applied = rpc_json(
            &test_db.pool,
            "applyTemplateToDate",
            json!({
                "userId": user_id,
                "input": { "templateId": template_id, "date": "2026-06-20", "status": "planned" }
            }),
        )
        .await
        .expect("template should apply");

        let block: Vec<(String, i32)> = applied
            .as_array()
            .expect("applied entries")
            .iter()
            .map(|entry| {
                (
                    entry["label"].as_str().unwrap().to_string(),
                    entry["sortOrder"].as_i64().unwrap() as i32,
                )
            })
            .collect();
        assert_eq!(
            block,
            vec![
                ("First".to_string(), expected_base),
                ("Second".to_string(), expected_base + 1),
            ],
            "each template application must append its items in template order"
        );
    }

    let existing_orders: Vec<(String, i32)> = sqlx::query(
        "SELECT label, sort_order FROM meal_entries WHERE user_id = $1 AND entry_date = '2026-06-20'::date AND label IN ('Existing A', 'Existing B') ORDER BY sort_order",
    )
    .bind(user_id)
    .fetch_all(&test_db.pool)
    .await
    .expect("existing rows load")
    .iter()
    .map(|row| (row.try_get("label").unwrap(), row.try_get("sort_order").unwrap()))
    .collect();
    assert_eq!(
        existing_orders,
        vec![("Existing A".to_string(), 0), ("Existing B".to_string(), 1),],
        "existing orders must not move"
    );
    test_db.cleanup().await;
}

/// DATA-07: a create cannot commit a row referencing a group that deletion soft-deleted.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn group_deletion_races_with_meal_assignment() {
    let test_db = test_db_with_connections(3).await;
    let user_id = insert_test_user(&test_db.pool).await;
    ensure_default_meal_groups(&test_db.pool, user_id)
        .await
        .expect("default groups");
    let group_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM meal_groups WHERE user_id = $1 AND label = 'Lunch' AND deleted_at IS NULL",
    )
    .bind(user_id)
    .fetch_one(&test_db.pool)
    .await
    .expect("Lunch group");

    // The deleter holds the group row lock with the soft-delete uncommitted.
    let mut deleter = test_db.pool.begin().await.expect("deleter transaction");
    sqlx::query("UPDATE meal_groups SET deleted_at = now(), updated_at = now() WHERE id = $1")
        .bind(group_id)
        .execute(&mut *deleter)
        .await
        .expect("deleter should hold the group lock");

    let create_input = meal_payload(&[
        ("date", json!("2026-06-20")),
        ("mealGroupId", json!(group_id)),
    ]);
    let create_task = {
        let pool = test_db.pool.clone();
        tokio::spawn(async move { create_meal_entry_json(&pool, user_id, &create_input).await })
    };
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    deleter.commit().await.expect("release the group lock");

    let result = create_task.await.expect("create task should join");
    assert!(
        result.is_err(),
        "assigning a concurrently deleted group must be rejected: {result:?}"
    );
    let dangling: i64 = sqlx::query_scalar(
        "SELECT count(*)::bigint FROM meal_entries WHERE user_id = $1 AND meal_group_id = $2",
    )
    .bind(user_id)
    .bind(group_id)
    .fetch_one(&test_db.pool)
    .await
    .expect("dangling count");
    assert_eq!(dangling, 0, "no active meal may reference a deleted group");

    // Updates moving an existing meal into the deleted group are rejected the same way.
    let entry_id = insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-06-21",
        "eaten",
        "Movable",
        0,
        (1.0, 1.0, 1.0, 10),
    )
    .await;
    let mut second_deleter = test_db
        .pool
        .begin()
        .await
        .expect("second deleter transaction");
    sqlx::query("UPDATE meal_groups SET deleted_at = now(), updated_at = now() WHERE id = $1")
        .bind(group_id)
        .execute(&mut *second_deleter)
        .await
        .expect("second deleter should hold the group lock");
    let move_input = meal_payload(&[("mealGroupId", json!(group_id))]);
    let move_task = {
        let pool = test_db.pool.clone();
        tokio::spawn(
            async move { update_meal_entry_json(&pool, user_id, entry_id, &move_input).await },
        )
    };
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    second_deleter
        .commit()
        .await
        .expect("release the second group lock");
    assert!(move_task.await.expect("move task should join").is_err());
    test_db.cleanup().await;
}

/// DATA-08: historical stats ignore measurements after the selected reference date.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn historical_weight_stats_ignore_later_measurements() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    insert_weight_entry(&test_db.pool, user_id, "2026-06-23", 83.0).await;
    insert_weight_entry(&test_db.pool, user_id, "2026-06-30", 81.5).await;
    insert_weight_entry(&test_db.pool, user_id, "2026-08-01", 70.0).await;

    let data = db_weight::weight_page_data_json(&test_db.pool, user_id, "2026-06-30")
        .await
        .expect("weight page should load");
    assert_eq!(
        data["entries"].as_array().map(Vec::len),
        Some(3),
        "the chart keeps every row"
    );
    assert_eq!(data["stats"]["currentWeight"], json!(81.5));
    assert_eq!(data["stats"]["weekChange"], json!(-1.5));
    assert_eq!(data["stats"]["trendDirection"], json!("down"));

    // A reference date before every measurement has no as-of stats.
    let earlier = db_weight::weight_page_data_json(&test_db.pool, user_id, "2026-06-01")
        .await
        .expect("weight page should load");
    assert_eq!(earlier["stats"]["currentWeight"], json!(null));
    assert_eq!(earlier["stats"]["weekChange"], json!(null));
    test_db.cleanup().await;
}

/// DATA-09: known expected collisions surface as actionable conflicts.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn expected_unique_conflicts_are_conflicts() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let occupied_id = insert_weight_entry(&test_db.pool, user_id, "2026-06-20", 80.0).await;
    insert_weight_entry(&test_db.pool, user_id, "2026-06-21", 79.0).await;

    let conflict = rpc_json(
        &test_db.pool,
        "updateWeightEntry",
        json!({
            "userId": user_id,
            "entryId": occupied_id,
            "input": { "date": "2026-06-21", "weightKg": 78.0 }
        }),
    )
    .await
    .expect_err("moving onto an occupied date must conflict");
    match conflict {
        AppError::Conflict(message) => {
            assert_eq!(message, "A weight entry already exists for that date.")
        }
        other => panic!("expected a conflict, got {other:?}"),
    }
    let stored: f64 =
        sqlx::query_scalar("SELECT weight_kg::float8 FROM weight_entries WHERE id = $1")
            .bind(occupied_id)
            .fetch_one(&test_db.pool)
            .await
            .expect("stored weight");
    assert_eq!(stored, 80.0, "a failed move must not change the row");

    // Fixture parity (TEST-01/MIG-01) provides meal_groups_active_default_label_key; no stopgap needed.
    ensure_default_meal_groups(&test_db.pool, user_id)
        .await
        .expect("default groups");
    let breakfast_id: Uuid = sqlx::query_scalar(
        "SELECT id FROM meal_groups WHERE user_id = $1 AND label = 'Breakfast' AND deleted_at IS NULL",
    )
    .bind(user_id)
    .fetch_one(&test_db.pool)
    .await
    .expect("Breakfast group");

    let rename = rpc_json(
        &test_db.pool,
        "updateMealGroup",
        json!({ "userId": user_id, "groupId": breakfast_id, "input": { "label": "Lunch" } }),
    )
    .await
    .expect_err("renaming a default onto another default label must conflict");
    match rename {
        AppError::Conflict(message) => {
            assert_eq!(message, "A default meal group already uses that name.")
        }
        other => panic!("expected a conflict, got {other:?}"),
    }
    test_db.cleanup().await;
}

/// DATA-10: zero, rounding-to-zero and wrong-typed goals are rejected; null still clears.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn weight_goal_rejects_zero_rounding_and_wrong_types() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;

    rpc_json(
        &test_db.pool,
        "saveWeightGoal",
        json!({ "userId": user_id, "goalWeightKg": 72.5 }),
    )
    .await
    .expect("a normal goal saves");

    for invalid in [json!(0.0), json!(0.004), json!("abc"), json!(true)] {
        let result = rpc_json(
            &test_db.pool,
            "saveWeightGoal",
            json!({ "userId": user_id, "goalWeightKg": invalid }),
        )
        .await;
        assert!(
            matches!(result, Err(AppError::BadRequest(_))),
            "expected {invalid} to be rejected, got {result:?}"
        );
    }

    let stored = rpc_json(&test_db.pool, "getWeightGoal", json!({ "userId": user_id }))
        .await
        .expect("goal reads");
    assert_eq!(
        stored,
        json!(72.5),
        "invalid payloads must not clear the goal"
    );

    rpc_json(
        &test_db.pool,
        "saveWeightGoal",
        json!({ "userId": user_id, "goalWeightKg": null }),
    )
    .await
    .expect("null clears");
    let cleared = rpc_json(&test_db.pool, "getWeightGoal", json!({ "userId": user_id }))
        .await
        .expect("goal reads");
    assert_eq!(cleared, json!(null));
    test_db.cleanup().await;
}

/// DATA-11: oversized mutation ids fail before the write and valid retries still deduplicate.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn oversized_mutation_ids_are_rejected_before_write() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;

    let oversized = create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[
            ("date", json!("2026-06-20")),
            ("clientMutationId", json!("a".repeat(129))),
        ]),
    )
    .await
    .expect_err("an oversized mutation id must be rejected");
    assert_eq!(
        bad_request_message(Err::<(), _>(oversized)),
        "clientMutationId must be at most 128 characters."
    );
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*)::bigint FROM meal_entries WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&test_db.pool)
            .await
            .expect("row count");
    assert_eq!(rows, 0, "no row may be written for a rejected payload");

    let boundary_id = "b".repeat(128);
    let created = create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[
            ("date", json!("2026-06-20")),
            ("clientMutationId", json!(boundary_id)),
        ]),
    )
    .await
    .expect("a boundary-length id saves");
    let retried = create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[
            ("date", json!("2026-06-20")),
            ("clientMutationId", json!(boundary_id)),
        ]),
    )
    .await
    .expect("identical retry deduplicates");
    assert_eq!(created["id"], retried["id"]);

    // The limit counts characters, so a multibyte id at the boundary still saves.
    let multibyte_id = "é".repeat(128);
    create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[
            ("date", json!("2026-06-20")),
            ("clientMutationId", json!(multibyte_id)),
        ]),
    )
    .await
    .expect("a multibyte boundary id saves");
    let multibyte_over = create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[
            ("date", json!("2026-06-20")),
            ("clientMutationId", json!("é".repeat(129))),
        ]),
    )
    .await
    .expect_err("a multibyte id past the boundary is rejected");
    assert_eq!(
        bad_request_message(Err::<(), _>(multibyte_over)),
        "clientMutationId must be at most 128 characters."
    );
    test_db.cleanup().await;
}

/// DATA-12: missing source serving size is flagged through the real submission path.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn missing_serving_size_review_signal_uses_provenance() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;

    let mut missing_size = barcode_payload(&unique_test_barcode());
    missing_size.remove("servingSizeG");
    let missing_product = rpc_json(
        &test_db.pool,
        "saveBarcodeFoodProduct",
        json!({ "userId": user_id, "input": missing_size }),
    )
    .await
    .expect("submission without a serving size saves");
    let missing_id = missing_product["id"].as_str().unwrap();

    let explicit_payload = barcode_payload(&unique_test_barcode());
    let explicit_product = rpc_json(
        &test_db.pool,
        "saveBarcodeFoodProduct",
        json!({ "userId": user_id, "input": explicit_payload }),
    )
    .await
    .expect("explicit 100 g submission saves");
    let explicit_id = explicit_product["id"].as_str().unwrap();

    let queue = list_admin_barcode_products_json(&test_db.pool, &serde_json::Map::new(), true)
        .await
        .expect("review queue loads");
    let reasons_for = |product_id: &str| -> Vec<String> {
        queue["items"]
            .as_array()
            .expect("items")
            .iter()
            .find(|item| item["id"] == json!(product_id))
            .and_then(|item| item["reviewReasons"].as_array())
            .map(|reasons| {
                reasons
                    .iter()
                    .filter_map(|reason| reason.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    assert!(
        reasons_for(missing_id).contains(&"missing_serving_size".to_string()),
        "a real missing-source submission must be flagged: {queue}"
    );
    assert!(
        !reasons_for(explicit_id).contains(&"missing_serving_size".to_string()),
        "an explicit serving size must not be flagged: {queue}"
    );
    test_db.cleanup().await;
}

/// DATA-13: extreme stored orders cannot poison later appends.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn extreme_sort_orders_do_not_poison_the_day() {
    let test_db = test_db_with_connections(4).await;
    let user_id = insert_test_user(&test_db.pool).await;
    insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-06-20",
        "planned",
        "Extreme",
        i32::MAX,
        (1.0, 1.0, 1.0, 10),
    )
    .await;

    let created = create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[("date", json!("2026-06-20"))]),
    )
    .await
    .expect("an append next to an extreme order must succeed");
    let order = created["sortOrder"].as_i64().expect("sortOrder");
    assert!(
        (0..=i32::MAX as i64).contains(&order),
        "append order must stay representable: {order}"
    );

    let template = rpc_json(
        &test_db.pool,
        "createTemplate",
        json!({
            "userId": user_id,
            "input": {
                "type": "day",
                "label": "Extreme day",
                "items": [
                    { "label": "One", "quantity": 1.0, "unit": "serving", "servingMultiplier": 1.0, "proteinG": 1.0, "carbsG": 1.0, "fatG": 1.0, "caloriesKcal": 10 },
                    { "label": "Two", "quantity": 1.0, "unit": "serving", "servingMultiplier": 1.0, "proteinG": 1.0, "carbsG": 1.0, "fatG": 1.0, "caloriesKcal": 10 }
                ]
            }
        }),
    )
    .await
    .expect("template saves");
    let applied = rpc_json(
        &test_db.pool,
        "applyTemplateToDate",
        json!({
            "userId": user_id,
            "input": { "templateId": template["id"], "date": "2026-06-20", "status": "planned" }
        }),
    )
    .await
    .expect("multi-item application next to an extreme order must succeed");
    assert_eq!(applied.as_array().map(Vec::len), Some(2));

    // Concurrent appends must each return a representable order (a tie is acceptable).
    let task_a = {
        let pool = test_db.pool.clone();
        tokio::spawn(async move {
            create_meal_entry_json(
                &pool,
                user_id,
                &meal_payload(&[
                    ("date", json!("2026-06-21")),
                    ("label", json!("Concurrent A")),
                ]),
            )
            .await
        })
    };
    let task_b = {
        let pool = test_db.pool.clone();
        tokio::spawn(async move {
            create_meal_entry_json(
                &pool,
                user_id,
                &meal_payload(&[
                    ("date", json!("2026-06-21")),
                    ("label", json!("Concurrent B")),
                ]),
            )
            .await
        })
    };
    let (first, second) = tokio::join!(task_a, task_b);
    for result in [first, second] {
        let entry = result
            .expect("append task should join")
            .expect("a concurrent append must succeed");
        let order = entry["sortOrder"].as_i64().expect("sortOrder");
        assert!(
            (0..=i32::MAX as i64).contains(&order),
            "concurrent append order must stay representable: {order}"
        );
    }
    test_db.cleanup().await;
}

/// DATA-14: present invalid optional numbers are rejected instead of becoming defaults.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn invalid_present_numbers_are_rejected_not_defaulted() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;

    let invalid_quantity = create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[("date", json!("2026-06-20")), ("quantity", json!("abc"))]),
    )
    .await
    .expect_err("a non-numeric quantity must be rejected");
    assert_eq!(
        bad_request_message(Err::<(), _>(invalid_quantity)),
        "quantity must be a finite number."
    );

    let invalid_serving = create_food_product_json(
        &test_db.pool,
        user_id,
        &food_payload(&[("servingWeightG", json!(true))]),
        true,
    )
    .await
    .expect_err("a boolean serving weight must be rejected");
    assert_eq!(
        bad_request_message(Err::<(), _>(invalid_serving)),
        "servingWeightG must be a finite number."
    );

    // Finite numeric strings keep their intentional compatibility.
    let created = create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[("date", json!("2026-06-20")), ("quantity", json!("2.5"))]),
    )
    .await
    .expect("numeric strings stay supported");
    assert_eq!(created["quantity"], json!(2.5));
    test_db.cleanup().await;
}

/// DATA-15: every write path shares the 4-20 byte lookup domain.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn barcode_writes_share_the_lookup_domain() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;

    for invalid in ["123".to_string(), "x".repeat(21)] {
        let result = rpc_json(
            &test_db.pool,
            "saveBarcodeFoodProduct",
            json!({ "userId": user_id, "input": barcode_payload(&invalid) }),
        )
        .await;
        assert!(
            matches!(&result, Err(AppError::BadRequest(message)) if message == "Barcode must be 4 to 20 characters."),
            "expected {invalid:?} to be rejected, got {result:?}"
        );
    }

    for valid in ["1234".to_string(), "9".repeat(20)] {
        rpc_json(
            &test_db.pool,
            "saveBarcodeFoodProduct",
            json!({ "userId": user_id, "input": barcode_payload(&valid) }),
        )
        .await
        .expect("a boundary-length barcode saves");
        let looked_up = rpc_json(
            &test_db.pool,
            "lookupBarcodeFoodProduct",
            json!({ "barcode": valid }),
        )
        .await
        .expect("lookup works");
        assert!(!looked_up.is_null(), "stored barcode must be addressable");
    }

    // The personal/public product write path shares the same validator.
    assert_eq!(
        bad_request_message(normalize_food_product_input(
            &food_payload(&[("barcode", json!("12"))]),
            "personal",
        )),
        "Barcode must be 4 to 20 characters."
    );
    test_db.cleanup().await;
}

/// DATA-16: the compact shopping projection carries the multiplier nutrition uses.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn shopping_projection_carries_the_serving_multiplier() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let product_id = seed_product(&test_db.pool, user_id, "Yogurt", 10.0, 165, Some(100.0)).await;

    create_meal_entry_json(
        &test_db.pool,
        user_id,
        &meal_payload(&[
            ("date", json!("2026-06-20")),
            ("status", json!("planned")),
            ("productId", json!(product_id)),
            ("quantity", json!(2.0)),
            ("unit", json!("serving")),
            ("servingMultiplier", json!(3.0)),
        ]),
    )
    .await
    .expect("planned linked meal");

    let summaries =
        planned_shopping_summaries_json(&test_db.pool, user_id, &["2026-06-20".to_string()])
            .await
            .expect("shopping summaries load");
    assert_eq!(summaries[0]["meals"][0]["quantity"].as_f64(), Some(2.0));
    assert_eq!(
        summaries[0]["meals"][0]["servingMultiplier"].as_f64(),
        Some(3.0),
        "the shopping builder needs the multiplier to match nutrition: {summaries}"
    );
    test_db.cleanup().await;
}

/// DATA-17: the audit before-image is captured under the row lock.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn admin_before_image_follows_the_lock() {
    let test_db = test_db_with_connections(3).await;
    let admin_id = insert_test_user_with_email(&test_db.pool, "admin.audit@example.test").await;
    sqlx::query("UPDATE users SET role = 'admin' WHERE id = $1")
        .bind(admin_id)
        .execute(&test_db.pool)
        .await
        .expect("admin role");
    let barcode = unique_test_barcode();
    let product_id = insert_test_admin_barcode_product(
        &test_db.pool,
        &barcode,
        "Audit target",
        "Brand",
        None,
        false,
    )
    .await;

    // A concurrent admin commits S1 while we hold the row lock.
    let mut first_admin = test_db.pool.begin().await.expect("first admin tx");
    sqlx::query("UPDATE food_products SET name = 'S1' WHERE id = $1")
        .bind(product_id)
        .execute(&mut *first_admin)
        .await
        .expect("first admin holds the row lock");

    let input = barcode_payload(&barcode);
    let update_task = {
        let pool = test_db.pool.clone();
        tokio::spawn(async move {
            update_admin_barcode_product_json(&pool, admin_id, product_id, &input, None, None).await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    first_admin.commit().await.expect("S1 commits");

    let updated = update_task
        .await
        .expect("update task should join")
        .expect("admin update should succeed");
    assert_eq!(updated["name"], json!("Community Bar"));

    let details: Value = sqlx::query_scalar(
        "SELECT details_json FROM admin_audit_events WHERE target_id = $1 ORDER BY created_at DESC, id LIMIT 1",
    )
    .bind(product_id.to_string())
    .fetch_one(&test_db.pool)
    .await
    .expect("audit event");
    assert_eq!(
        details["before"]["name"],
        json!("S1"),
        "the before-image must be the locked predecessor, not a stale earlier value: {details}"
    );
    assert_eq!(details["after"]["name"], json!("Community Bar"));
    test_db.cleanup().await;
}

/// API-05: the admin detail exposes `updatedAt` without widening the session recipe payload.
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
#[tokio::test]
async fn admin_user_detail_recipe_has_updated_at() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    rpc_json(
        &test_db.pool,
        "createRecipe",
        json!({
            "userId": user_id,
            "input": {
                "label": "Chili",
                "portions": 2,
                "ingredients": [
                    { "label": "Beans", "quantity": 1.0, "unit": "serving", "servingMultiplier": 1.0, "proteinG": 10.0, "carbsG": 20.0, "fatG": 5.0, "caloriesKcal": 165 }
                ]
            }
        }),
    )
    .await
    .expect("recipe saves");

    let detail = get_admin_user_detail_json(&test_db.pool, user_id)
        .await
        .expect("admin detail loads");
    let updated_at = detail["recentRecipes"][0]["updatedAt"]
        .as_str()
        .expect("admin recipes must carry updatedAt");
    assert!(
        DateTime::parse_from_rfc3339(updated_at).is_ok(),
        "updatedAt must be a parseable timestamp: {updated_at}"
    );

    let session_recipes = recipes_json(&test_db.pool, user_id)
        .await
        .expect("session recipes load");
    assert!(
        session_recipes[0].get("updatedAt").is_none(),
        "the public recipe projection stays unchanged: {session_recipes}"
    );
    test_db.cleanup().await;
}
