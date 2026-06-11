# Trading Model

This document describes how unimarket simulates trading today. It focuses on the actual accounting and worker behavior in the codebase, not on hypothetical future exchange integrations.

## Core Principle

unimarket is simulation-first.

- Market adapters provide discovery, quotes, orderbooks, funding rates, and settlement metadata.
- The platform does not place real exchange orders for core paper-trading flows.
- Orders, fills, balances, positions, funding, settlement, and liquidation are accounted for locally.

This separation is deliberate:

- adapters stay market-specific,
- trading rules stay market-agnostic,
- audit trails stay readable,
- new markets plug in through capabilities instead of rewriting the engine.

## Two Market Classes

The platform currently treats markets in two broad classes.

### Spot-like markets

A market without the `funding` capability is treated as a spot-like market.

Examples today:
- `polymarket`

Behavior:
- Position quantity is non-negative.
- `buy` opens or adds to a position.
- `sell` only reduces or closes an existing position.
- Naked shorting is not allowed.
- Settlement happens through `adapter.resolve()` when the market has a resolution lifecycle.

For prediction markets, directional expression is outcome-based:
- bullish on an outcome: buy that outcome token
- bearish on an outcome: buy the opposite outcome token
- not supported: open a negative inventory short on the same token

For Polymarket specifically:
- asset discovery comes from Gamma
- query search uses Gamma `search-v2`
- browse uses Gamma `/events`
- external discovery results use lightweight market `reference` values, typically Polymarket slugs
- quotes and orderbooks come from the CLOB API
- reference normalization can map a slug or `conditionId` to a concrete outcome `tokenId`
- if you want a specific outcome such as `NO`, pass the corresponding token id explicitly as the reference

### Perp-like markets

A market with the `funding` capability is treated as a perpetual futures market.

Examples today:
- `hyperliquid`

Behavior:
- Position quantity is signed.
- Positive quantity means long.
- Negative quantity means short.
- Leverage is explicit and stored with the position.
- `reduceOnly` is supported.
- Funding can be applied periodically.
- Positions can be liquidated when maintenance margin is breached.

## Order Lifecycle

All state-changing order flows follow the same broad structure.

1. Validate request payload.
2. Resolve the market adapter.
3. Normalize the external reference if the adapter supports normalization.
4. Load reference-level trading constraints.
5. Validate quantity step, minimum quantity, fractional support, and optional max leverage.
6. Fetch a fresh quote.
7. Either fill immediately or store a pending limit order.
8. Persist any agent-submitted prediction snapshot attached to the order.
9. Persist resulting account, order, trade, and position state.
10. Emit SSE events and expose the result through timeline and portfolio reads.

Agent/user order entry runs the trading engine logic. Admin APIs do not place orders on behalf of users; operators observe and fund accounts while agent-owned credentials submit the state-changing order writes.

## Execution Semantics

### Market orders

Market orders fill immediately against the local simulation using directional executable prices.

- `buy` executes at `ask`, falling back to `price` when `ask` is absent
- `sell` executes at `bid`, falling back to `price` when `bid` is absent

The fill is then written into:
- `orders`
- `order_execution_params`
- `trades`
- `accounts`
- `positions`
- `perp_position_state` for leveraged perp positions

### Limit orders

Limit orders are stored as `pending` until the reconciler can fill them.

The reconciler runs in the background and:
- re-reads pending orders
- fetches fresh quotes
- checks whether the executable side price crosses the limit
- fills the order transactionally when the condition is satisfied
- auto-cancels stale orders for symbols that no longer exist upstream

This keeps limit-order behavior deterministic without introducing a full matching engine.

Future evolution:

- the short-term contract remains whole-order fills once the executable price crosses
- a future depth-aware model may be added for markets with `orderbook`
- if that happens, it should use price-time priority and partial fills rather than a simplified FIFO approximation

## Trading Constraints

Every market may expose reference-level constraints through `getTradingConstraints(reference)`.

The engine uses these fields:
- `minQuantity`
- `quantityStep`
- `supportsFractional`
- `maxLeverage`

If a market does not provide custom constraints, unimarket falls back to:
- `minQuantity = 1`
- `quantityStep = 1`
- `supportsFractional = false`
- `maxLeverage = null`

This keeps order validation market-agnostic while still allowing reference-specific precision and leverage rules.

## Spot Position Accounting

Spot fills use a simple inventory model.

- Balance is debited on buys and credited on sells.
- Average cost updates on position increases.
- Selling more than the held quantity is rejected.
- Market value and unrealized PnL are derived from the latest quote.

For prediction markets, this means:
- buy `YES` to express positive conviction
- buy `NO` to express negative conviction
- sell only what is already held

## Perp Position Accounting

Perp fills use signed positions with isolated margin.

### Opening and adding

- `buy` adds positive exposure
- `sell` adds negative exposure
- same-direction adds preserve the existing leverage requirement
- the engine rejects same-direction adds with conflicting leverage

### Reducing and flipping

- an opposite-side order reduces exposure first
- if size exceeds the current position, the remainder flips the position
- `reduceOnly` blocks any action that would expand or flip exposure

### Margin model

Perp positions track:
- `quantity`
- `avgCost`
- `margin`
- `leverage`
- `maintenanceMarginRatio`
- `liquidationPrice`

The current model is isolated margin.

Initial margin is derived from notional and leverage:

```text
notional = abs(quantity) * price
initialMargin = notional / leverage
```

Portfolio reads expose both the raw position and perp-specific risk fields such as margin, maintenance margin, and liquidation price.

## Background Workers

The API process starts four background workers.

### Reconciler

Interval: `RECONCILE_INTERVAL_MS`, default `1000`

Responsibilities:
- fill pending limit orders when quotes cross
- cancel unresolved stale orders for delisted or expired symbols

### Settler

Interval: `SETTLE_INTERVAL_MS`, default `60000`

Responsibilities:
- poll resolution-capable spot markets
- settle resolved positions
- return settlement proceeds to account balance
- delete the settled position

### Funding Collector

Interval: `FUNDING_INTERVAL_MS`, default `3600000`

Responsibilities:
- poll funding-capable markets
- compute funding payments for open perp positions
- write `funding_payments`
- adjust account balance accordingly

### Liquidator

Interval: `LIQUIDATION_INTERVAL_MS`, default `5000`

Responsibilities:
- scan perp positions
- recompute trigger equity and maintenance margin from fresh quotes
- close unsafe positions
- clean up invalid reduce-only orders
- persist liquidation audits and emit liquidation events

## Funding Model

Funding is only relevant to perp-like markets.

The funding collector computes a periodic payment using market funding data and current position size.

Conceptually:

```text
positionValue = quantity * markPrice
payment = -positionValue * fundingRate
```

Implications:
- positive funding usually means longs pay and shorts receive
- negative funding usually means shorts pay and longs receive
- funding accumulates in both account balance and timeline history

## Settlement Model

Settlement is only relevant to markets that expose a resolution lifecycle.

For a resolved spot position:
- the worker reads the market resolution from the adapter
- if a settlement price exists, proceeds are `quantity * settlementPrice`
- proceeds are credited to the account
- the position is deleted
- a settlement trade and SSE event are recorded

This is how prediction-market positions close at event resolution without needing a user-initiated sell.

## Liquidation Model

Liquidation applies only to perp-like markets.

### Trigger condition

A position is unsafe when:

```text
unrealizedPnl = (triggerPrice - avgCost) * quantity
positionEquity = margin + unrealizedPnl
maintenanceMargin = abs(quantity) * triggerPrice * maintenanceMarginRatio
```

Liquidation is triggered when:

```text
positionEquity <= maintenanceMargin
```

### Trigger price vs execution price

The liquidator intentionally separates the trigger price from the execution price.

- `triggerPrice` uses `quote.price`
- `executionPrice` uses the executable side of the book
- long liquidation executes at `bid`, falling back to `price`
- short liquidation executes at `ask`, falling back to `price`

This mirrors normal order execution semantics while keeping trigger logic simple and consistent.

### Settlement semantics

The current liquidation flow uses strict isolated payout semantics.

- remaining equity is recomputed at the execution price
- `grossPayout = max(0, executionEquity)`
- liquidation fee is capped to the remaining payout
- `netPayout = grossPayout - feeCharged`
- the position does not continue consuming unrelated free balance after liquidation

### What happens during liquidation

When a position is liquidated, the system performs a single transaction that:
- re-reads the latest position, perp state, and account
- confirms the position is still unsafe
- inserts a filled liquidation order
- inserts execution params and a trade
- inserts a structured row in `liquidations`
- credits the surviving payout back to the account
- deletes the perp state and open position
- auto-cancels pending `reduceOnly` orders for the same account, market, and symbol

After the transaction commits, the API emits:
- one `order.cancelled` event per cancelled reduce-only order
- one `order.filled` event for the liquidation fill
- one `position.liquidated` event with structured liquidation details

### Current simplifications

The current liquidator is intentionally simple.

- It performs full liquidation, not partial liquidation.
- It does not model insurance funds or ADL.
- It does not implement cross margin.
- It does not maintain a separate mark/index price oracle.
- It does not place a real exchange liquidation order.

These are acceptable tradeoffs for a simulation platform as long as they are documented explicitly.

## Audit Surfaces

unimarket preserves the decision trace across several layers.

### Required reasoning

Agent/user-initiated writes require `reasoning`. Admin credentials are for setup and observation, not proxy order placement.
System workers also persist readable synthetic reasoning for actions such as settlement and liquidation.

### Prediction snapshots and scoring

Agents may attach a `prediction` object to an order with `outcome`, `probability`, optional `conviction`, and optional `thesis`.
The prediction is recorded as submitted agent output; benchmark scores are platform-computed later.

For resolved prediction-market positions, the settler writes versioned prediction scores:
- `brier`: `(probability - settlementPrice)^2`
- `time_to_resolution_hours`: hours between prediction submission and settlement scoring
- `entry_edge`: submitted probability minus entry price for buys, reversed for sells

The dashboard leaderboard uses these platform-computed scores while keeping PnL and forecast quality separate.

### Database records

Important audit tables include:
- `orders`
- `order_execution_params`
- `trades`
- `predictions`
- `prediction_scores`
- `positions`
- `perp_position_state`
- `funding_payments`
- `liquidations`
- `journal`

### Timeline views

Account and admin timelines merge these records into a single feed.

Current timeline event types:
- `order`
- `order.cancelled`
- `journal`
- `funding.applied`
- `position.liquidated`

Liquidation timeline entries hide the backing filled liquidation order so the user sees one clear liquidation record instead of duplicated order noise.

### SSE events

The event stream is the real-time version of the same audit trail.

Current event types:
- `system.ready`
- `order.filled`
- `order.cancelled`
- `position.settled`
- `funding.applied`
- `position.liquidated`

## Practical Interpretation

If you need to reason about the current product quickly, use these rules.

- Adapters provide market data and metadata, not real execution.
- Spot markets simulate inventory and do not allow naked shorting.
- Prediction-market bearish exposure is expressed by buying the opposite outcome token.
- Perp markets simulate signed positions, isolated leverage, funding, and liquidation.
- The reconciler drives pending limit orders.
- The settler drives event-resolution payouts.
- The funding collector applies periodic funding.
- The liquidator closes unsafe perp positions and records a dedicated audit trail.
