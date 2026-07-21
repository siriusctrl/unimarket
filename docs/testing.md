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

The script starts isolated API, Vite, and persistent renderer processes, fetches live `xyz:MU` daily candles from Hyperliquid, creates a model-neutral draft, and renders that exact snapshot once. It validates the candle hash plus visible, clipped, and volume-profile counts from bounded response headers, then publishes and writes JSON, screenshot, and per-service logs under `artifacts/analysis/<timestamp>/`.

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

The smoke workflow now lives in `scripts/smoke-api.sh` so documentation and the
executable check cannot drift. It requires `curl`, `jq`, a running API, and live
public market connectivity.

```bash
corepack pnpm smoke:api
```

Use a non-default API or include protected admin checks with:

```bash
BASE_URL=http://localhost:3200 \
ADMIN_API_KEY=your-secret-key \
corepack pnpm smoke:api
```

The script registers a temporary user, discovers a live tradeable reference,
reads advertised capabilities, uses the adapter's minimum quantity, places one
market order, places and cancels a non-marketable limit order, checks account
and timeline reads, verifies negative contracts, and optionally exercises admin
deposit/withdraw/read behavior. It removes its temporary response files, while
the created paper-trading records remain in the configured database.

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
