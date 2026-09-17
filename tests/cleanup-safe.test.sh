#!/bin/bash
# Regression tests for OPS-02 safe cleanup.sh (fake-gh, never touches live repos).
# Run: bash tests/cleanup-safe.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# tests/ is one level below repo root, so root is parent of tests/.
REPO_ROOT="$(cd "${SCRIPT_DIR}" && pwd)"
# When placed at <root>/tests, SCRIPT_DIR above is <root>/tests; fix:
if [ "$(basename "$SCRIPT_DIR")" = "tests" ]; then
  REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
else
  REPO_ROOT="$SCRIPT_DIR"
fi
CLEANUP="$REPO_ROOT/cleanup.sh"

pass=0
fail=0

ok() { pass=$((pass + 1)); echo "ok - $1"; }
bad() { fail=$((fail + 1)); echo "NOT OK - $1"; }

# Build an isolated fake `gh` that records every invocation and serves
# canned read-only answers. Mutating calls only record; they never act.
make_fake_gh() {
  local bin_dir="$1"
  local log_file="$2"
  cat > "$bin_dir/gh" <<'FAKEGH'
#!/bin/bash
log_file="${GH_CALL_LOG:?}"
printf 'gh %s\n' "$*" >> "$log_file"
args="$*"
# Mutating calls: just record success.
case "$args" in
  *"-X PATCH"*|*"-X DELETE"*|*"-X POST"*|*"-X PUT"*|*"rename"*)
    exit 0
    ;;
esac
# Read-only canned answers.
case "$args" in
  *"repo list"*)
    printf 'allowed\nother-repo\n'
    exit 0
    ;;
  *"repos/testuser/allowed"*"compare/main...feature-merged"*)
    printf 'identical\n'
    exit 0
    ;;
  *"repos/testuser/allowed"*"compare/main...feature-unmerged"*)
    printf 'ahead\n'
    exit 0
    ;;
  *"repos/testuser/allowed"*"compare/"*)
    printf 'diverged\n'
    exit 0
    ;;
  *"repos/testuser/allowed/branches"*)
    printf 'main\ndev\nstaging\nfeature-merged\nfeature-unmerged\n'
    exit 0
    ;;
  *"repos/testuser/allowed"*"default_branch"*)
    printf 'main\n'
    exit 0
    ;;
  *"repos/"*"default_branch"*)
    printf 'main\n'
    exit 0
    ;;
  *"repos/"*"/branches"*)
    printf 'main\n'
    exit 0
    ;;
  *"repos/"*"/compare/"*)
    printf 'diverged\n'
    exit 0
    ;;
esac
exit 0
FAKEGH
  chmod +x "$bin_dir/gh"
}

run_with_fake() {
  local log_file="$1"
  shift
  local bin_dir
  bin_dir="$(mktemp -d)"
  make_fake_gh "$bin_dir" "$log_file"
  # shellcheck disable=SC2068
  PATH="$bin_dir:$PATH" GH_CALL_LOG="$log_file" bash "$CLEANUP" $@ >"$log_file.out" 2>"$log_file.err" || return $?
}

# --- Test 1: default invocation performs no mutations --------------------
t1_dir="$(mktemp -d)"
t1_log="$t1_dir/calls.log"
if run_with_fake "$t1_log"; then
  if grep -q -- "-X PATCH" "$t1_log" || grep -q -- "-X DELETE" "$t1_log" || grep -q -- "rename" "$t1_log"; then
    bad "T1 default invocation issued a mutation (see $t1_log)"
  else
    ok "T1 default invocation makes no mutations"
  fi
else
  # cleanup.sh discovery mode exits 0; any failure here is a regression.
  bad "T1 default invocation exited non-zero (see $t1_log.err)"
fi
rm -rf "$t1_dir"

# --- Test 2: dry run with allowlist performs no DELETE -------------------
t2_dir="$(mktemp -d)"
t2_log="$t2_dir/calls.log"
if run_with_fake "$t2_log" --user testuser --repo testuser/allowed; then
  if grep -q -- "-X DELETE" "$t2_log"; then
    bad "T2 dry run issued DELETE (see $t2_log)"
  else
    ok "T2 dry run with --repo makes no DELETE"
  fi
  if grep -q "would delete 'feature-merged'" "$t2_log.out"; then
    ok "T2 dry run reports merged branch as would-delete"
  else
    bad "T2 dry run did not report would-delete for merged branch (see $t2_log.out)"
  fi
  if grep -q "would delete 'feature-unmerged'" "$t2_log.out"; then
    bad "T2 dry run proposed unmerged branch (see $t2_log.out)"
  else
    ok "T2 dry run never proposes unmerged branch"
  fi
else
  bad "T2 dry run exited non-zero (see $t2_log.err)"
fi
rm -rf "$t2_dir"

# --- Test 3: --apply deletes only merged, non-protected branches ---------
t3_dir="$(mktemp -d)"
t3_log="$t3_dir/calls.log"
if run_with_fake "$t3_log" --user testuser --repo testuser/allowed --apply; then
  if grep -q 'refs/heads/feature-merged.*-X DELETE' "$t3_log"; then
    ok "T3 --apply deletes merged branch"
  else
    bad "T3 --apply did not delete merged branch (see $t3_log)"
  fi
  for protected in "/heads/dev" "/heads/staging" "/heads/main" "feature-unmerged"; do
    if grep -q -- "$protected" "$t3_log" | grep -q "DELETE" 2>/dev/null; then
      bad "T3 deleted protected/unmerged branch matching $protected"
    fi
  done
  if grep -q -- "-X DELETE.*heads/dev" "$t3_log" || grep -q -- "-X DELETE.*heads/staging" "$t3_log" || grep -q -- "-X DELETE.*heads/main" "$t3_log" || grep -q -- "heads/feature-unmerged.*-X DELETE" "$t3_log" || grep -q -- "-X DELETE.*heads/feature-unmerged" "$t3_log"; then
    bad "T3 deleted a protected or unmerged branch (see $t3_log)"
  else
    ok "T3 never deletes protected/unmerged branches"
  fi
  if grep -q -- "-X PATCH" "$t3_log" || grep -q -- "rename" "$t3_log"; then
    bad "T3 performed description/rename administration (see $t3_log)"
  else
    ok "T3 performs no description/rename administration"
  fi
else
  bad "T3 --apply exited non-zero (see $t3_log.err)"
fi
rm -rf "$t3_dir"

# --- Test 4: unselected repos are never touched ---------------------------
t4_dir="$(mktemp -d)"
t4_log="$t4_dir/calls.log"
if run_with_fake "$t4_log" --user testuser --repo testuser/allowed --apply; then
  if grep -q "other-repo" "$t4_log"; then
    bad "T4 touched unselected repo other-repo (see $t4_log)"
  else
    ok "T4 never touches unselected repos"
  fi
else
  bad "T4 exited non-zero (see $t4_log.err)"
fi
rm -rf "$t4_dir"

echo "---"
echo "pass=$pass fail=$fail"
if [ "$fail" -ne 0 ]; then
  exit 1
fi
