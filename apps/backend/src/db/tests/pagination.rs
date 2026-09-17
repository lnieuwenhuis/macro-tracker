//! API-01: keyset continuation for the public capped collections.
//!
//! These tests pin the three properties the plan requires: the legacy array
//! responses stay identical, a cap (including `MAX_COLLECTION_ROWS + 1`) is
//! reported truthfully, and walking the cursor returns every owned row exactly
//! once without ever crossing into another owner's rows.

use super::*;
use crate::db::pagination::{
    CollectionPage, LEGACY_COLLECTION_LIMIT, MAX_PAGE_LIMIT, StatsPage, recipes_page_json,
    stats_page_json, templates_page_json, weight_entries_page_json,
};
use crate::errors::AppError;

async fn insert_template_at(pool: &PgPool, user_id: Uuid, label: &str, at: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO meal_templates (id, user_id, type, label, created_at, updated_at)
        VALUES ($1, $2, 'meal', $3, $4::timestamptz, $4::timestamptz)
        "#,
    )
    .bind(id)
    .bind(user_id)
    .bind(label)
    .bind(at)
    .execute(pool)
    .await
    .expect("template should insert");
    id
}

async fn insert_recipe_at(pool: &PgPool, user_id: Uuid, label: &str, at: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO recipes (id, user_id, label, portions, created_at, updated_at)
        VALUES ($1, $2, $3, 1, $4::timestamptz, $4::timestamptz)
        "#,
    )
    .bind(id)
    .bind(user_id)
    .bind(label)
    .bind(at)
    .execute(pool)
    .await
    .expect("recipe should insert");
    id
}

async fn insert_weight_entry(pool: &PgPool, user_id: Uuid, date: &str, weight_kg: f64) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO weight_entries (id, user_id, entry_date, weight_kg)
        VALUES ($1, $2, $3::date, $4)
        "#,
    )
    .bind(id)
    .bind(user_id)
    .bind(date)
    .bind(weight_kg)
    .execute(pool)
    .await
    .expect("weight entry should insert");
    id
}

fn page_ids(page: &CollectionPage) -> Vec<String> {
    page.items
        .as_array()
        .expect("items should be an array")
        .iter()
        .map(|item| {
            item["id"]
                .as_str()
                .expect("id should be a string")
                .to_string()
        })
        .collect()
}

/// Walks one collection with the given page size and returns every id in the
/// order the pages returned them.
async fn walk_templates(pool: &PgPool, user_id: Uuid, limit: i64) -> Vec<String> {
    let mut cursor: Option<String> = None;
    let mut seen = Vec::new();
    loop {
        let page = templates_page_json(pool, user_id, limit, cursor.as_deref())
            .await
            .expect("template page should load");
        assert!(page.items.as_array().expect("array").len() <= limit as usize);
        assert_eq!(page.returned, page_ids(&page).len() as i64);
        assert_eq!(page.truncated, page.next_cursor.is_some());
        seen.extend(page_ids(&page));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
        assert!(seen.len() < 10_000, "cursor walk must terminate");
    }
    seen
}

async fn insert_meal_entries_past_the_series_bound(pool: &PgPool, user_id: Uuid) {
    sqlx::query(
        r#"
        INSERT INTO meal_entries (id, user_id, entry_date, status, label, sort_order, protein_g, carbs_g, fat_g, calories_kcal)
        SELECT gen_random_uuid(), $1, date '2020-01-01' + i, 'eaten', 'Bulk', 0, 10.0, 10.0, 5.0, 200
        FROM generate_series(0, 1000) AS i
        "#,
    )
    .bind(user_id)
    .execute(pool)
    .await
    .expect("bulk meal entries should insert");
}

#[tokio::test]
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
async fn legacy_collection_bodies_are_unchanged_by_the_page_builders() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    for (index, label) in ["one", "two", "three"].iter().enumerate() {
        let at = format!("2026-02-0{}T10:00:00Z", index + 1);
        insert_template_at(&test_db.pool, user_id, label, &at).await;
    }
    for (index, label) in ["alpha", "beta"].iter().enumerate() {
        let at = format!("2026-03-0{}T10:00:00Z", index + 1);
        insert_recipe_at(&test_db.pool, user_id, label, &at).await;
    }
    insert_weight_entry(&test_db.pool, user_id, "2026-01-02", 80.5).await;
    insert_weight_entry(&test_db.pool, user_id, "2026-01-01", 81.0).await;

    let legacy_templates = rpc_json(&test_db.pool, "getTemplates", json!({ "userId": user_id }))
        .await
        .expect("legacy templates should load");
    let page = templates_page_json(&test_db.pool, user_id, LEGACY_COLLECTION_LIMIT, None)
        .await
        .expect("template page should load");
    assert_eq!(page.items, legacy_templates);
    assert!(!page.truncated);
    assert!(page.next_cursor.is_none());

    let legacy_recipes = rpc_json(&test_db.pool, "getRecipes", json!({ "userId": user_id }))
        .await
        .expect("legacy recipes should load");
    let page = recipes_page_json(&test_db.pool, user_id, LEGACY_COLLECTION_LIMIT, None)
        .await
        .expect("recipe page should load");
    assert_eq!(page.items, legacy_recipes);
    assert!(!page.truncated);

    let legacy_weights = rpc_json(
        &test_db.pool,
        "getWeightEntries",
        json!({ "userId": user_id }),
    )
    .await
    .expect("legacy weight entries should load");
    let page = weight_entries_page_json(&test_db.pool, user_id, LEGACY_COLLECTION_LIMIT, None)
        .await
        .expect("weight page should load");
    assert_eq!(page.items, legacy_weights);
    assert!(!page.truncated);

    test_db.cleanup().await;
}

#[tokio::test]
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
async fn template_pages_walk_ties_exactly_once_in_stable_id_order() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    for label in ["a", "b", "c", "d", "e"] {
        insert_template_at(&test_db.pool, user_id, label, "2026-02-01T10:00:00Z").await;
    }
    // Every timestamp ties; the id tie-break is the only thing that decides the order.
    let expected: Vec<String> = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM meal_templates WHERE user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC, id DESC",
    )
    .bind(user_id)
    .fetch_all(&test_db.pool)
    .await
    .expect("expected order should load")
    .into_iter()
    .map(|id| id.to_string())
    .collect();

    let walked = walk_templates(&test_db.pool, user_id, 2).await;
    assert_eq!(walked, expected, "ties must not duplicate or skip rows");

    // A page larger than the collection reports completeness, not truncation.
    let page = templates_page_json(&test_db.pool, user_id, MAX_PAGE_LIMIT, None)
        .await
        .expect("template page should load");
    assert_eq!(page_ids(&page).len(), 5);
    assert!(!page.truncated);
    assert!(page.next_cursor.is_none());

    test_db.cleanup().await;
}

#[tokio::test]
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
async fn cap_plus_one_templates_report_the_legacy_cap_and_continue() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    sqlx::query(
        r#"
        INSERT INTO meal_templates (id, user_id, type, label, created_at, updated_at)
        SELECT gen_random_uuid(), $1, 'meal', 'bulk-' || i, now(), now() - (i || ' seconds')::interval
        FROM generate_series(1, $2) AS i
        "#,
    )
    .bind(user_id)
    .bind(LEGACY_COLLECTION_LIMIT + 1)
    .execute(&test_db.pool)
    .await
    .expect("bulk templates should insert");

    let first = templates_page_json(&test_db.pool, user_id, LEGACY_COLLECTION_LIMIT, None)
        .await
        .expect("template page should load");
    assert_eq!(first.returned, LEGACY_COLLECTION_LIMIT);
    assert!(first.truncated);
    let cursor = first.next_cursor.expect("truncation implies a cursor");

    let second = templates_page_json(
        &test_db.pool,
        user_id,
        LEGACY_COLLECTION_LIMIT,
        Some(&cursor),
    )
    .await
    .expect("continuation page should load");
    assert_eq!(second.returned, 1);
    assert!(!second.truncated);
    assert!(second.next_cursor.is_none());

    test_db.cleanup().await;
}

#[tokio::test]
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
async fn weight_pages_are_ascending_owner_scoped_and_bound_to_the_cursor_owner() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let other_user_id = insert_test_user(&test_db.pool).await;
    let mut expected = Vec::new();
    for (index, date) in [
        "2026-01-01",
        "2026-01-02",
        "2026-01-03",
        "2026-01-04",
        "2026-01-05",
    ]
    .iter()
    .enumerate()
    {
        expected.push(insert_weight_entry(&test_db.pool, user_id, date, 80.0 + index as f64).await);
    }
    insert_weight_entry(&test_db.pool, other_user_id, "2025-12-31", 99.0).await;
    insert_weight_entry(&test_db.pool, other_user_id, "2025-12-30", 99.5).await;

    let mut cursor: Option<String> = None;
    let mut seen = Vec::new();
    loop {
        let page = weight_entries_page_json(&test_db.pool, user_id, 2, cursor.as_deref())
            .await
            .expect("weight page should load");
        let items = page.items.as_array().expect("array").clone();
        assert!(items.len() <= 2);
        let dates: Vec<&str> = items
            .iter()
            .map(|item| item["date"].as_str().expect("date"))
            .collect();
        let mut sorted = dates.clone();
        sorted.sort_unstable();
        assert_eq!(dates, sorted, "each page stays in ascending chart order");
        seen.extend(page_ids(&page));
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => break,
        }
        assert!(seen.len() < 100, "cursor walk must terminate");
    }
    assert_eq!(seen.len(), expected.len());
    let mut seen_sorted = seen.clone();
    seen_sorted.sort_unstable();
    let mut expected_sorted: Vec<String> = expected.iter().map(|id| id.to_string()).collect();
    expected_sorted.sort_unstable();
    assert_eq!(seen_sorted, expected_sorted, "every owned row exactly once");

    // A cursor minted for one account addresses only that account.
    let other_page = weight_entries_page_json(&test_db.pool, other_user_id, 1, None)
        .await
        .expect("other user's page should load");
    let other_cursor = other_page
        .next_cursor
        .expect("two rows and limit 1 implies more");
    let cross_user = weight_entries_page_json(&test_db.pool, user_id, 2, Some(&other_cursor)).await;
    assert!(
        matches!(cross_user, Err(AppError::BadRequest(_))),
        "another user's cursor must be rejected"
    );

    // The owner's own cursor for their first page is accepted.
    let page = weight_entries_page_json(&test_db.pool, user_id, 2, None)
        .await
        .expect("weight page should load");
    let own_cursor = page.next_cursor.expect("5 rows and limit 2 implies more");
    let continued = weight_entries_page_json(&test_db.pool, user_id, 2, Some(&own_cursor))
        .await
        .expect("own cursor should be accepted");
    assert!(!page_ids(&continued).is_empty());

    test_db.cleanup().await;
}

#[tokio::test]
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
async fn malformed_cursors_fail_as_bad_requests_for_every_collection() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    insert_template_at(&test_db.pool, user_id, "one", "2026-02-01T10:00:00Z").await;
    insert_recipe_at(&test_db.pool, user_id, "one", "2026-02-01T10:00:00Z").await;
    insert_weight_entry(&test_db.pool, user_id, "2026-01-01", 80.0).await;

    for error in [
        templates_page_json(&test_db.pool, user_id, 10, Some("not base64!!")).await,
        recipes_page_json(&test_db.pool, user_id, 10, Some("not base64!!")).await,
        weight_entries_page_json(&test_db.pool, user_id, 10, Some("not base64!!")).await,
    ] {
        assert!(
            matches!(error, Err(AppError::BadRequest(_))),
            "malformed cursor must be a bad request"
        );
    }

    test_db.cleanup().await;
}

#[tokio::test]
#[cfg_attr(not(has_test_database), ignore = "needs a test database")]
async fn stats_series_report_their_truncation_window_without_changing_the_body() {
    let test_db = test_db().await;
    let user_id = insert_test_user(&test_db.pool).await;
    let today = "2026-01-12";

    insert_test_meal_entry(
        &test_db.pool,
        user_id,
        "2026-01-10",
        "eaten",
        "Oats",
        0,
        (10.0, 20.0, 5.0, 165),
    )
    .await;
    insert_weight_entry(&test_db.pool, user_id, "2026-01-10", 80.0).await;

    let legacy = rpc_json(
        &test_db.pool,
        "getStatsPageData",
        json!({ "userId": user_id, "today": today }),
    )
    .await
    .expect("legacy stats should load");
    let page: StatsPage = stats_page_json(&test_db.pool, user_id, today)
        .await
        .expect("stats page should load");
    assert_eq!(page.data, legacy, "the stats body stays byte-identical");
    assert!(!page.daily_totals.truncated);
    assert_eq!(page.daily_totals.count, 1);
    assert!(!page.smoothed_weight_trend.truncated);
    assert_eq!(page.smoothed_weight_trend.count, 1);

    insert_meal_entries_past_the_series_bound(&test_db.pool, user_id).await;
    sqlx::query(
        r#"
        INSERT INTO weight_entries (id, user_id, entry_date, weight_kg)
        SELECT gen_random_uuid(), $1, date '2021-01-01' + i, 80
        FROM generate_series(0, 1000) AS i
        "#,
    )
    .bind(user_id)
    .execute(&test_db.pool)
    .await
    .expect("bulk weight entries should insert");

    let page = stats_page_json(&test_db.pool, user_id, today)
        .await
        .expect("stats page should load");
    assert!(page.daily_totals.truncated);
    assert_eq!(page.daily_totals.count, 1000);
    assert!(page.smoothed_weight_trend.truncated);
    assert_eq!(page.smoothed_weight_trend.count, 1000);

    test_db.cleanup().await;
}
