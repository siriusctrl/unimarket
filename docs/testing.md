# Testing

## Running Tests

```bash
pnpm test       # Run all tests
pnpm coverage   # Coverage with CI-enforced thresholds
```

## Agent Endpoint E2E Method (Black-Box)

This is the agent-side method used to validate the full API surface without reading server code first.

1. Use `skills/unimarket/SKILL.md` as the contract source.
2. Start from `POST /api/auth/register`.
3. Discover markets dynamically via `GET /api/markets` (no hardcoded market IDs).
4. Execute the full trade lifecycle (quote -> place -> list -> cancel -> audit).
5. Validate consistency across `orders`, `timeline`, `portfolio`, and `SSE`.
6. Run negative-path checks (invalid payloads, missing reasoning, unauthorized/removed routes).
7. Only inspect code after reproducing an unexpected behavior.

Coverage targets:
- Auth: register, create/revoke key, unauthorized behavior
- Market data: search/quote/orderbook/funding/resolve for every discovered market capability
- Trading: market order fill, pending limit order, cancel, optional manual reconcile check
- Account data: account, positions, portfolio, timeline, journal
- Realtime: SSE `system.ready` and trading events
- Admin (optional): deposit/withdraw/timeline/overview/equity-history + removed legacy route checks

### One-Command Smoke Playbook

Requirements: `curl`, `jq`, running API at `http://localhost:3100`.

```bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3100}"
ADMIN_API_KEY="${ADMIN_API_KEY:-}" # optional, enables admin checks

need() { command -v "$1" >/dev/null || { echo "missing required command: $1"; exit 1; }; }
need curl
need jq

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
  echo "register failed: $REGISTER_PAYLOAD"
  exit 1
}

echo "[2/8] Discover markets + exercise capability endpoints"
MARKETS_PAYLOAD="$(auth_get "/api/markets")"
jq -e '.markets | length > 0' <<<"$MARKETS_PAYLOAD" >/dev/null

TRADE_MARKET=""
TRADE_SYMBOL=""
while read -r MARKET_ID; do
  [[ -n "$MARKET_ID" ]] || continue

  SEARCH_PAYLOAD="$(auth_get "/api/markets/$MARKET_ID/search?limit=1")"
  SYMBOL="$(jq -r '.results[0].symbol // empty' <<<"$SEARCH_PAYLOAD")"
  [[ -n "$SYMBOL" ]] || continue

  CAPS="$(jq -r --arg m "$MARKET_ID" '.markets[] | select(.id == $m) | .capabilities[]?' <<<"$MARKETS_PAYLOAD")"
  if grep -qx "quote" <<<"$CAPS"; then
    auth_get "/api/markets/$MARKET_ID/quote?symbol=$SYMBOL" >/dev/null
  fi
  if grep -qx "orderbook" <<<"$CAPS"; then
    auth_get "/api/markets/$MARKET_ID/orderbook?symbol=$SYMBOL" >/dev/null
  fi
  if grep -qx "funding" <<<"$CAPS"; then
    auth_get "/api/markets/$MARKET_ID/funding?symbol=$SYMBOL" >/dev/null
  fi
  if grep -qx "resolve" <<<"$CAPS"; then
    auth_get "/api/markets/$MARKET_ID/resolve?symbol=$SYMBOL" >/dev/null
  fi

  if [[ -z "$TRADE_MARKET" ]]; then
    TRADE_MARKET="$MARKET_ID"
    TRADE_SYMBOL="$SYMBOL"
  fi
done < <(jq -r '.markets[].id' <<<"$MARKETS_PAYLOAD")

[[ -n "$TRADE_MARKET" && -n "$TRADE_SYMBOL" ]] || {
  echo "no tradeable symbol found from discovered markets"
  exit 1
}

echo "[3/8] Place market order (filled path)"
MARKET_ORDER_PAYLOAD="$(auth_post "/api/orders" "$(jq -nc \
  --arg m "$TRADE_MARKET" \
  --arg s "$TRADE_SYMBOL" \
  '{market:$m,symbol:$s,side:"buy",type:"market",quantity:1,reasoning:"e2e smoke: open starter position"}'
)")"
MARKET_ORDER_ID="$(jq -r '.id // empty' <<<"$MARKET_ORDER_PAYLOAD")"
[[ -n "$MARKET_ORDER_ID" ]] || { echo "market order failed: $MARKET_ORDER_PAYLOAD"; exit 1; }

echo "[4/8] Place/cancel pending limit order (cancel path)"
LIMIT_ORDER_PAYLOAD="$(auth_post "/api/orders" "$(jq -nc \
  --arg m "$TRADE_MARKET" \
  --arg s "$TRADE_SYMBOL" \
  '{market:$m,symbol:$s,side:"sell",type:"limit",quantity:1,limitPrice:0.99,reasoning:"e2e smoke: pending order for cancel flow"}'
)")"
LIMIT_ORDER_ID="$(jq -r '.id // empty' <<<"$LIMIT_ORDER_PAYLOAD")"
[[ -n "$LIMIT_ORDER_ID" ]] || { echo "limit order failed: $LIMIT_ORDER_PAYLOAD"; exit 1; }

auth_get "/api/orders/$LIMIT_ORDER_ID" >/dev/null
auth_get "/api/orders?view=open" >/dev/null
auth_get "/api/orders?view=history" >/dev/null

CANCEL_PAYLOAD="$(auth_delete "/api/orders/$LIMIT_ORDER_ID" '{"reasoning":"e2e smoke: thesis invalidated"}')"
jq -e '.status == "cancelled"' <<<"$CANCEL_PAYLOAD" >/dev/null

echo "[5/8] Journal + account endpoints"
auth_post "/api/journal" '{"content":"e2e smoke note","tags":["e2e","smoke"]}' >/dev/null
auth_get "/api/journal?limit=5&offset=0" >/dev/null
auth_get "/api/account" >/dev/null
auth_get "/api/account/portfolio" >/dev/null
auth_get "/api/positions" >/dev/null

TIMELINE_PAYLOAD="$(auth_get "/api/account/timeline?limit=50&offset=0")"
jq -e '.events | any(.type == "order.cancelled")' <<<"$TIMELINE_PAYLOAD" >/dev/null

if [[ "${RUN_MANUAL_RECONCILE_CHECK:-0}" == "1" ]]; then
  echo "[6/8] Optional reconcile endpoint check (user scope)"
  auth_post "/api/orders/reconcile" '{"reasoning":"e2e smoke: manual reconcile check"}' >/dev/null
else
  echo "[6/8] Skip optional reconcile check (set RUN_MANUAL_RECONCILE_CHECK=1 to enable)"
fi

echo "[7/8] Negative checks (strict boundary behavior)"
LEGACY_REGISTER_CODE="$(curl -sS -o /tmp/unimarket-legacy-register.out -w "%{http_code}" \
  -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"name":"legacy-field-should-fail"}')"
[[ "$LEGACY_REGISTER_CODE" == "400" ]] || { echo "expected 400 for legacy register field, got $LEGACY_REGISTER_CODE"; exit 1; }

MISSING_REASONING_CODE="$(curl -sS -o /tmp/unimarket-missing-reasoning.out -w "%{http_code}" \
  -X POST "$BASE_URL/api/orders" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"market\":\"$TRADE_MARKET\",\"symbol\":\"$TRADE_SYMBOL\",\"side\":\"buy\",\"type\":\"market\",\"quantity\":1}")"
[[ "$MISSING_REASONING_CODE" == "400" ]] || { echo "expected 400 for missing reasoning, got $MISSING_REASONING_CODE"; exit 1; }

echo "[8/8] Optional admin checks"
if [[ -n "$ADMIN_API_KEY" ]]; then
  admin_post "/api/admin/users/$USER_ID/deposit" '{"amount":100}' >/dev/null
  admin_post "/api/admin/users/$USER_ID/withdraw" '{"amount":100}' >/dev/null
  curl -sS "$BASE_URL/api/admin/users/$USER_ID/timeline?limit=20&offset=0" \
    -H "Authorization: Bearer $ADMIN_API_KEY" >/dev/null
  curl -sS "$BASE_URL/api/admin/overview" -H "Authorization: Bearer $ADMIN_API_KEY" >/dev/null
  curl -sS "$BASE_URL/api/admin/equity-history?range=1w" -H "Authorization: Bearer $ADMIN_API_KEY" >/dev/null

  REMOVED_ADMIN_ROUTE_CODE="$(curl -sS -o /tmp/unimarket-removed-admin-route.out -w "%{http_code}" \
    -X POST "$BASE_URL/api/admin/accounts/$ACCOUNT_ID/deposit" \
    -H "Authorization: Bearer $ADMIN_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"amount":100}')"
  [[ "$REMOVED_ADMIN_ROUTE_CODE" == "404" ]] || {
    echo "expected 404 for removed /api/admin/accounts route, got $REMOVED_ADMIN_ROUTE_CODE"
    exit 1
  }
fi

echo "E2E smoke passed."
```

### SSE Check (Recommended)

Open a second terminal and keep an SSE connection running while you place/cancel orders:

```bash
curl -N -H "Authorization: Bearer <api_key>" http://localhost:3100/api/events
```

Expected event sequence:
- first message: `system.ready`
- then trading events like `order.filled`, `order.cancelled`, `position.settled`

If timeline shows an event but SSE does not (or vice versa), treat it as a consistency bug.
