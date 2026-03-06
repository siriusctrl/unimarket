# Architecture

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────┐
│                           Single Node.js Process                     │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Hono API Server (:3100)                                        │  │
│  │                                                                │  │
│  │ /api/*      REST endpoints                                     │  │
│  │ /api/events Server-Sent Events                                 │  │
│  │ /*          Optional static frontend hosting                    │  │
│  └───────────────┬────────────────────────────────────────────────┘  │
│                  │                                                   │
│  ┌───────────────▼────────────────────────────────────────────────┐  │
│  │ Application Layer                                              │  │
│  │ auth · routes · validation · idempotency · event fan-out       │  │
│  └───────────────┬────────────────────────────────────────────────┘  │
│                  │                                                   │
│  ┌───────────────▼────────────────────────────────────────────────┐  │
│  │ Trading Domain                                                 │  │
│  │ spot fills · perp fills · PnL · margin · liquidation math      │  │
│  │ pure and market-agnostic                                        │  │
│  └───────────────┬────────────────────────────────────────────────┘  │
│                  │                                                   │
│  ┌───────────────▼────────────────────────────────────────────────┐  │
│  │ Market Registry                                                │  │
│  │ Polymarket · Hyperliquid · future adapters                     │  │
│  └───────────────┬────────────────────────────────────────────────┘  │
│                  │                                                   │
│  ┌───────────────▼────────────────────────────────────────────────┐  │
│  │ SQLite + Drizzle                                               │  │
│  │ accounts · orders · trades · positions · funding · liquidations│  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  Background workers: reconciler · settler · funding collector ·     │
│  liquidator · equity snapshotter                                    │
└──────────────────────────────────────────────────────────────────────┘
```

## Design Goals

The codebase is shaped around a few durable goals.

- Simulation-first: never require real exchange keys for core paper trading.
- Market agnostic: data-source differences stay inside adapters.
- Deterministic domain logic: accounting and risk math stay testable.
- Explicit audit trail: writes carry reasoning and surface in timeline/event feeds.
- Runtime discoverability: clients inspect capabilities instead of hardcoding assumptions.

## Package Layout

```text
unimarket/
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── engine.ts      # Spot fill logic
│   │       ├── perp.ts        # Perp fill, margin, liquidation math
│   │       ├── schemas.ts     # Shared Zod schemas
│   │       └── index.ts
│   ├── markets/
│   │   └── src/
│   │       ├── types.ts       # MarketAdapter contract
│   │       ├── registry.ts    # Registry implementation
│   │       ├── polymarket.ts  # Gamma + CLOB integration
│   │       └── hyperliquid.ts # Perp market integration
│   ├── api/
│   │   └── src/
│   │       ├── routes/        # HTTP entrypoints
│   │       ├── services/      # Shared API orchestration + read models
│   │       ├── db/            # Schema and SQLite setup
│   │       ├── platform/      # Auth, idempotency, SSE, boundary helpers
│   │       ├── workers/       # Background schedulers and worker entrypoints
│   │       ├── timeline.ts    # Unified audit timeline builder
│   │       └── index.ts       # API bootstrap
│   └── web/
│       └── src/
│           ├── pages/         # Admin pages
│           ├── components/    # Shared UI + activity feed
│           └── lib/           # API hooks and formatting helpers
├── docs/
├── skills/
└── README.md
```

## Separation of Responsibilities

### `packages/core`

The `core` package owns the trading rules.

It should answer questions like:
- how does a spot fill update balance and average cost?
- how does a perp fill update signed quantity and isolated margin?
- when should a reduce-only order be rejected?
- how do unrealized PnL, maintenance margin, and liquidation price compute?

It should not know anything about:
- HTTP
- SQLite
- SSE
- specific exchanges

### `packages/markets`

The `markets` package owns market-specific reads.

Adapters expose a common interface so the rest of the system can ask for:
- searchable assets
- quotes
- orderbooks
- funding rates
- resolution information
- trading constraints
- symbol normalization when needed

Adapters do not execute trades. They are data providers for the simulation engine.

### `packages/api`

The `api` package wires everything together.

It handles:
- authentication and admin boundaries
- request validation
- idempotency
- shared order-placement and order-cancellation orchestration for routes and workers
- shared portfolio and overview read-model builders
- persistence
- worker scheduling
- SSE event emission
- timeline aggregation

Within `packages/api/src`, the subdirectories are organized by runtime role:
- `routes/` defines HTTP boundaries and permission checks
- `services/` holds shared orchestration and read-model builders
- `platform/` contains auth, idempotency, SSE, and other framework-facing boundary helpers
- `workers/` contains background loops such as reconcile, settle, liquidation, funding collection, and equity snapshotting

This package is where pure domain logic meets side effects.

### `packages/web`

The `web` package is the operator dashboard.

It is intentionally thin:
- reads from REST endpoints
- centralizes authenticated admin requests in a small API client layer
- renders portfolio, market, and timeline state
- writes through documented admin endpoints
- does not reimplement trading logic in the browser

## Market Capability Model

The most important architectural choice is capability-driven branching.

Examples:
- markets with `funding` are treated as perp markets
- markets with `resolve` support settlement checks
- markets with `orderbook` can expose live depth
- markets with `search` can drive browse/search UX

This avoids hardcoding business logic around a market name such as `if market === "hyperliquid"`.

The adapter contract currently centers around methods like:
- `search(query)`
- `getQuote(symbol)`
- `getOrderbook(symbol)`
- `getFundingRate(symbol)`
- `resolve(symbol)`
- `getTradingConstraints(symbol)`
- `normalizeSymbol(symbol)`

## Request Flow

A typical order request follows this path.

1. Route validates payload with shared schema.
2. Route resolves the acting identity and target account.
3. Route delegates to the shared order-placement service.
4. The service loads the adapter from the registry.
5. The service normalizes the symbol and validates trading constraints.
6. The service fetches a quote.
7. The service chooses spot or perp engine based on capabilities.
8. The service performs transactional writes to accounts, orders, trades, and positions.
9. The service emits SSE events and returns the new state.

This split is intentional:
- routes keep permission boundaries explicit
- shared services keep filled and cancelled order lifecycles on one persistence path

Limit orders stop after step 8 with `status = pending`. The reconciler later resumes the flow when the market becomes executable.

## Persistence Model

The storage model is intentionally direct and observable.

Key tables:
- `users`, `api_keys`, `accounts`
- `orders`, `order_execution_params`, `trades`
- `positions`, `perp_position_state`
- `journal`
- `funding_payments`
- `liquidations`
- `equity_snapshots`

A few design choices matter here.

- Spot and perp positions share the `positions` table.
- Perp-only risk state lives in `perp_position_state`.
- `order_execution_params` keeps optional per-order execution fields such as leverage and reduce-only.
- `liquidations` stores structured liquidation audits instead of hiding everything inside generic order reasoning.

## Background Workers

The server process starts five workers after database migration.

### Reconciler

Purpose:
- fill pending limit orders
- auto-cancel invalid stale orders

Why it exists:
- keeps API writes simple
- avoids a full exchange-style matching engine

### Settler

Purpose:
- settle resolved spot positions through adapter resolution data

Why it exists:
- prediction markets often end through resolution, not a user sell order

### Funding Collector

Purpose:
- apply periodic perp funding to open leveraged positions

Why it exists:
- funding is part of the holding-cost model for perp markets

### Liquidator

Purpose:
- close unsafe perp positions when maintenance margin is breached
- cancel orphaned reduce-only orders tied to the liquidated symbol
- persist a dedicated liquidation audit record

Why it exists:
- keeps the risk model explicit and testable
- surfaces liquidation as a first-class event instead of a hidden side effect

### Equity Snapshotter

Purpose:
- record periodic account-equity snapshots for operator history charts

Why it exists:
- keeps `GET /api/admin/overview` read-only
- makes snapshot cadence an explicit background policy instead of a dashboard side effect

## Timeline and Event Architecture

The system exposes two audit surfaces.

### Timeline

The timeline is a merged historical feed built from persisted records.

Current timeline event types:
- `order`
- `order.cancelled`
- `journal`
- `funding.applied`
- `position.liquidated`

The account timeline and admin timeline both use the same builder so operators and end users see consistent event semantics.

The timeline record contract is shared through `@unimarket/core`, so the API and web dashboard do not maintain separate event-shape definitions.

### SSE

SSE is the real-time feed.

Current event types:
- `system.ready`
- `order.filled`
- `order.cancelled`
- `position.settled`
- `funding.applied`
- `position.liquidated`

The event bus also supports replay via `Last-Event-ID` or `?since=`.

## Risk Model Summary

The current risk model is intentionally narrow.

- Spot markets: long-only inventory, no naked shorts.
- Perp markets: isolated margin, signed positions, leverage, funding, liquidation.
- Liquidation trigger: `quote.price`.
- Liquidation execution: directional `bid` or `ask`, with fallback to `price`.
- Liquidation scope: full liquidation only.

This is not a full exchange risk engine. It is a pragmatic paper-trading model that favors clarity and auditability over exchange-level completeness.

## Extension Points

If you add a new market, the preferred path is:

1. implement a new adapter in `packages/markets`
2. expose capabilities honestly
3. add adapter tests with mocked upstream responses
4. register it in the API bootstrap path
5. document any special symbol semantics or constraints

If you add a new domain feature, the preferred path is:

1. keep math and state transitions in `packages/core` when possible
2. keep database and HTTP concerns in `packages/api`
3. update timeline/events when the feature affects observable state
4. update docs and tests in the same change
