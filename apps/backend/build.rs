//! Detects, at build time, whether a PostgreSQL test database is configured.
//!
//! The integration tests in `src/db.rs` need a live PostgreSQL. Before TEST-01
//! they returned early with an `eprintln!` when `TEST_DATABASE_URL` /
//! `DATABASE_URL` were unset, which made 21 tests report as **passed** with
//! zero assertions executed — a green suite that meant nothing.
//!
//! `#[ignore]` is the right harness state for "not run", but it is static:
//! applying it unconditionally would also skip those tests in CI, which runs a
//! plain `cargo test -p macro-tracker-backend` with `TEST_DATABASE_URL` set at
//! the workflow level. So the attribute is applied conditionally through the
//! `has_test_database` cfg emitted here:
//!
//! * database configured   -> cfg set    -> tests run (CI, and locally with the URL exported)
//! * no database           -> cfg unset  -> tests report as *ignored*, never as passed
//!
//! `rerun-if-env-changed` makes Cargo rebuild when the variable appears or
//! disappears, so exporting the URL and re-running `cargo test` is enough.

fn main() {
    println!("cargo::rerun-if-env-changed=TEST_DATABASE_URL");
    println!("cargo::rerun-if-env-changed=DATABASE_URL");
    println!("cargo::rustc-check-cfg=cfg(has_test_database)");

    let configured = ["TEST_DATABASE_URL", "DATABASE_URL"]
        .iter()
        .any(|name| std::env::var(name).is_ok_and(|value| !value.trim().is_empty()));
    if configured {
        println!("cargo::rustc-cfg=has_test_database");
    }
}
