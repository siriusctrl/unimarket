# paper-trade

Open paper trading platform for prediction markets and beyond. Built for humans and agents alike.

## What is this?

A self-hosted paper trading engine with a clean REST API. Simulated trading across multiple markets — no real money, no risk. Any AI agent (or human) that can call an HTTP endpoint can trade.

- **Market agnostic** — unified API across all markets, discover capabilities at runtime
- **Polymarket** — prediction market trading with live odds from the CLOB API
- **Extensible** — add new markets by implementing a simple adapter interface
- **Agent-friendly** — auto-generated OpenAPI spec, self-describing market capabilities
- **US Stocks** — coming soon

## Architecture

```
┌─────────────────────────────────────────────────┐
│            Single Node.js Process                │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │           Hono Server (:3100)              │  │
│  │                                            │  │
│  │  /api/*  → REST API                        │  │
│  │  /*      → Static files (Vite build)       │  │
│  │  /openapi.json → Auto-generated spec       │  │
│  └──────────────────┬─────────────────────────┘  │
│                     │                            │
│  ┌──────────────────▼─────────────────────────┐  │
│  │          Trading Engine (core)             │  │
│  │   accounts · orders · positions · P&L      │  │
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
- OpenAPI spec + self-describing markets = any agent can integrate without prior knowledge
- Accounts get initial funds on creation; only admins can deposit/withdraw
- API key auth: register → get key → trade

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | TypeScript (end-to-end) | Type safety, shared types front-to-back |
| Runtime | Node.js | Single process serves everything |
| API | [Hono](https://hono.dev) + [Zod](https://zod.dev) | Type-safe routes, auto OpenAPI, serves static files |
| Database | SQLite via [Drizzle ORM](https://orm.drizzle.team) | Zero ops, single-file, perfect for paper trading |
| Frontend | [Vite](https://vite.dev) + [React](https://react.dev) | Pure SPA, no SSR complexity |
| Monorepo | pnpm workspaces | Simple, fast |
| Testing | [Vitest](https://vitest.dev) | Fast, native TS |

## Project Structure

```
paper-trade/
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

## API Overview

### Auth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/auth/register` | — | Register, get first API key |
| `POST` | `/api/auth/keys` | key | Generate additional API key |
| `DELETE` | `/api/auth/keys/:id` | key | Revoke a key |

### Accounts
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/accounts` | key | Create account (starts with initial balance) |
| `GET` | `/api/accounts/:id` | key | Get account details + balance |
| `GET` | `/api/accounts/:id/portfolio` | key | Full portfolio summary with P&L |

### Trading
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/orders` | key | Place an order (market/limit) |
| `GET` | `/api/orders` | key | List orders (filter by account, status, market) |
| `DELETE` | `/api/orders/:id` | key | Cancel a pending order |

### Positions
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/positions` | key | List open positions |

### Market Data (runtime discovery)
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/markets` | key | List markets + capabilities |
| `GET` | `/api/markets/:market/search` | key | Search assets (`?q=`) |
| `GET` | `/api/markets/:market/quote` | key | Get quote (`?symbol=`) |
| `GET` | `/api/markets/:market/orderbook` | key | Get orderbook (`?symbol=`) |
| `GET` | `/api/markets/:market/resolve` | key | Check settlement (`?symbol=`) |

### Admin
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/admin/accounts/:id/deposit` | admin | Add funds |
| `POST` | `/api/admin/accounts/:id/withdraw` | admin | Remove funds |

### Meta
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/openapi.json` | — | OpenAPI 3.1 spec |
| `GET` | `/health` | — | Health check |

## Runtime Market Discovery

`GET /api/markets` returns all available markets with their capabilities:

```json
{
  "markets": [
    {
      "id": "polymarket",
      "name": "Polymarket",
      "description": "Prediction markets — contracts resolve to $0 or $1",
      "symbolFormat": "Condition ID (hex string)",
      "priceRange": [0.01, 0.99],
      "capabilities": ["search", "quote", "orderbook", "resolve"]
    }
  ]
}
```

Capabilities map to available endpoints under `/api/markets/:market/`. Agents discover what's available at runtime — no hardcoded market knowledge needed.

## Market Adapters

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

Register it: `registry.set('my-market', new MyMarketAdapter())`. All routes work automatically.

## Getting Started

```bash
git clone https://github.com/siriusctrl/paper-trade.git
cd paper-trade
pnpm install
pnpm dev       # starts on :3100
pnpm test
```

## Roadmap

- [x] Project setup + architecture
- [ ] Core trading engine (accounts, orders, positions, P&L)
- [ ] Auth (register, API keys)
- [ ] Polymarket adapter
- [ ] REST API with OpenAPI spec
- [ ] Web dashboard
- [ ] Agent integration skill
- [ ] US stock market adapter
- [ ] More markets (Kalshi, crypto)
- [ ] Historical trade replay / backtesting
- [ ] WebSocket for real-time updates

## Contributing

PRs welcome. Strong types, pure functions in core, clear separation of concerns.

## License

MIT
