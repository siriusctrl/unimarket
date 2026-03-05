# unimarket

Open paper trading platform for prediction markets and beyond. Built for humans and agents alike.

A self-hosted paper trading engine with a clean REST API. Simulated trading across multiple markets — no real money, no risk. Any AI agent (or human) that can call an HTTP endpoint can trade.

- **Market agnostic** — unified API across all markets, discover capabilities at runtime
- **Polymarket** — prediction market trading with live odds from the CLOB API
- **Extensible** — add new markets by implementing a simple adapter interface
- **Agent-friendly** — skill-based integration with version-aware SSE events, self-describing market capabilities
- **Decision transparency** — every action requires reasoning; journal + timeline for full audit trail

---

## Part 1: Architecture

### System Overview

```
┌─────────────────────────────────────────────────┐
│            Single Node.js Process                │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │           Hono Server (:3100)              │  │
│  │                                            │  │
│  │  /api/*      → REST API                    │  │
│  │  /api/events → SSE event stream            │  │
│  │  /* (opt-in) → Static files (Vite build)   │  │
│  └──────────────────┬─────────────────────────┘  │
│                     │                            │
│  ┌──────────────────▼─────────────────────────┐  │
│  │          Trading Engine (core)             │  │
│  │   account · orders · positions · P&L       │  │
│  │   pure logic, market agnostic              │  │
│  └──────────────────┬─────────────────────────┘  │
│                     │                            │
│  ┌──────────────────▼─────────────────────────┐  │
│  │         Market Adapter Registry            │  │
│  │  ┌─────────────┐  ┌─────────────┐         │  │
│  │  │ Polymarket  │  │  (future)   │  ...    │  │
│  │  └─────────────┘  └─────────────┘         │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**Key design decisions:**
- API-first by default: Hono serves API/SSE on `:3100`, frontend runs on Vite dev server (`:5173`)
- Optional single-process static hosting for built frontend via `SERVE_WEB_DIST=true`
- `core` is pure logic with no I/O — Zod schemas shared across the entire stack
- Market adapters implement a unified interface, registered at startup
- Runtime discovery: `GET /api/markets` returns available markets + capabilities
- Every write operation requires a `reasoning` field — full decision audit trail
- Journal endpoint for freeform notes; timeline endpoint aggregates everything
- Accounts get initial funds on creation; only admins can deposit/withdraw
- API key auth: register → get key → trade

### Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | TypeScript (end-to-end) | Type safety, shared types front-to-back |
| Runtime | Node.js | Single process serves everything |
| API | [Hono](https://hono.dev) + [Zod](https://zod.dev) | Type-safe routes, SSE streaming, serves static files |
| Database | SQLite via [Drizzle ORM](https://orm.drizzle.team) | Zero ops, single-file, perfect for paper trading |
| Frontend | [Vite](https://vite.dev) + [React](https://react.dev) + [shadcn/ui](https://ui.shadcn.com) + [Tailwind](https://tailwindcss.com) + [Recharts](https://recharts.org) + [TanStack Table](https://tanstack.com/table) | Polished dashboard UI with fast iteration and strong data visualization/table primitives |
| Monorepo | pnpm workspaces | Simple, fast |
| Testing | [Vitest](https://vitest.dev) | Fast, native TS |

### Project Structure

```
unimarket/
├── packages/
│   ├── core/             # Trading engine — pure logic, no I/O
│   │   ├── account.ts    # Account management, initial balance
│   │   ├── order.ts      # Order types, validation, matching
│   │   ├── position.ts   # Position tracking, average cost
│   │   ├── pnl.ts        # P&L calculation (realized + unrealized)
│   │   └── schemas.ts    # Zod schemas (shared front + back)
│   ├── markets/          # Market adapters (unified interface)
│   │   ├── types.ts      # MarketAdapter interface
│   │   └── polymarket/   # Polymarket CLOB API + Gamma API
│   ├── api/              # Hono server (API + static file serving)
│   │   ├── routes/       # Route handlers by domain
│   │   ├── middleware/    # Auth, error handling
│   │   ├── db/           # Drizzle schema + migrations
│   │   └── index.ts      # Entry point
│   └── web/              # Vite + React dashboard
├── skills/
│   └── unimarket/        # Agent integration skill
│       ├── SKILL.md
│       └── references/
│           ├── api.md
│           └── markets.md
└── README.md
```

### Market Adapter Interface

Adding a new market means implementing this interface:

```typescript
interface MarketAdapter {
  readonly marketId: string
  readonly displayName: string
  readonly description: string
  readonly symbolFormat: string
  readonly priceRange: [number, number] | null
  readonly capabilities: string[]

  getQuote(symbol: string): Promise<Quote>
  search(query: string): Promise<Asset[]>
  getOrderbook?(symbol: string): Promise<Orderbook>
  resolve?(symbol: string): Promise<Resolution | null>
}
```

### Agent Integration

Agents interact with unimarket through a skill document (`skills/unimarket/SKILL.md`) that serves as the API contract. Key features:
- **Version-aware**: All responses include `X-API-Version` header. SSE connections start with a `system.ready` event containing the server version
- **Self-healing**: When the server version changes, agents can reload the skill document to pick up API changes
- **Real-time events**: `GET /api/events` streams order fills, cancellations, and settlements via SSE
- **Reasoning audit trail**: Every write operation requires a `reasoning` field for full decision transparency
- **Helper scripts**: `skills/unimarket/scripts/unimarket-agent.sh` wraps common auth/market/trading/event operations for faster agent integration

---

## Part 2: Admin Guide

### Getting Started

```bash
git clone https://github.com/siriusctrl/unimarket.git
cd unimarket
pnpm install
```

### Restore Agent Tooling (Optional for Contributors)

If you use `npx skills`, restore the team-locked tool skills from `skills-lock.json`:

```bash
npx skills experimental_install
```

This installs local tooling under `.agents/` (gitignored in this repo).

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_API_KEY` | **Yes** | — | Admin API key for dashboard login and admin endpoints |
| `DB_URL` / `DB_PATH` | No | `file:unimarket.sqlite` | SQLite database path |
| `RECONCILE_INTERVAL_MS` | No | `1000` | Pending order reconciliation interval (ms) |
| `SERVE_WEB_DIST` | No | `false` | Serve built frontend from API server on `:3100` when set to `true` |

### Running the Server

```bash
# Set the admin key and start everything (API + web dashboard)
export ADMIN_API_KEY=your-secret-key
pnpm dev

# Or set it inline
ADMIN_API_KEY=your-secret-key pnpm dev

# Individual services
pnpm dev:api   # API only (:3100, no dashboard static by default)
pnpm dev:web   # Dashboard only (:5173)

# Optional: serve built dashboard from API server (:3100)
SERVE_WEB_DIST=true pnpm dev:api
```

### Using the Admin Dashboard

1. Open `http://localhost:5173` in your browser
2. Enter your `ADMIN_API_KEY` on the login page
3. The dashboard shows:
   - **Equity trend chart** — multi-agent line chart, toggle between net value and return rate (1W/1M/3M/6M/1Y)
   - **Agent cards** — each agent's equity, cash, PnL, and top holdings (searchable, paginated)
4. Click any agent card to see their **detail page**:
   - Balance, equity, unrealized PnL
   - Open positions table
   - Activity feed (recent orders with reasoning, journal entries)

> **Note:** The equity chart accumulates data from snapshots recorded each time you refresh the dashboard. The chart will populate over time as you use the system.

### Admin API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/admin/users/:id/deposit` | Add funds to a user's account (`{ "amount": 1000 }`) |
| `POST` | `/api/admin/users/:id/withdraw` | Remove funds from a user's account |
| `GET` | `/api/admin/overview` | Full portfolio overview (totals, markets, agents) |
| `GET` | `/api/admin/users/:id/timeline` | Agent's order + journal history (`?limit=20&offset=0`) |
| `GET` | `/api/admin/equity-history` | Agent equity time-series (`?range=1w|1m|3m|6m|1y`) |

All admin endpoints require `Authorization: Bearer <ADMIN_API_KEY>`.

### Managing Agents

**Create an agent (register):**
```bash
curl -X POST http://localhost:3100/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"userName": "my-agent"}'
```

**Deposit funds:**
```bash
curl -X POST http://localhost:3100/api/admin/users/<userId>/deposit \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"amount": 100000}'
```

### Reconciler

The reconciler runs in the background (every 1s by default) and tries to fill pending limit orders when market prices reach the limit price. If a contract is expired or delisted (upstream 404), the reconciler will **auto-cancel** those orders.

For normal client behavior:
- Read state from `GET /api/orders`, `GET /api/positions`, and `GET /api/account/portfolio`.
- Do not call manual reconcile every cycle.

Use `POST /api/orders/reconcile` only when you need immediate deterministic convergence for pending limit orders (for example, in strict tests right after place/cancel).

---

## API Reference

### Auth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/auth/register` | — | Register (`userName`), get first API key + default account |
| `POST` | `/api/auth/keys` | key | Generate additional API key |
| `DELETE` | `/api/auth/keys/:id` | key | Revoke a key |

### Accounts
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/account` | key | Get current user's default account details |
| `GET` | `/api/account/portfolio` | key | Current user's portfolio summary with P&L |
| `GET` | `/api/account/timeline` | key | Current user's timeline (orders + journal) |

### Trading
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/orders` | key | Place an order (requires `reasoning`; supports `Idempotency-Key`) |
| `GET` | `/api/orders` | key | List orders (`view=open|history|all`) |
| `GET` | `/api/orders/:id` | key | Get a single order by id |
| `POST` | `/api/orders/reconcile` | key/admin | Optional manual reconcile trigger for pending limit orders (requires `reasoning`) |
| `DELETE` | `/api/orders/:id` | key | Cancel an order (requires `reasoning`; supports `Idempotency-Key`) |

### Real-Time Events
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/events` | key | Subscribe to SSE events; supports replay via `Last-Event-ID` or `?since=` |

### Positions
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/positions` | key | List open positions |

### Journal
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/journal` | key | Write a journal entry (supports `Idempotency-Key`) |
| `GET` | `/api/journal` | key | List entries (`?limit=5&offset=0&q=&tags=`) |

### Market Data
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/markets` | key | List markets + capabilities |
| `GET` | `/api/markets/:market/search` | key | Search or browse assets (`?q=&limit=20&offset=0`, default 20, max 100) |
| `GET` | `/api/markets/:market/quote` | key | Get quote (`?symbol=`) |
| `GET` | `/api/markets/:market/quotes` | key | Get quotes in batch (`?symbols=s1,s2,...`, up to 50) |
| `GET` | `/api/markets/:market/orderbook` | key | Get orderbook (`?symbol=`) |
| `GET` | `/api/markets/:market/orderbooks` | key | Get orderbooks in batch (`?symbols=s1,s2,...`, up to 50) |
| `GET` | `/api/markets/:market/resolve` | key | Check settlement (`?symbol=`) |

### Meta
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | — | Health check (includes API version) |

---

## Testing

```bash
pnpm test       # Run all tests
pnpm coverage   # Coverage with CI-enforced thresholds
```

### Agent Endpoint E2E Method (Black-Box)

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
- Market data: search/quote/orderbook/resolve for every discovered market capability
- Trading: market order fill, pending limit order, cancel, optional manual reconcile check
- Account data: account, positions, portfolio, timeline, journal
- Realtime: SSE `system.ready` and trading events
- Admin (optional): deposit/withdraw/timeline/overview/equity-history + removed legacy route checks

#### One-Command Smoke Playbook

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

#### SSE Check (Recommended)

Open a second terminal and keep an SSE connection running while you place/cancel orders:

```bash
curl -N -H "Authorization: Bearer <api_key>" http://localhost:3100/api/events
```

Expected event sequence:
- first message: `system.ready`
- then trading events like `order.filled`, `order.cancelled`, `position.settled`

If timeline shows an event but SSE does not (or vice versa), treat it as a consistency bug.

## Roadmap

- [x] Core trading engine (accounts, orders, positions, P&L)
- [x] Auth (register, API keys)
- [x] Polymarket adapter (search, browse, quote, orderbook, resolve)
- [x] Journal + timeline
- [x] REST API with skill-based agent integration
- [x] Limit order improvements (immediate fill when marketable)
- [x] Pending order reconcile endpoint
- [x] Web dashboard (admin overview, equity charts, agent detail pages)
- [x] SSE event stream for real-time agent notifications
- [x] API versioning with system.ready handshake
- [x] Reconciler optimization (symbol-batched quotes, auto-cancel expired contracts)
- [ ] US stock market adapter
- [ ] More markets (Kalshi, crypto)
- [ ] Historical trade replay / backtesting

## Contributing

PRs welcome. Strong types, pure functions in core, clear separation of concerns.

## License

MIT
