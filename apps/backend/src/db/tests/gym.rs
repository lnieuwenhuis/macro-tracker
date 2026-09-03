use crate::db::gym::{
    GYM_FRIEND_CODE_ALPHABET, GYM_FRIEND_CODE_LENGTH, GymInviteIdentifier,
    classify_gym_invite_identifier, ensure_gym_status, generate_gym_friend_code,
    gym_merge_overlaps, gym_slot_values,
};
use serde_json::{Value, json};

fn gym_input(pairs: &[(&str, Value)]) -> serde_json::Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| (key.to_string(), value.clone()))
        .collect()
}

#[test]
fn gym_slot_values_validates_shape_and_minutes() {
    // Weekly slot, title defaulted, midnight end (1440) allowed.
    let values = gym_slot_values(&gym_input(&[
        ("recurrence", json!("weekly")),
        ("weekday", json!(1)),
        ("startMinute", json!(1380)),
        ("endMinute", json!(1440)),
    ]))
    .expect("weekly slot ending at midnight should validate");
    assert_eq!(values.title, "Gym");
    assert_eq!(values.weekday, Some(1));
    assert_eq!(values.slot_date, None);
    assert_eq!(values.end_minute, 1440);

    // One-off slot needs a well-formed date.
    let values = gym_slot_values(&gym_input(&[
        ("title", json!("  Push day  ")),
        ("recurrence", json!("once")),
        ("slotDate", json!("2026-09-01")),
        ("startMinute", json!(1020)),
        ("endMinute", json!(1110)),
    ]))
    .expect("one-off slot should validate");
    assert_eq!(values.title, "Push day");
    assert_eq!(values.slot_date.as_deref(), Some("2026-09-01"));
    assert_eq!(values.weekday, None);

    // Rejections differ only by shape; loop over owned rows with an intent string.
    for (intent, input) in [
        (
            "overnight (start >= end) is rejected",
            gym_input(&[
                ("recurrence", json!("weekly")),
                ("weekday", json!(2)),
                ("startMinute", json!(1320)),
                ("endMinute", json!(120)),
            ]),
        ),
        (
            "weekday outside ISO 1-7 is rejected",
            gym_input(&[
                ("recurrence", json!("weekly")),
                ("weekday", json!(0)),
                ("startMinute", json!(600)),
                ("endMinute", json!(660)),
            ]),
        ),
        (
            "a one-off slot without a date is rejected",
            gym_input(&[
                ("recurrence", json!("once")),
                ("startMinute", json!(600)),
                ("endMinute", json!(660)),
            ]),
        ),
        (
            "a one-off slot with a special date is rejected",
            gym_input(&[
                ("recurrence", json!("once")),
                ("slotDate", json!("today")),
                ("startMinute", json!(600)),
                ("endMinute", json!(660)),
            ]),
        ),
        (
            "unknown recurrence is rejected",
            gym_input(&[
                ("recurrence", json!("biweekly")),
                ("weekday", json!(3)),
                ("startMinute", json!(600)),
                ("endMinute", json!(660)),
            ]),
        ),
    ] {
        assert!(gym_slot_values(&input).is_err(), "{intent}");
    }
}

#[test]
fn gym_friend_codes_use_the_unambiguous_alphabet() {
    for _ in 0..50 {
        let code = generate_gym_friend_code();
        assert_eq!(code.len(), GYM_FRIEND_CODE_LENGTH);
        for character in code.bytes() {
            assert!(
                GYM_FRIEND_CODE_ALPHABET.contains(&character),
                "unexpected friend-code character {character:?}"
            );
        }
    }
}

#[test]
fn gym_invite_identifiers_classify_and_normalize() {
    // '@' anywhere → email, lowercased.
    match classify_gym_invite_identifier("  BOB@Example.com ").unwrap() {
        GymInviteIdentifier::Email(email) => assert_eq!(email, "bob@example.com"),
        GymInviteIdentifier::FriendCode(_) => panic!("expected email"),
    }
    // No '@' → friend code, uppercased with separators stripped so all three spellings resolve identically.
    for raw in ["ab23-cd45", "AB23 CD45", "ab23cd45"] {
        match classify_gym_invite_identifier(raw).unwrap() {
            GymInviteIdentifier::FriendCode(code) => assert_eq!(code, "AB23CD45"),
            GymInviteIdentifier::Email(_) => panic!("expected friend code for {raw:?}"),
        }
    }
    // Empty and separator-only inputs are rejected.
    assert!(classify_gym_invite_identifier("   ").is_err());
    assert!(classify_gym_invite_identifier("---").is_err());
}

#[test]
fn gym_status_vocabulary_is_closed() {
    for status in ["going", "maybe", "skipped", "done"] {
        assert!(ensure_gym_status(status).is_ok());
    }
    for status in ["", "planned", "eaten", "Going", "skipping"] {
        assert!(
            ensure_gym_status(status).is_err(),
            "expected {status:?} to be rejected"
        );
    }
}

#[test]
fn gym_merge_overlaps_merges_per_style_and_classifies_tentative() {
    let buddy = "11111111-1111-4111-8111-111111111111";
    let other = "22222222-2222-4222-8222-222222222222";
    let rows = vec![
        // Two touching confirmed windows for the same buddy merge into one.
        json!({ "buddyId": buddy, "buddyName": "Alex", "startMinute": 600, "endMinute": 660, "tentative": false }),
        json!({ "buddyId": buddy, "buddyName": "Alex", "startMinute": 630, "endMinute": 700, "tentative": false }),
        // A tentative window never merges into a confirmed one.
        json!({ "buddyId": buddy, "buddyName": "Alex", "startMinute": 650, "endMinute": 720, "tentative": true }),
        // A buddy with only tentative windows is tentative overall.
        json!({ "buddyId": other, "buddyName": "Sam", "startMinute": 800, "endMinute": 860, "tentative": true }),
    ];
    let merged = gym_merge_overlaps(&rows);
    let entries = merged.as_array().expect("merged overlaps are an array");
    assert_eq!(entries.len(), 2);

    let alex = &entries[0];
    assert_eq!(alex["buddy"]["name"], json!("Alex"));
    assert_eq!(alex["tentative"], json!(false));
    let windows = alex["windows"].as_array().unwrap();
    assert_eq!(windows.len(), 2);
    assert_eq!(windows[0]["startMinute"], json!(600));
    assert_eq!(windows[0]["endMinute"], json!(700));
    assert_eq!(windows[0]["tentative"], json!(false));
    assert_eq!(windows[1]["tentative"], json!(true));

    let sam = &entries[1];
    assert_eq!(sam["tentative"], json!(true));

    assert_eq!(gym_merge_overlaps(&[]), json!([]));
}

#[test]
fn gym_merge_overlaps_caps_windows_and_buddies_keeping_the_earliest() {
    // 22 buddies (cap 20) with 4 non-mergeable windows each (cap 3); rows arrive ordered by start.
    let buddy_id = |index: usize| format!("00000000-0000-4000-8000-{index:012}");
    let mut rows = Vec::new();
    for index in 0..22 {
        for window in 0..4 {
            let start = (index + window * 1000) as i64;
            rows.push(json!({
                "buddyId": buddy_id(index),
                "buddyName": format!("Buddy {index}"),
                "startMinute": start,
                "endMinute": start + 5,
                "tentative": false,
            }));
        }
    }

    let merged = gym_merge_overlaps(&rows);
    let entries = merged.as_array().expect("merged overlaps are an array");
    assert_eq!(
        entries.len(),
        20,
        "buddy cap not enforced: expected 20 buddies, got {}",
        entries.len()
    );

    for (index, entry) in entries.iter().enumerate() {
        assert_eq!(
            entry["buddy"]["id"],
            json!(buddy_id(index)),
            "buddies not retained in earliest-window order at position {index}"
        );
        let windows = entry["windows"].as_array().unwrap();
        assert_eq!(
            windows.len(),
            3,
            "per-buddy window cap not enforced for buddy {index}: got {}",
            windows.len()
        );
        for (slot, window) in windows.iter().enumerate() {
            assert_eq!(
                window["startMinute"],
                json!((index + slot * 1000) as i64),
                "window {slot} of buddy {index} is not the {slot}-th earliest window"
            );
        }
    }

    let retained_ids: Vec<&Value> = entries.iter().map(|entry| &entry["buddy"]["id"]).collect();
    for dropped in [20usize, 21] {
        assert!(
            !retained_ids.contains(&&json!(buddy_id(dropped))),
            "late buddy {dropped} should have been dropped by the buddy cap"
        );
    }
}
