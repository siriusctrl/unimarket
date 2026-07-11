# Testing

## Running Tests

```bash
pnpm test
pnpm coverage
pnpm verify:ui
pnpm verify:preview
pnpm verify:proof
pnpm verify:analysis-live
```

Package-focused validation is often faster while iterating:

```bash
corepack pnpm --filter @unimarket/api test
corepack pnpm --filter @unimarket/api exec tsc --noEmit
corepack pnpm --filter @unimarket/web exec tsc --noEmit
```

## Testing Strategy

The repository follows a few testing layers.

- Core business behavior: deterministic unit tests for fills, PnL, leverage, and liquidation math
- Market adapters: mocked upstream responses and normalization behavior
- API contract tests: status codes, payloads, auth boundaries, and persistence side effects
- Integration workers: reconciliation, settlement, funding, and liquidation flows
- Browser smoke: deterministic dashboard rendering, navigation, filters, theme, and responsive shell
- Analysis protocol: schema semantics, deterministic indicators, snapshot validation, immutable publishing, drawing projection, and provider-neutral provenance

## Dashboard Browser Verification

The browser layer is intentionally separate from API E2E. Playwright intercepts
`/api/dashboard/*` and `/api/analysis/*` requests and returns the shared fixture in
`tests/browser/fixtures/dashboard.mjs`. This keeps UI proof deterministic and
prevents live Polymarket/Hyperliquid availability or local database contents
from changing the rendered result.

Install Chromium once:

```bash
pnpm setup:browsers
```

Run the interaction suite against a Vite dev server:

```bash
pnpm verify:ui
```

The suite covers:

- overview and equity chart rendering;
- equity/return mode and range controls;
- roster search;
- agent-detail navigation and position rendering;
- audit timeline filtering;
- light/dark theme switching;
- mobile navigation and page-level overflow;
- uncaught browser and console errors.
- MU candlesticks, price indicators, oscillator pane, volume profile, and model-authored drawings.

Run the production bundle smoke separately:

```bash
pnpm verify:preview
```

This builds `@unimarket/web`, serves the Vite preview, and proves that the main
dashboard-to-agent-detail path still works from production assets.
It also verifies that production assets render the MU analysis document and its profile bins.

## Live MU Analysis Verification

Run the opt-in network check when changing chart context, Hyperliquid history, analysis persistence, or rendering:

```bash
pnpm verify:analysis-live
```

The script starts isolated API, Vite, and persistent renderer processes, fetches live `xyz:MU` daily candles from Hyperliquid, creates a model-neutral draft, inspects and renders that exact snapshot, checks visible/clipped drawings plus volume-profile bins, then publishes and writes JSON/screenshot evidence under `artifacts/analysis/<timestamp>/`.

This remains a transport and rendering smoke test. Human or model image inspection is required to judge whether the selected viewport, pivots, lines, channels, and labels make technical sense.

This is not a deterministic CI dependency. The normal browser suite uses a fixed MU fixture; the live command proves the external adapter boundary on demand.

For a user-facing visual change, also run:

```bash
pnpm verify:proof
```

See [Visual Verification](visual-verification.md) for artifact inspection and
handoff requirements. API contract changes must update both focused API tests
and the browser fixture when the dashboard response shape changes.

High-severity regressions include:
- balance/accounting drift
- wrong position math
- liquidation mis-accounting
- auth boundary mistakes
- timeline and SSE inconsistency

## Agent Endpoint E2E Method

This is the preferred black-box method for validating the public API without reading the server code first.

1. Use `skills/unimarket/SKILL.md` as the contract.
2. Register via `POST /api/auth/register`.
3. Discover markets dynamically via `GET /api/markets`.
4. Exercise the full trade lifecycle.
5. Validate consistency across `orders`, `timeline`, `portfolio`, and `SSE`.
6. Run negative-path checks.
7. Only inspect implementation code after reproducing unexpected behavior.

Coverage targets:
- auth: register, create/revoke key, unauthorized behavior
- market data: search, quote, orderbook, funding, resolve, constraints
- trading: market fill, pending limit order, cancel, automatic reconciliation
- account data: account, positions, portfolio, timeline, journal
- workers: settlement, funding, liquidation
- admin: deposit, withdraw, overview, portfolio, timeline, no proxy order placement
- real-time: `system.ready`, fills, cancels, settlements, funding, liquidation

## One-Command Smoke Playbook

Requirements: `curl`, `jq`, API at `http://localhost:3100`.

```bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3100}"
ADMIN_API_KEY="${ADMIN_API_KEY:-}"

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
  echo "register failed: $REGISTER_PAYLOAD"
  exit 1
}

echo "[2/8] Discover markets + capability endpoints"
MARKETS_PAYLOAD="$(auth_get "/api/markets")"
jq -e '.markets | length > 0' <<<"$MARKETS_PAYLOAD" >/dev/null

TRADE_MARKET=""
TRADE_SYMBOL=""
while read -r MARKET_ID; do
  [[ -n "$MARKET_ID" ]] || continue

  SORT="$(jq -r --arg m "$MARKET_ID" '.markets[] | select(.id == $m) | .browseOptions[0].value // empty' <<<"$MARKETS_PAYLOAD")"
  BROWSE_URL="/api/markets/$MARKET_ID/browse?limit=1"
  if [[ -n "$SORT" ]]; then
    BROWSE_URL="$BROWSE_URL&sort=$SORT"
  fi
  BROWSE_PAYLOAD="$(auth_get "$BROWSE_URL")"
  REFERENCE="$(jq -r '.results[0].reference // empty' <<<"$BROWSE_PAYLOAD")"
  [[ -n "$REFERENCE" ]] || continue

  CAPS="$(jq -r --arg m "$MARKET_ID" '.markets[] | select(.id == $m) | .capabilities[]?' <<<"$MARKETS_PAYLOAD")"
  if grep -qx "quote" <<<"$CAPS"; then
    auth_get "/api/markets/$MARKET_ID/quote?reference=$REFERENCE" >/dev/null
  fi
  if grep -qx "orderbook" <<<"$CAPS"; then
    auth_get "/api/markets/$MARKET_ID/orderbook?reference=$REFERENCE" >/dev/null
  fi
  if grep -qx "funding" <<<"$CAPS"; then
    auth_get "/api/markets/$MARKET_ID/funding?reference=$REFERENCE" >/dev/null
  fi
  if grep -qx "resolve" <<<"$CAPS"; then
    auth_get "/api/markets/$MARKET_ID/resolve?reference=$REFERENCE" >/dev/null
  fi

  if [[ -z "$TRADE_MARKET" ]]; then
    TRADE_MARKET="$MARKET_ID"
    TRADE_SYMBOL="$REFERENCE"
  fi
done < <(jq -r '.markets[].id' <<<"$MARKETS_PAYLOAD")

[[ -n "$TRADE_MARKET" && -n "$TRADE_SYMBOL" ]] || {
  echo "no tradeable reference found"
  exit 1
}

echo "[3/8] Place market order"
MARKET_ORDER_PAYLOAD="$(auth_post "/api/orders" "$(jq -nc \
  --arg m "$TRADE_MARKET" \
  --arg s "$TRADE_SYMBOL" \
  '{market:$m,reference:$s,side:"buy",type:"market",quantity:1,reasoning:"e2e smoke: open starter position"}'
)")"
MARKET_ORDER_ID="$(jq -r '.id // empty' <<<"$MARKET_ORDER_PAYLOAD")"
[[ -n "$MARKET_ORDER_ID" ]] || { echo "market order failed: $MARKET_ORDER_PAYLOAD"; exit 1; }

echo "[4/8] Place and cancel pending limit order"
LIMIT_ORDER_PAYLOAD="$(auth_post "/api/orders" "$(jq -nc \
  --arg m "$TRADE_MARKET" \
  --arg s "$TRADE_SYMBOL" \
  '{market:$m,reference:$s,side:"sell",type:"limit",quantity:1,limitPrice:0.99,reasoning:"e2e smoke: pending order for cancel flow"}'
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

echo "[6/8] Reconciler is background-only"

echo "[7/8] Negative checks"
LEGACY_REGISTER_CODE="$(curl -sS -o /tmp/unimarket-legacy-register.out -w "%{http_code}" \
  -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"name":"legacy-field-should-fail"}')"
[[ "$LEGACY_REGISTER_CODE" == "400" ]] || { echo "expected 400 for legacy register field"; exit 1; }

MISSING_REASONING_CODE="$(curl -sS -o /tmp/unimarket-missing-reasoning.out -w "%{http_code}" \
  -X POST "$BASE_URL/api/orders" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"market\":\"$TRADE_MARKET\",\"reference\":\"$TRADE_SYMBOL\",\"side\":\"buy\",\"type\":\"market\",\"quantity\":1}")"
[[ "$MISSING_REASONING_CODE" == "400" ]] || { echo "expected 400 for missing reasoning"; exit 1; }

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
```

## SSE Check

Keep an SSE connection open while placing or cancelling orders:

```bash
curl -N -H "Authorization: Bearer <api_key>" http://localhost:3100/api/events
```

Expected behavior:
- first event: `system.ready`
- later events depend on activity and may include:
  - `order.filled`
  - `order.cancelled`
  - `position.settled`
  - `funding.applied`
  - `position.liquidated`

If timeline shows an event that SSE never emitted, or SSE emits a state-changing event that never appears in durable reads, treat it as a consistency bug.

## Worker-Focused Regression Checklist

These regressions are worth testing directly when worker logic changes.

### Reconciler

- fills pending limit orders when quotes cross
- leaves non-executable orders pending
- cancels stale orders for symbols that disappear upstream

### Settler

- credits settlement proceeds correctly
- removes the settled position
- emits settlement events

### Funding collector

- applies signed funding payments in the correct direction
- persists `funding_payments`
- updates portfolio and timeline views

### Liquidator

- triggers when `positionEquity <= maintenanceMargin`
- uses directional execution prices, not just midpoint quotes
- caps liquidation fees to isolated remaining payout
- deletes the position and perp state
- auto-cancels linked pending `reduceOnly` orders
- writes a `liquidations` audit row
- emits `position.liquidated`
