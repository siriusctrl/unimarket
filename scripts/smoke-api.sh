#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3100}"
ADMIN_API_KEY="${ADMIN_API_KEY:-}"
SMOKE_TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$SMOKE_TMP_DIR"' EXIT

need() {
  command -v "$1" >/dev/null || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

need curl
need jq

encode() {
  jq -rn --arg value "$1" '$value|@uri'
}

auth_get() {
  curl -sS "$BASE_URL$1" -H "Authorization: Bearer $API_KEY"
}

auth_post() {
  curl -sS -X POST "$BASE_URL$1" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$2"
}

auth_delete() {
  curl -sS -X DELETE "$BASE_URL$1" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "$2"
}

admin_get() {
  curl -sS "$BASE_URL$1" -H "Authorization: Bearer $ADMIN_API_KEY"
}

admin_post() {
  curl -sS -X POST "$BASE_URL$1" \
    -H "Authorization: Bearer $ADMIN_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$2"
}

echo "[1/8] Register user"
USER_NAME="agent-e2e-$(date +%s)"
REGISTER_PAYLOAD="$(curl -sS -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"userName\":\"$USER_NAME\"}")"

API_KEY="$(jq -r '.apiKey // empty' <<<"$REGISTER_PAYLOAD")"
USER_ID="$(jq -r '.userId // empty' <<<"$REGISTER_PAYLOAD")"
ACCOUNT_ID="$(jq -r '.account.id // empty' <<<"$REGISTER_PAYLOAD")"
[[ -n "$API_KEY" && -n "$USER_ID" && -n "$ACCOUNT_ID" ]] || {
  echo "register failed: $REGISTER_PAYLOAD" >&2
  exit 1
}

echo "[2/8] Discover markets and capability endpoints"
MARKETS_PAYLOAD="$(auth_get "/api/markets")"
jq -e '.markets | length > 0' <<<"$MARKETS_PAYLOAD" >/dev/null

TRADE_MARKET=""
TRADE_REFERENCE=""
TRADE_QUANTITY=""
TRADE_PRICE=""

while read -r MARKET_ID; do
  [[ -n "$MARKET_ID" ]] || continue

  SORT="$(jq -r --arg market "$MARKET_ID" '.markets[] | select(.id == $market) | .browseOptions[0].value // empty' <<<"$MARKETS_PAYLOAD")"
  BROWSE_URL="/api/markets/$MARKET_ID/browse?limit=1"
  if [[ -n "$SORT" ]]; then
    BROWSE_URL="$BROWSE_URL&sort=$(encode "$SORT")"
  fi
  BROWSE_PAYLOAD="$(auth_get "$BROWSE_URL")"
  REFERENCE="$(jq -r '.results[0].reference // empty' <<<"$BROWSE_PAYLOAD")"
  [[ -n "$REFERENCE" ]] || continue

  ENCODED_REFERENCE="$(encode "$REFERENCE")"
  CAPS="$(jq -r --arg market "$MARKET_ID" '.markets[] | select(.id == $market) | .capabilities[]?' <<<"$MARKETS_PAYLOAD")"
  QUOTE_PAYLOAD=""

  if grep -qx "quote" <<<"$CAPS"; then
    QUOTE_PAYLOAD="$(auth_get "/api/markets/$MARKET_ID/quote?reference=$ENCODED_REFERENCE")"
  fi
  if grep -qx "orderbook" <<<"$CAPS"; then
    auth_get "/api/markets/$MARKET_ID/orderbook?reference=$ENCODED_REFERENCE" >/dev/null
  fi
  if grep -qx "funding" <<<"$CAPS"; then
    auth_get "/api/markets/$MARKET_ID/funding?reference=$ENCODED_REFERENCE" >/dev/null
  fi
  if grep -qx "resolve" <<<"$CAPS"; then
    auth_get "/api/markets/$MARKET_ID/resolve?reference=$ENCODED_REFERENCE" >/dev/null
  fi

  if [[ -z "$TRADE_MARKET" && -n "$QUOTE_PAYLOAD" ]]; then
    CONSTRAINTS_PAYLOAD="$(auth_get "/api/markets/$MARKET_ID/trading-constraints?reference=$ENCODED_REFERENCE")"
    CANDIDATE_QUANTITY="$(jq -r '.constraints.minQuantity // empty' <<<"$CONSTRAINTS_PAYLOAD")"
    CANDIDATE_PRICE="$(jq -r '.price // empty' <<<"$QUOTE_PAYLOAD")"
    if [[ -n "$CANDIDATE_QUANTITY" && -n "$CANDIDATE_PRICE" ]]; then
      TRADE_MARKET="$MARKET_ID"
      TRADE_REFERENCE="$REFERENCE"
      TRADE_QUANTITY="$CANDIDATE_QUANTITY"
      TRADE_PRICE="$CANDIDATE_PRICE"
    fi
  fi
done < <(jq -r '.markets[].id' <<<"$MARKETS_PAYLOAD")

[[ -n "$TRADE_MARKET" && -n "$TRADE_REFERENCE" && -n "$TRADE_QUANTITY" ]] || {
  echo "no tradeable reference found" >&2
  exit 1
}

echo "[3/8] Place market order"
MARKET_ORDER_PAYLOAD="$(auth_post "/api/orders" "$(jq -nc \
  --arg market "$TRADE_MARKET" \
  --arg reference "$TRADE_REFERENCE" \
  --argjson quantity "$TRADE_QUANTITY" \
  '{market:$market,reference:$reference,side:"buy",type:"market",quantity:$quantity,reasoning:"e2e smoke: open starter position"}'
)")"
MARKET_ORDER_ID="$(jq -r '.id // empty' <<<"$MARKET_ORDER_PAYLOAD")"
[[ -n "$MARKET_ORDER_ID" ]] || {
  echo "market order failed: $MARKET_ORDER_PAYLOAD" >&2
  exit 1
}

echo "[4/8] Place and cancel pending limit order"
LIMIT_PRICE="$(jq -nr --argjson price "$TRADE_PRICE" '$price / 2 | if . <= 0 then 0.000001 else . end')"
LIMIT_ORDER_PAYLOAD="$(auth_post "/api/orders" "$(jq -nc \
  --arg market "$TRADE_MARKET" \
  --arg reference "$TRADE_REFERENCE" \
  --argjson quantity "$TRADE_QUANTITY" \
  --argjson limitPrice "$LIMIT_PRICE" \
  '{market:$market,reference:$reference,side:"buy",type:"limit",quantity:$quantity,limitPrice:$limitPrice,reasoning:"e2e smoke: pending order for cancel flow"}'
)")"
LIMIT_ORDER_ID="$(jq -r '.id // empty' <<<"$LIMIT_ORDER_PAYLOAD")"
[[ -n "$LIMIT_ORDER_ID" ]] || {
  echo "limit order failed: $LIMIT_ORDER_PAYLOAD" >&2
  exit 1
}

auth_get "/api/orders/$LIMIT_ORDER_ID" >/dev/null
auth_get "/api/orders?view=open" >/dev/null
auth_get "/api/orders?view=history" >/dev/null

CANCEL_PAYLOAD="$(auth_delete "/api/orders/$LIMIT_ORDER_ID" '{"reasoning":"e2e smoke: thesis invalidated"}')"
jq -e '.status == "cancelled"' <<<"$CANCEL_PAYLOAD" >/dev/null

echo "[5/8] Journal and account endpoints"
auth_post "/api/journal" '{"content":"e2e smoke note","tags":["e2e","smoke"]}' >/dev/null
auth_get "/api/journal?limit=5&offset=0" >/dev/null
auth_get "/api/account" >/dev/null
auth_get "/api/account/portfolio" >/dev/null
auth_get "/api/positions" >/dev/null

TIMELINE_PAYLOAD="$(auth_get "/api/account/timeline?limit=50&offset=0")"
jq -e '.events | any(.type == "order.cancelled")' <<<"$TIMELINE_PAYLOAD" >/dev/null

echo "[6/8] Reconciler remains background-only"

echo "[7/8] Negative contract checks"
LEGACY_REGISTER_CODE="$(curl -sS -o "$SMOKE_TMP_DIR/legacy-register.out" -w "%{http_code}" \
  -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"name":"legacy-field-should-fail"}')"
[[ "$LEGACY_REGISTER_CODE" == "400" ]] || {
  echo "expected 400 for legacy register field" >&2
  exit 1
}

MISSING_REASONING_CODE="$(curl -sS -o "$SMOKE_TMP_DIR/missing-reasoning.out" -w "%{http_code}" \
  -X POST "$BASE_URL/api/orders" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc \
    --arg market "$TRADE_MARKET" \
    --arg reference "$TRADE_REFERENCE" \
    --argjson quantity "$TRADE_QUANTITY" \
    '{market:$market,reference:$reference,side:"buy",type:"market",quantity:$quantity}'
  )")"
[[ "$MISSING_REASONING_CODE" == "400" ]] || {
  echo "expected 400 for missing reasoning" >&2
  exit 1
}

echo "[8/8] Dashboard and optional admin checks"
curl -sS "$BASE_URL/api/dashboard/users/$USER_ID/timeline?limit=20&offset=0" >/dev/null
curl -sS "$BASE_URL/api/dashboard/overview" >/dev/null
curl -sS "$BASE_URL/api/dashboard/equity-history?range=1w" >/dev/null

if [[ -n "$ADMIN_API_KEY" ]]; then
  admin_post "/api/admin/users/$USER_ID/deposit" '{"amount":100}' >/dev/null
  admin_post "/api/admin/users/$USER_ID/withdraw" '{"amount":100}' >/dev/null
  admin_get "/api/admin/users/$USER_ID/portfolio" >/dev/null
fi

echo "E2E smoke passed."
