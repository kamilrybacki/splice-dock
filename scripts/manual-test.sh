#!/usr/bin/env bash
# =============================================================================
# splicedock manual smoke tests
# =============================================================================
# Usage:
#   ./scripts/manual-test.sh                         # against already-running server
#   ADMIN_TOKEN=mysecret ./scripts/manual-test.sh    # custom token
#   BASE_URL=http://10.0.0.5:8789 ./scripts/manual-test.sh
#
# Prerequisites: curl, jq
# Start the server first (npm run dev)
# =============================================================================

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8789}"
MCP_URL="${MCP_URL:-http://localhost:8788}"
ADMIN_TOKEN="${ADMIN_TOKEN:-dev-secret}"

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

PASS=0; FAIL=0

pass() { echo -e "${GREEN}  ✓ $1${RESET}"; ((PASS++)) || true; }
fail() { echo -e "${RED}  ✗ $1${RESET}"; ((FAIL++)) || true; }
section() { echo -e "\n${BOLD}${CYAN}── $1 ──────────────────────────────────${RESET}"; }
info()    { echo -e "${YELLOW}  → $1${RESET}"; }

# Helpers
auth() { echo "Authorization: Bearer ${ADMIN_TOKEN}"; }

# assert_status <expected> <actual> <label>
assert_status() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label (HTTP $actual)"
  else
    fail "$label — expected HTTP $expected, got HTTP $actual"
  fi
}

# curl wrapper: stores body in $BODY, status in $STATUS
req() {
  local method="$1"; shift
  local url="$1"; shift
  local extra_args=("$@")
  RESPONSE=$(curl -s -w "\n%{http_code}" -X "$method" "$url" "${extra_args[@]}" 2>&1)
  STATUS=$(echo "$RESPONSE" | tail -1)
  BODY=$(echo "$RESPONSE" | head -n -1)
}

# =============================================================================
# 1. HEALTH  (unauthenticated)
# =============================================================================
section "1. Health endpoint (no auth)"

req GET "${BASE_URL}/api/v1/health"
assert_status 200 "$STATUS" "GET /api/v1/health"
if echo "$BODY" | jq -e '.data.status == "ok"' > /dev/null 2>&1; then
  pass "body contains {data:{status:'ok'}}"
else
  fail "unexpected health body: $BODY"
fi

info "health without auth header (must still be 200)"
req GET "${BASE_URL}/api/v1/health" -H "Authorization: Bearer wrong-token"
assert_status 200 "$STATUS" "GET /api/v1/health ignores auth header"

# =============================================================================
# 2. AUTH enforcement
# =============================================================================
section "2. Authentication enforcement"

req GET "${BASE_URL}/api/v1/tools"
assert_status 401 "$STATUS" "GET /api/v1/tools without token → 401"

req GET "${BASE_URL}/api/v1/tools" -H "Authorization: Bearer wrong-token"
assert_status 401 "$STATUS" "GET /api/v1/tools with wrong token → 401"

req GET "${BASE_URL}/api/v1/tools" -H "Authorization: $(auth)"
assert_status 200 "$STATUS" "GET /api/v1/tools with correct token → 200"

# =============================================================================
# 3. STATUS
# =============================================================================
section "3. Status"

req GET "${BASE_URL}/api/v1/status" -H "$(auth)"
assert_status 200 "$STATUS" "GET /api/v1/status"
if echo "$BODY" | jq -e '.data.tool_count >= 0' > /dev/null 2>&1; then
  TOOL_COUNT=$(echo "$BODY" | jq '.data.tool_count')
  pass "status reports tool_count=$TOOL_COUNT"
else
  fail "unexpected status body: $BODY"
fi

# =============================================================================
# 4. TOOLS — list, pagination, YAML export
# =============================================================================
section "4. Tools — list"

req GET "${BASE_URL}/api/v1/tools" -H "$(auth)"
assert_status 200 "$STATUS" "GET /api/v1/tools"
echo "$BODY" | jq -e '.data | type == "array"' > /dev/null 2>&1 && pass "response has data array" || fail "no data array"
echo "$BODY" | jq -e '.meta.total >= 0' > /dev/null 2>&1 && pass "response has meta.total" || fail "no meta.total"

info "Pagination validation"
req GET "${BASE_URL}/api/v1/tools?page=0" -H "$(auth)"
assert_status 400 "$STATUS" "page=0 → 400"

req GET "${BASE_URL}/api/v1/tools?per_page=0" -H "$(auth)"
assert_status 400 "$STATUS" "per_page=0 → 400"

req GET "${BASE_URL}/api/v1/tools?per_page=999999" -H "$(auth)"
assert_status 200 "$STATUS" "per_page=999999 clamped (no DoS)"
CAP=$(echo "$BODY" | jq '.meta.per_page')
if [[ "$CAP" -le 100 ]]; then pass "per_page capped at $CAP ≤ 100"; else fail "per_page not capped: $CAP"; fi

info "YAML format"
req GET "${BASE_URL}/api/v1/tools?format=yaml" -H "$(auth)"
assert_status 200 "$STATUS" "GET /api/v1/tools?format=yaml"
if [[ "$BODY" == *"tools:"* ]]; then pass "YAML body contains 'tools:' key"; else fail "YAML body unexpected: $BODY"; fi

# =============================================================================
# 5. TOOLS — create / get / update / delete (runtime lifecycle)
# =============================================================================
section "5. Tools — runtime lifecycle"

TOOL_PAYLOAD='{
  "type": "http",
  "name": "test_echo",
  "namespace": "smoke",
  "description": "Smoke test echo tool",
  "method": "GET",
  "url": "https://httpbin.org/get",
  "params": [],
  "auth": {"type": "none"}
}'

info "Create tool"
req POST "${BASE_URL}/api/v1/tools" \
  -H "$(auth)" -H "Content-Type: application/json" \
  -d "$TOOL_PAYLOAD"
assert_status 201 "$STATUS" "POST /api/v1/tools → 201"
TOOL_ID=$(echo "$BODY" | jq -r '.data.id')
pass "created tool id: $TOOL_ID"

info "Duplicate create → 409"
req POST "${BASE_URL}/api/v1/tools" \
  -H "$(auth)" -H "Content-Type: application/json" \
  -d "$TOOL_PAYLOAD"
assert_status 409 "$STATUS" "duplicate POST → 409 conflict"

info "Get by id"
req GET "${BASE_URL}/api/v1/tools/${TOOL_ID}" -H "$(auth)"
assert_status 200 "$STATUS" "GET /api/v1/tools/${TOOL_ID}"
if echo "$BODY" | jq -e ".data.id == \"${TOOL_ID}\"" > /dev/null 2>&1; then
  pass "GET by id returns correct tool"
else
  fail "GET by id body: $BODY"
fi

info "Get single as YAML"
req GET "${BASE_URL}/api/v1/tools/${TOOL_ID}?format=yaml" -H "$(auth)"
assert_status 200 "$STATUS" "GET /api/v1/tools/${TOOL_ID}?format=yaml"

info "Update tool (PUT)"
UPDATE_PAYLOAD='{
  "type": "http",
  "name": "test_echo",
  "namespace": "smoke",
  "description": "Updated description",
  "method": "GET",
  "url": "https://httpbin.org/get",
  "params": [],
  "auth": {"type": "none"}
}'
req PUT "${BASE_URL}/api/v1/tools/${TOOL_ID}" \
  -H "$(auth)" -H "Content-Type: application/json" \
  -d "$UPDATE_PAYLOAD"
assert_status 200 "$STATUS" "PUT /api/v1/tools/${TOOL_ID} → 200"
if echo "$BODY" | jq -e '.data.config.description == "Updated description"' > /dev/null 2>&1; then
  pass "PUT updated description"
else
  fail "PUT response: $BODY"
fi

info "Invalid tool payload → 422"
req POST "${BASE_URL}/api/v1/tools" \
  -H "$(auth)" -H "Content-Type: application/json" \
  -d '{"type":"http","name":""}'
assert_status 422 "$STATUS" "invalid tool payload → 422"

info "mcp_proxy via API → 400"
req POST "${BASE_URL}/api/v1/tools" \
  -H "$(auth)" -H "Content-Type: application/json" \
  -d '{"type":"mcp_proxy","name":"bad","upstream":"http://x"}'
assert_status 400 "$STATUS" "mcp_proxy via API → 400"

info "Delete tool"
req DELETE "${BASE_URL}/api/v1/tools/${TOOL_ID}" -H "$(auth)"
assert_status 204 "$STATUS" "DELETE /api/v1/tools/${TOOL_ID} → 204"

info "Get deleted tool → 404"
req GET "${BASE_URL}/api/v1/tools/${TOOL_ID}" -H "$(auth)"
assert_status 404 "$STATUS" "GET deleted tool → 404"

info "Delete already-deleted → 404"
req DELETE "${BASE_URL}/api/v1/tools/${TOOL_ID}" -H "$(auth)"
assert_status 404 "$STATUS" "re-delete → 404"

# =============================================================================
# 6. PROFILES — list, YAML, lifecycle
# =============================================================================
section "6. Profiles — runtime lifecycle"

req GET "${BASE_URL}/api/v1/profiles" -H "$(auth)"
assert_status 200 "$STATUS" "GET /api/v1/profiles"

req GET "${BASE_URL}/api/v1/profiles?format=yaml" -H "$(auth)"
assert_status 200 "$STATUS" "GET /api/v1/profiles?format=yaml"
[[ "$BODY" == *"profiles:"* ]] && pass "YAML has 'profiles:' key" || fail "YAML body: $BODY"

info "Create profile"
req POST "${BASE_URL}/api/v1/profiles" \
  -H "$(auth)" -H "Content-Type: application/json" \
  -d '{"name":"smoke-profile","tools":["smoke__*"]}'
assert_status 201 "$STATUS" "POST /api/v1/profiles → 201"

info "Get profile"
req GET "${BASE_URL}/api/v1/profiles/smoke-profile" -H "$(auth)"
assert_status 200 "$STATUS" "GET /api/v1/profiles/smoke-profile"
echo "$BODY" | jq -e '.data.name == "smoke-profile"' > /dev/null 2>&1 && pass "profile name correct" || fail "$BODY"
echo "$BODY" | jq -e '.data.resolved_tools | type == "array"' > /dev/null 2>&1 && pass "resolved_tools present" || fail "$BODY"

info "Invalid profile name → 422"
req POST "${BASE_URL}/api/v1/profiles" \
  -H "$(auth)" -H "Content-Type: application/json" \
  -d '{"name":"bad name with spaces","tools":[]}'
assert_status 422 "$STATUS" "invalid profile name → 422"

info "Missing name → 400"
req POST "${BASE_URL}/api/v1/profiles" \
  -H "$(auth)" -H "Content-Type: application/json" \
  -d '{"tools":[]}'
assert_status 400 "$STATUS" "missing name → 400"

info "Get non-existent profile → 404"
req GET "${BASE_URL}/api/v1/profiles/does-not-exist" -H "$(auth)"
assert_status 404 "$STATUS" "missing profile → 404"

info "Delete profile"
req DELETE "${BASE_URL}/api/v1/profiles/smoke-profile" -H "$(auth)"
assert_status 204 "$STATUS" "DELETE /api/v1/profiles/smoke-profile → 204"

info "Re-delete → 404"
req DELETE "${BASE_URL}/api/v1/profiles/smoke-profile" -H "$(auth)"
assert_status 404 "$STATUS" "re-delete profile → 404"

# =============================================================================
# 7. MANIFEST
# =============================================================================
section "7. Manifest export"

req GET "${BASE_URL}/api/v1/manifest" -H "$(auth)"
assert_status 200 "$STATUS" "GET /api/v1/manifest"
[[ "$BODY" == *"server:"* ]] && pass "manifest YAML has 'server:' key" || fail "manifest body: $BODY"
[[ "$BODY" == *"tools:"* ]]   && pass "manifest YAML has 'tools:' key"   || fail "manifest has no tools:"
[[ "$BODY" == *"profiles:"* ]] && pass "manifest YAML has 'profiles:' key" || fail "manifest has no profiles:"

# =============================================================================
# 8. MCP SSE endpoint — reachability
# =============================================================================
section "8. MCP SSE endpoint (reachability)"

info "Checking MCP SSE server at ${MCP_URL}"
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time 3 \
  -H "Accept: text/event-stream" \
  "${MCP_URL}/sse?profile=default" || echo "000")

if [[ "$HTTP_STATUS" == "200" ]]; then
  pass "GET ${MCP_URL}/sse?profile=default → 200 (SSE stream opened)"
elif [[ "$HTTP_STATUS" == "000" ]]; then
  fail "MCP SSE server not reachable at ${MCP_URL} (connection refused or timeout)"
else
  fail "GET /sse → unexpected HTTP $HTTP_STATUS"
fi

info "Session cap — /messages with invalid sessionId → 400"
req POST "${MCP_URL}/messages?sessionId=not-a-uuid" \
  -H "Content-Type: application/json" -d '{}'
assert_status 400 "$STATUS" "invalid sessionId → 400"

# =============================================================================
# 9. Unknown routes
# =============================================================================
section "9. Unknown routes"

req GET "${BASE_URL}/api/v1/nonexistent" -H "$(auth)"
assert_status 404 "$STATUS" "unknown route → 404"

# =============================================================================
# Summary
# =============================================================================
echo ""
echo -e "${BOLD}══════════════════════════════════════════${RESET}"
TOTAL=$((PASS + FAIL))
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}  ALL $TOTAL TESTS PASSED${RESET}"
else
  echo -e "${RED}${BOLD}  $FAIL / $TOTAL TESTS FAILED${RESET}"
fi
echo -e "${BOLD}══════════════════════════════════════════${RESET}"
echo ""

[[ $FAIL -eq 0 ]]
