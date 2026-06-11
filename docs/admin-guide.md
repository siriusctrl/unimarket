# Admin Guide

This guide covers the operator-facing dashboard and admin-only API surface.

## What the Admin Surface Is For

Admins can:
- create agent users
- fund and withdraw from user accounts
- inspect portfolio and audit history across users
- monitor funding, liquidation, and equity trends

The dashboard and admin API are intentionally observational and operational: they are for account setup, portfolio review, agent audit, and incident follow-up, not manual or proxy trading. Agents place orders through their own user API keys, and the platform simulates fills, reconciliation, settlement, liquidation, PnL, and audit events from those agent-originated writes.

## Dashboard Design Contract

The dashboard should look and behave like an operator review console, not a trading terminal.

- Keep visible workflows read-oriented: overview, agent review, exposure, equity history, and audit timeline.
- Do not add manual order tickets, buy/sell controls, or human-first market discovery as a primary dashboard path.
- Keep agent reasoning prominent in the audit timeline because every state-changing action needs a readable "why".
- Use the established palette direction: neutral graphite surfaces, moss/eucalyptus primary actions, and muted material chart colors such as terracotta, dusty rose, pine, and graphite.
- Avoid common AI-dashboard styling: sci-fi cyan, purple/blue gradients, neon glows, abstract grid backgrounds, washed-out gray-green, and dirty yellow/olive casts.

## Using the Dashboard

### Login

1. Start the API with `ADMIN_API_KEY` configured.
2. Open the dashboard.
3. Authenticate with `Authorization: Bearer <ADMIN_API_KEY>` through the login page.

Typical local URLs:
- dashboard dev server: `http://localhost:5173`
- API server: `http://localhost:3100`

### Main operator views

The dashboard currently exposes observation and review workflows.

#### Overview

The overview screen shows:
- total balance, market value, unrealized PnL, and equity across users
- per-user cards with balances, equity, and top holdings
- market-level summary data across all tracked positions
- equity trend charts backed by the background equity snapshotter worker

Valuation semantics:
- portfolio and overview reads preserve factual positions even when a mark price is unavailable
- when any open position is unpriced, affected totals become partial rather than silently dropping the position
- the API exposes this through explicit valuation status and unpriced-position counts

#### Agent detail

A user detail view shows:
- current balance and open positions
- perp risk fields such as leverage and liquidation price when applicable
- recent activity merged from orders, journals, funding, and liquidation audits

## Admin API Endpoints

All admin endpoints require:

```text
Authorization: Bearer <ADMIN_API_KEY>
```

### Account management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/admin/users/:id/deposit` | Add funds to a user's default account |
| `POST` | `/api/admin/users/:id/withdraw` | Remove funds from a user's default account |
| `POST` | `/api/admin/traders` | Create an agent user and default account |

Examples:

```bash
curl -X POST http://localhost:3100/api/admin/traders \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"userName":"research-bot"}'
```

```bash
curl -X POST http://localhost:3100/api/admin/users/<userId>/deposit \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"amount":100000}'
```

### Read models

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/admin/overview` | Cross-user portfolio and market summary |
| `GET` | `/api/admin/users/:id/portfolio` | One user's balance, positions, open orders, and recent orders |
| `GET` | `/api/admin/users/:id/timeline` | One user's merged audit timeline |
| `GET` | `/api/admin/equity-history` | Historical equity snapshots grouped by user |

### Order execution boundary

Admins do not place orders on behalf of users. Order writes belong to agent/user credentials through `POST /api/orders`, where every state-changing action still requires `reasoning`.

This keeps the product boundary simple:
- agents decide and submit orders
- the trading engine simulates fills and persists accounting state
- operators review exposure, PnL, valuation health, and audit timelines

## Timeline Semantics

Admin timelines use the same merged event builder as user timelines.
The event record shape is shared through `@unimarket/core`, so the dashboard and API stay on one timeline contract.

Current timeline event types:
- `order`
- `order.cancelled`
- `journal`
- `funding.applied`
- `position.liquidated`

This matters operationally because liquidation is now a first-class audit record instead of just a generic filled order with opaque reasoning.

## Background Workers Relevant to Admins

### Reconciler

The reconciler runs in the background and tries to fill pending limit orders when market prices cross the limit.

Behavior:
- fills executable pending limit orders
- auto-cancels stale delisted or expired symbols when the adapter can no longer quote them

Normal clients should treat this as automatic background convergence. The reconciler is not exposed as a public API action; dashboards and agents should read `portfolio`, `openOrders`, and timeline state instead of trying to manually advance the worker.

### Settler

The settler resolves positions in markets that expose resolution data, such as prediction markets.

Behavior:
- credits settlement proceeds to the account
- deletes the settled position
- emits settlement events

### Funding collector

The funding collector applies periodic funding to open perp positions.

Behavior:
- updates account balance
- records funding payments for later portfolio and timeline views

### Liquidator

The liquidator scans funding-capable positions and closes unsafe perp positions.

Current behavior:
- trigger uses `quote.price`
- execution uses `bid` for liquidating longs and `ask` for liquidating shorts, with fallback to `price`
- remaining payout is capped to isolated position equity semantics
- pending `reduceOnly` orders on the same account, market, and symbol are auto-cancelled
- each liquidation is written to the structured `liquidations` audit table
- the system emits `position.liquidated` and any necessary `order.cancelled` events

For operators, that means the activity feed can now show:
- who got liquidated
- when it happened
- the trigger price and execution price
- the net payout returned to the account
- which reduce-only orders were cancelled as part of cleanup

## Operational Notes

- `GET /api/admin/overview` is read-only. Equity snapshots are recorded by the background equity snapshotter worker.
- when overview or per-user portfolio valuation is partial, treat aggregate equity and PnL as incomplete until pricing recovers
- Admin API does not expose order placement. Use agent/user API keys for order writes.
- If you see liquidation events, always check the paired portfolio state and recent funding for context.
- If a pending `reduceOnly` order disappears after liquidation, that is expected cleanup behavior.

## Recommended Operator Workflow

1. Create a dedicated agent user.
2. Deposit starting capital.
3. Let agents place trades through the user API.
4. Monitor positions and funding through portfolio views.
5. Use timelines and SSE for audit and incident review.
6. Use equity history for longer-horizon strategy comparison.
