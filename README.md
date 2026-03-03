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
│  │  /api/*  → REST API                        │  │
│  │  /*      → Static files (Vite build)       │  │
│  │  /api/events → SSE event stream            │  │
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
- Single process: Hono serves both API and frontend static files
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
├── skill/                # Agent integration skill
│   ├── SKILL.md
│   └── references/
│       ├── api.md
│       └── markets.md
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

Agents interact with unimarket through a skill document (`skill/SKILL.md`) that serves as the API contract. Key features:
- **Version-aware**: All responses include `X-API-Version` header. SSE connections start with a `system.ready` event containing the server version
- **Self-healing**: When the server version changes, agents can reload the skill document to pick up API changes
- **Real-time events**: `GET /api/events` streams order fills, cancellations, and settlements via SSE
- **Reasoning audit trail**: Every write operation requires a `reasoning` field for full decision transparency

---

## Part 2: Admin Guide

### Getting Started

```bash
git clone https://github.com/siriusctrl/unimarket.git
cd unimarket
pnpm install
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_API_KEY` | **Yes** | — | Admin API key for dashboard login and admin endpoints |
| `DB_URL` / `DB_PATH` | No | `file:unimarket.sqlite` | SQLite database path |
| `RECONCILE_INTERVAL_MS` | No | `1000` | Pending order reconciliation interval (ms) |

### Running the Server

```bash
# Set the admin key and start everything (API + web dashboard)
export ADMIN_API_KEY=your-secret-key
pnpm dev

# Or set it inline
ADMIN_API_KEY=your-secret-key pnpm dev

# Individual services
pnpm dev:api   # API only (:3100)
pnpm dev:web   # Dashboard only (:5173)
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
| `POST` | `/api/orders` | key | Place an order (requires `reasoning`) |
| `GET` | `/api/orders` | key | List orders (`view=open|history|all`) |
| `GET` | `/api/orders/:id` | key | Get a single order by id |
| `POST` | `/api/orders/reconcile` | key/admin | Reconcile pending limit orders (requires `reasoning`) |
| `DELETE` | `/api/orders/:id` | key | Cancel an order (requires `reasoning`) |

### Real-Time Events
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/events` | key | Subscribe to real-time events via SSE (order fills, cancellations, settlements) |

### Positions
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/positions` | key | List open positions |

### Journal
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/journal` | key | Write a journal entry |
| `GET` | `/api/journal` | key | List entries (`?limit=5&offset=0&q=&tags=`) |

### Market Data
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/markets` | key | List markets + capabilities |
| `GET` | `/api/markets/:market/search` | key | Search or browse assets (`?q=&limit=20&offset=0`, default 20, max 100) |
| `GET` | `/api/markets/:market/quote` | key | Get quote (`?symbol=`) |
| `GET` | `/api/markets/:market/orderbook` | key | Get orderbook (`?symbol=`) |
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
