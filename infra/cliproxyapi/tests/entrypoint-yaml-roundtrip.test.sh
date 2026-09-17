#!/bin/bash
# Regression tests for OPS-07 YAML scalar escaping (isolated, dummy secrets only).
# Run: bash infra/cliproxyapi/tests/entrypoint-yaml-roundtrip.test.sh
# Never uses real secrets or starts the real proxy (CLIPROXY_SKIP_EXEC=1).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
ENTRYPOINT="$REPO_ROOT/infra/cliproxyapi/entrypoint.sh"

pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok - $1"; }
bad() { fail=$((fail + 1)); echo "NOT OK - $1"; }

# $1=config_path $2=expected_auth_dir $3=expected_api_key $4=expected_mgmt_key $5=expected_port
assert_yaml_roundtrip() {
  local cfg="$1" want_auth="$2" want_api="$3" want_mgmt="$4" want_port="$5"
  CFG_PATH="$cfg" WANT_AUTH="$want_auth" WANT_API="$want_api" WANT_MGMT="$want_mgmt" WANT_PORT="$want_port" \
  python3 - <<'PY'
import os, sys
import yaml
cfg = os.environ["CFG_PATH"]
with open(cfg, encoding="utf-8") as f:
    doc = yaml.safe_load(f)
errors = []
if doc.get("auth-dir") != os.environ["WANT_AUTH"]:
    errors.append(f'auth-dir mismatch: {doc.get("auth-dir")!r}')
keys = doc.get("api-keys") or []
if not keys or keys[0] != os.environ["WANT_API"]:
    errors.append(f'api-keys[0] mismatch: {keys!r}')
mgmt = (doc.get("remote-management") or {}).get("secret-key")
if mgmt != os.environ["WANT_MGMT"]:
    errors.append(f'secret-key mismatch: {mgmt!r}')
if str(doc.get("port")) != os.environ["WANT_PORT"]:
    errors.append(f'port mismatch: {doc.get("port")!r}')
if errors:
    print("; ".join(errors))
    sys.exit(1)
PY
}

run_entrypoint() {
  # $1=workdir (holds config + logs); remaining env set by caller.
  local workdir="$1"
  CLIPROXY_CONFIG_PATH="$workdir/config.yaml" \
  CLIPROXY_SKIP_EXEC=1 \
  sh "$ENTRYPOINT" >"$workdir/stdout.log" 2>"$workdir/stderr.log"
}

# --- T1: ordinary keys round-trip -----------------------------------------
t1="$(mktemp -d)"
t1_auth="$t1/auths"
# Dummy round-trip fixtures only, never real credentials.
t1_api_key="abc123-XYZ-ordinary" # gitleaks:allow -- dummy test value
t1_mgmt_key="mgmt-ordinary-456" # gitleaks:allow -- dummy test value
if AI_GATEWAY_API_KEY="$t1_api_key" \
   CLIPROXY_MANAGEMENT_KEY="$t1_mgmt_key" \
   CLIPROXY_AUTH_DIR="$t1_auth" PORT="8317" \
   run_entrypoint "$t1"; then
  if assert_yaml_roundtrip "$t1/config.yaml" "$t1_auth" "$t1_api_key" "$t1_mgmt_key" "8317"; then
    ok "T1 ordinary keys round-trip"
  else
    bad "T1 ordinary keys did not round-trip"
  fi
else
  bad "T1 entrypoint exited non-zero"
fi
rm -rf "$t1"

# --- T2: quotes and backslashes round-trip ---------------------------------
t2="$(mktemp -d)"
t2_auth="$t2/auths"
t2_api='a"b\c-dummy'
t2_mgmt='x\y"z-dummy'
if AI_GATEWAY_API_KEY="$t2_api" \
   CLIPROXY_MANAGEMENT_KEY="$t2_mgmt" \
   CLIPROXY_AUTH_DIR="$t2_auth" PORT="8317" \
   run_entrypoint "$t2"; then
  if assert_yaml_roundtrip "$t2/config.yaml" "$t2_auth" "$t2_api" "$t2_mgmt" "8317"; then
    ok "T2 quotes/backslashes round-trip"
  else
    bad "T2 quotes/backslashes did not round-trip (see $t2/config.yaml)"
    cat "$t2/config.yaml" || true
  fi
else
  bad "T2 entrypoint exited non-zero for quotes/backslashes"
fi
rm -rf "$t2"

# --- T3: combined tricky scalars + spaced path ------------------------------
t3="$(mktemp -d)"
t3_auth="$t3/auth dir"
t3_api='q"u\o"t\e-dummy'
t3_mgmt="single'quote-dummy"
if AI_GATEWAY_API_KEY="$t3_api" \
   CLIPROXY_MANAGEMENT_KEY="$t3_mgmt" \
   CLIPROXY_AUTH_DIR="$t3_auth" PORT="8320" \
   run_entrypoint "$t3"; then
  if assert_yaml_roundtrip "$t3/config.yaml" "$t3_auth" "$t3_api" "$t3_mgmt" "8320"; then
    ok "T3 combined scalars and spaced auth-dir round-trip"
  else
    bad "T3 combined scalars did not round-trip"
  fi
else
  bad "T3 entrypoint exited non-zero"
fi
rm -rf "$t3"

# --- T4: newline value is rejected without printing the secret --------------
t4="$(mktemp -d)"
t4_auth="$t4/auths"
t4_marker="DUMMY_MARKER_T4_9f8e7d6c"
t4_bad="before-${t4_marker}-after
second-line"
set +e
AI_GATEWAY_API_KEY="$t4_bad" \
CLIPROXY_MANAGEMENT_KEY="mgmt-ok-dummy" \
CLIPROXY_AUTH_DIR="$t4_auth" PORT="8317" \
run_entrypoint "$t4"
t4_code=$?
set -e
if [ "$t4_code" -eq 0 ]; then
  bad "T4 newline secret was accepted (must be rejected)"
else
  ok "T4 newline secret is rejected"
fi
if grep -q "$t4_marker" "$t4/stdout.log" 2>/dev/null || grep -q "$t4_marker" "$t4/stderr.log" 2>/dev/null; then
  bad "T4 rejection printed the secret value"
else
  ok "T4 rejection prints no secret"
fi
rm -rf "$t4"

# --- T5: non-numeric PORT is rejected ----------------------------------------
t5="$(mktemp -d)"
set +e
AI_GATEWAY_API_KEY="dummy-ok" \
CLIPROXY_MANAGEMENT_KEY="dummy-ok-2" \
CLIPROXY_AUTH_DIR="$t5/auths" PORT="notaport" \
run_entrypoint "$t5"
t5_code=$?
set -e
if [ "$t5_code" -eq 0 ]; then
  bad "T5 invalid PORT was accepted"
else
  ok "T5 invalid PORT is rejected"
fi
rm -rf "$t5"

echo "---"
echo "pass=$pass fail=$fail"
if [ "$fail" -ne 0 ]; then
  exit 1
fi
