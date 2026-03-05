# Architecture

## System Overview

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

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Language | TypeScript (end-to-end) | Type safety, shared types front-to-back |
| Runtime | Node.js | Single process serves everything |
| API | [Hono](https://hono.dev) + [Zod](https://zod.dev) | Type-safe routes, SSE streaming, serves static files |
| Database | SQLite via [Drizzle ORM](https://orm.drizzle.team) | Zero ops, single-file, perfect for paper trading |
| Frontend | [Vite](https://vite.dev) + [React](https://react.dev) + [shadcn/ui](https://ui.shadcn.com) + [Tailwind](https://tailwindcss.com) + [Recharts](https://recharts.org) + [TanStack Table](https://tanstack.com/table) | Polished dashboard UI with fast iteration and strong data visualization/table primitives |
| Monorepo | pnpm workspaces | Simple, fast |
| Testing | [Vitest](https://vitest.dev) | Fast, native TS |

## Project Structure

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

## Market Adapter Interface

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

## Agent Integration

Agents interact with unimarket through a skill document (`skills/unimarket/SKILL.md`) that serves as the API contract. Key features:
- **Version-aware**: All responses include `X-API-Version` header. SSE connections start with a `system.ready` event containing the server version
- **Self-healing**: When the server version changes, agents can reload the skill document to pick up API changes
- **Real-time events**: `GET /api/events` streams order fills, cancellations, and settlements via SSE
- **Reasoning audit trail**: Every write operation requires a `reasoning` field for full decision transparency
- **Helper scripts**: `skills/unimarket/scripts/unimarket-agent.sh` wraps common auth/market/trading/event operations for faster agent integration
