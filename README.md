# paper-trade

Open paper trading platform for US stocks and prediction markets. Built for humans and agents alike.

## What is this?

A self-hosted paper trading engine with a clean REST API. You get simulated trading across multiple markets — no real money, no risk. Any AI agent (or human) that can call an HTTP endpoint can trade.

- **US Stocks** — real-time quotes, market/limit orders, portfolio tracking
- **Polymarket** — prediction market trading with live odds from the CLOB API
- **Extensible** — add new markets by implementing a simple adapter interface

The platform ships with a web dashboard for visual monitoring and an auto-generated OpenAPI spec so any agent framework can integrate without custom glue code.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Web UI (Next.js)               │
└──────────────────────┬──────────────────────────┘
                       │ REST
┌──────────────────────▼──────────────────────────┐
│                 API Server (Hono)                │
│         auto-generated OpenAPI 3.1 spec          │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│              Trading Engine (core)               │
│   accounts · orders · positions · P&L · risk     │
└──────┬───────────────────────────────┬──────────┘
       │                               │
┌──────▼──────┐                 ┌──────▼──────┐
│  US Stocks  │                 │ Polymarket  │
│  (adapter)  │                 │  (adapter)  │
└─────────────┘                 └─────────────┘
```

**Key design decisions:**
- `core` is pure logic with no I/O — easy to test, easy to embed
- Market adapters implement a unified interface (`getQuote`, `getOrderbook`, `subscribe`)
- Database operations live in the `api` layer, not in core
- OpenAPI spec is the universal "skill" — any agent that reads JSON can trade

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | TypeScript (end-to-end) | Type safety across the entire stack |
| Runtime | Node.js | Shared ecosystem front-to-back |
| API | [Hono](https://hono.dev) + [Zod](https://zod.dev) | Lightweight, type-safe, auto OpenAPI generation |
| Database | SQLite via [Drizzle ORM](https://orm.drizzle.team) | Zero ops, single-file, perfect for paper trading scale |
| Frontend | [Next.js](https://nextjs.org) (App Router) | SSR dashboard with real-time updates |
| Monorepo | pnpm workspaces | Simple, fast, no extra tooling |
| Testing | [Vitest](https://vitest.dev) | Fast, native TS support |

## Project Structure

```
paper-trade/
├── packages/
│   ├── core/             # Trading engine — pure logic, no I/O
│   │   ├── account.ts    # Account management (create, balance, deposit, withdraw)
│   │   ├── order.ts      # Order types, validation, matching
│   │   ├── position.ts   # Position tracking, average cost
│   │   ├── pnl.ts        # P&L calculation (realized + unrealized)
│   │   └── types.ts      # Shared domain types
│   ├── markets/          # Market adapters (unified interface)
│   │   ├── types.ts      # MarketAdapter interface
│   │   ├── us-stock/     # Yahoo Finance / Alpaca quotes
│   │   └── polymarket/   # Polymarket CLOB API
│   ├── api/              # Hono REST API server
│   │   ├── routes/       # Route handlers by domain
│   │   ├── db/           # Drizzle schema + migrations
│   │   └── openapi.ts    # Auto-generated OpenAPI spec
│   └── web/              # Next.js dashboard
├── docs/
│   └── agent-guide.md    # How to connect your agent
├── examples/
│   ├── curl.sh           # Quick start with curl
│   ├── python-client.py  # Python example
│   └── skill.md          # OpenClaw skill reference
└── package.json          # pnpm workspace root
```

## Core API

### Accounts
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/accounts` | Create a new trading account |
| `GET` | `/accounts/:id` | Get account details + balance |
| `POST` | `/accounts/:id/deposit` | Add virtual funds |

### Trading
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/orders` | Place an order (market/limit) |
| `GET` | `/orders` | List orders (filter by account, status, market) |
| `DELETE` | `/orders/:id` | Cancel a pending order |

### Portfolio
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/positions` | List open positions |
| `GET` | `/positions/:id/pnl` | Get P&L for a position |
| `GET` | `/accounts/:id/portfolio` | Full portfolio summary with P&L |

### Market Data
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/markets` | List available markets |
| `GET` | `/markets/:market/quote/:symbol` | Get current quote |
| `GET` | `/markets/:market/search` | Search for tradeable assets |

### Meta
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/openapi.json` | OpenAPI 3.1 spec (your agent reads this) |
| `GET` | `/health` | Health check |

## Agent Integration

Any agent that can make HTTP calls can trade. The flow is:

```
1. GET  /openapi.json                 → understand available endpoints
2. POST /accounts                     → create a trading account
3. GET  /markets/us-stock/quote/AAPL  → check price
4. POST /orders                       → place a trade
5. GET  /accounts/:id/portfolio       → check how you're doing
```

No SDK needed. No special protocol. Just REST.

For agent frameworks that support OpenAPI tool discovery (most do), point them at `/openapi.json` and they'll figure out the rest.

## Market Adapters

Adding a new market (e.g., Kalshi, crypto exchanges) means implementing this interface:

```typescript
interface MarketAdapter {
  readonly marketId: string
  readonly displayName: string

  getQuote(symbol: string): Promise<Quote>
  search(query: string): Promise<Asset[]>
  getOrderbook?(symbol: string): Promise<Orderbook>
  resolve?(symbol: string): Promise<Resolution>  // for prediction markets
}
```

## Getting Started

```bash
# clone
git clone https://github.com/siriusctrl/paper-trade.git
cd paper-trade

# install
pnpm install

# start dev (api + web)
pnpm dev

# run tests
pnpm test
```

API runs on `http://localhost:3100`, web dashboard on `http://localhost:3000`.

## Roadmap

- [x] Project setup + architecture
- [ ] Core trading engine (accounts, orders, positions, P&L)
- [ ] US stock market adapter (Yahoo Finance)
- [ ] Polymarket adapter
- [ ] REST API with OpenAPI spec
- [ ] Web dashboard
- [ ] Agent integration guide + examples
- [ ] Historical trade replay / backtesting
- [ ] WebSocket for real-time updates
- [ ] More markets (Kalshi, crypto)

## Contributing

PRs welcome. The codebase is designed to be AI-friendly — strong types, pure functions in core, clear separation of concerns.

## License

MIT
