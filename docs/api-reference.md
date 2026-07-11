# API Reference

This reference lists the current HTTP and SSE surfaces. For system behavior and accounting semantics, read [Trading Model](trading-model.md). For operator workflows, read [Admin Guide](admin-guide.md).

## Auth

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/auth/register` | — | Register a user with `{ "userName": "..." }`, create the default account, and return the first API key |
| `POST` | `/api/auth/keys` | key | Create an additional API key for the current user |
| `DELETE` | `/api/auth/keys/:id` | key | Revoke an API key |

## Accounts

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/account` | key | Get the current user's default account |
| `GET` | `/api/account/portfolio` | key | Get balances, open positions, open orders, unrealized PnL, funding totals, and perp risk fields |
| `GET` | `/api/account/timeline` | key | Get the user's unified audit feed |

### `GET /api/account/portfolio`

Portfolio read-model notes:
- position rows may include `symbolName` when the market adapter can resolve a human-readable label for `symbol`
- prediction-market position rows may include `side` with the resolved outcome label such as `Yes` or `No`
- order rows in `openOrders` and `recentOrders` may include `symbolName` and `outcome` for the same reason
- responses include a `valuation` summary with `status`, `issues`, priced/unpriced position counts, and known marked-value/PnL totals
- factual positions are preserved even when a quote is unavailable; in that case per-position derived values remain `null`
- `totalValue` and `totalPnl` are `null` whenever valuation is partial instead of silently dropping unpriced positions

### `GET /api/account/timeline`

Query params:
- `limit`, default pagination behavior from shared schema
- `offset`

Current timeline event types:
- `order`
- `order.cancelled`
- `journal`
- `funding.applied`
- `position.liquidated`

Notes:
- liquidation timeline entries are sourced from the dedicated `liquidations` audit table
- the backing filled liquidation order is hidden from timeline results to avoid duplicate entries
- Polymarket timeline items try to resolve human-readable market names and outcomes
- the timeline record shape is shared with the dashboard through `@unimarket/core`

## Trading

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/orders` | key | Place an order |
| `GET` | `/api/orders` | key | List orders (`view=open|history|all`) |
| `GET` | `/api/orders/:id` | key | Fetch a single order |
| `DELETE` | `/api/orders/:id` | key | Cancel a pending order |

### Order payload notes

Required fields:
- `market`
- `reference`
- `side`
- `type`
- `quantity`
- `reasoning`

Optional fields:
- `limitPrice`
- `leverage`
- `reduceOnly`
- `prediction`

Rules:
- `reasoning` is required for state-changing writes
- `prediction` is an immutable agent-submitted forecast snapshot; scoring is computed later by the platform
- prediction payload fields:
  - `outcome`: agent's named outcome for the probability
  - `probability`: number from `0` to `1`
  - `conviction`: optional number from `0` to `1`
  - `thesis`: optional short thesis text
- `leverage` and `reduceOnly` are valid only for perp markets
- quantity is validated against per-reference trading constraints
- normal market-order execution uses directional executable prices: `buy -> ask`, `sell -> bid`
- limit orders remain `pending` until the background reconciler fills or cancels them
- when `market` + `symbol` filters require symbol normalization and normalization fails, `GET /api/orders` returns an explicit error instead of an empty result

## Positions

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/positions` | key | List open positions |

## Journal

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/journal` | key | Create a journal entry |
| `GET` | `/api/journal` | key | List journal entries (`limit`, `offset`, optional filters) |

## Market Data

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/markets` | key or admin | Discover registered markets, capabilities, browse options, and price-history defaults |
| `GET` | `/api/markets/:market/search` | key or admin | Search market references |
| `GET` | `/api/markets/:market/browse` | key or admin | Browse active market references |
| `GET` | `/api/markets/:market/trading-constraints` | key or admin | Get reference-level quantity and leverage constraints |
| `GET` | `/api/markets/:market/quote` | key or admin | Get one enriched quote |
| `GET` | `/api/markets/:market/quotes` | key or admin | Get enriched quotes in batch |
| `GET` | `/api/markets/:market/orderbook` | key or admin | Get one orderbook |
| `GET` | `/api/markets/:market/orderbooks` | key or admin | Get orderbooks in batch |
| `GET` | `/api/markets/:market/funding` | key or admin | Get one funding rate for funding-capable markets |
| `GET` | `/api/markets/:market/fundings` | key or admin | Get funding rates in batch |
| `GET` | `/api/markets/:market/price-history` | key or admin | Get historical candles, resolved range, and summary metrics |
| `GET` | `/api/markets/:market/resolve` | key or admin | Get settlement or resolution status |

## Chart Analysis

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/analysis/schema` | public | Discover protocol, drawing, and indicator capabilities |
| `GET` | `/api/analysis/context` | public | Fetch candles, snapshot hash, deterministic indicators, and data-quality metadata |
| `POST` | `/api/analysis/validate` | key or admin | Validate and normalize a chart-analysis document without persistence |
| `GET` | `/api/analysis/documents` | public | List stored documents with optional `market`, `reference`, and `status` filters |
| `POST` | `/api/analysis/documents` | key or admin | Create a draft after validating its candle snapshot |
| `GET` | `/api/analysis/documents/:id` | public | Read one stored revision |
| `PUT` | `/api/analysis/documents/:id` | owning key or admin | Replace a draft; published revisions are immutable |
| `POST` | `/api/analysis/documents/:id/publish` | owning key or admin | Publish a draft with reasoning |
| `GET` | `/api/analysis/documents/:id/render-metadata` | public | Inspect drawing anchors and clipping against the declared viewport |

Context example:

```http
GET /api/analysis/context?market=hyperliquid&reference=xyz:MU&interval=1d&lookback=1y
```

The `unimarket.chart-context/v1` response includes canonical candles, a `sha256:` snapshot hash, market summary, deterministic indicator output, data quality, and supported drawing primitives. `/api/analysis/schema` exposes required document fields plus the coordinate and parameter contract for every layer type.

Document writes use `unimarket.chart-analysis/v1`. Supported drawings are `horizontalLine`, `verticalLine`, `trendLine`, `ray`, `channel`, `rectangle`, `marker`, and `text`. Supported indicators are `sma`, `ema`, `rsi`, `atr`, `macd`, `bollingerBands`, and explicitly labeled `volumeProfile` with `ohlcv-range-approximation`.

Create bodies contain `document`, non-empty `reasoning`, and optional `supersedesId`. The API replaces `metadata.createdBy.actorId` with the authenticated identity. It rejects mismatched candle hashes with `409 SNAPSHOT_MISMATCH`, instrument changes on a draft, and every update to a published document.

Analysis reads, including drafts, are intentionally public so a deployed renderer can preview an exact `documentId` before publication. Do not place credentials or private research in an analysis document.

### Search and browse contract

- `search` requires a non-empty `q`
- `search` accepts an optional `sort`
- `browse` is explicit and accepts a market-specific `sort` string
- browse options and explicit search sort options are discoverable from `GET /api/markets`
- invalid `sort` values return `400 INVALID_INPUT`
- adapters may enrich sparse upstream search previews before returning discovery results
- both endpoints return paginated discovery payloads shaped like:

```json
{
  "results": [
    {
      "reference": "btc",
      "name": "BTC-PERP",
      "price": 94321.1,
      "volume": 12003455.2,
      "liquidity": 882100.4,
      "endDate": null,
      "fundingPreview": {
        "rate": 0.0001,
        "nextFundingAt": "2026-03-16T10:00:00.000Z",
        "timestamp": "2026-03-16T09:42:00.000Z",
        "direction": "long_pays_short",
        "intervalHours": 1,
        "annualizedRate": 0.876
      },
      "metadata": {}
    }
  ],
  "hasMore": true
}
```

- discovery results are not required to be execution-ready exchange ids
- adapters normalize the supplied `reference` lazily when `quote`, `orderbook`, `resolve`, `price-history`, or order placement is called
- funding-capable markets may include a structured `fundingPreview` on discovery results when preview data is available
- `annualizedRate` is a simple APR reference derived from the market funding cadence, not a compounded yield
- Polymarket discovery metadata may include `outcomeTokenIds` aligned with `outcomes`, which lets dashboards map outcome buttons like `Yes` and `No` to concrete token references

### Market descriptor notes

`GET /api/markets` returns per-market discovery metadata, including:
- `capabilities`
- `browseOptions`
- `searchSortOptions`
- `priceHistory` or `null`

When present, `priceHistory` includes:
- `nativeIntervals`
- `supportedIntervals`
- `defaultInterval`
- `supportedLookbacks`
- `defaultLookbacks`
- `maxCandles`
- `supportsCustomRange`
- `supportsResampling`

### Trading constraints response

Example:

```json
{
  "reference": "BTC",
  "constraints": {
    "minQuantity": 0.00001,
    "quantityStep": 0.00001,
    "supportsFractional": true,
    "maxLeverage": 50
  }
}
```

Every registered adapter defines these constraints. The API does not invent defaults for an incomplete adapter implementation; a missing or invalid adapter contract is an internal server error.

### Quote response

Example:

```json
{
  "reference": "BTC",
  "price": 94321.1,
  "bid": 94320.9,
  "ask": 94321.3,
  "mid": 94321.1,
  "spreadAbs": 0.4,
  "spreadBps": 0.042408309301,
  "timestamp": "2026-03-08T00:00:00.000Z"
}
```

Notes:
- `price` is the execution-facing reference price
- `mid` falls back to `price` when either side is missing
- `spreadAbs` and `spreadBps` are `null` when both sides are not available
- use discovery `fundingPreview` for shortlist preparation and `GET /api/markets/:market/funding` for an explicit fresh funding read

### Funding response

Example:

```json
{
  "reference": "BTC",
  "rate": 0.0001,
  "nextFundingAt": "2026-03-08T01:00:00.000Z",
  "timestamp": "2026-03-08T00:00:00.000Z",
  "direction": "long_pays_short",
  "intervalHours": 1,
  "annualizedRate": 0.876
}
```

### Price history response

Preferred query:

```http
GET /api/markets/:market/price-history?reference=BTC&interval=1h&lookback=7d
```

Advanced custom range:

```http
GET /api/markets/:market/price-history?reference=BTC&interval=1h&startTime=2026-03-01T00:00:00.000Z&endTime=2026-03-08T00:00:00.000Z
```

Rules:
- use `lookback` for the common case
- use `asOf` only to anchor reproducible historical analysis
- use either `lookback` or `startTime + endTime`
- read supported intervals and defaults from `GET /api/markets` before requesting candles

Example response shape:

```json
{
  "reference": "iran-hormuz",
  "interval": "4h",
  "resampledFrom": "1h",
  "range": {
    "mode": "lookback",
    "lookback": "30d",
    "asOf": "2026-03-08T00:00:00.000Z",
    "startTime": "2026-02-06T00:00:00.000Z",
    "endTime": "2026-03-08T00:00:00.000Z"
  },
  "candles": [],
  "summary": {
    "open": null,
    "close": null,
    "change": null,
    "changePct": null,
    "high": null,
    "low": null,
    "volume": null,
    "candleCount": 0
  }
}
```

## Real-Time Events

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/events` | key | Subscribe to the user's SSE event stream |

The SSE stream starts with:
- `system.ready`

Current user-scoped event types:
- `order.filled`
- `order.cancelled`
- `position.settled`
- `funding.applied`
- `position.liquidated`

Replay is supported through:
- `Last-Event-ID`
- `?since=<event_id>`

### `position.liquidated` event data

The structured liquidation event includes:
- `liquidationId`
- `market`
- `symbol`
- `side`
- `quantity`
- `triggerPrice`
- `executionPrice`
- `triggerPositionEquity`
- `maintenanceMargin`
- `grossPayout`
- `feeCharged`
- `netPayout`
- `cancelledReduceOnlyOrderIds`
- `liquidatedAt`

Note:
- timeline and settlement/liquidation audit surfaces still expose internal normalized `symbol` fields because accounting is stored against resolved execution identifiers

## Admin API

The full operator workflow is documented in [Admin Guide](admin-guide.md). The main admin-only endpoints are:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/admin/users/:id/deposit` | Add funds to a user's default account |
| `POST` | `/api/admin/users/:id/withdraw` | Remove funds from a user's default account |
| `POST` | `/api/admin/traders` | Create a dedicated agent user + default account |
| `GET` | `/api/admin/users/:id/portfolio` | Get one user's current balance, positions, open orders, and recent orders |
| `GET` | `/api/admin/users/:id/symbol-trades` | Get one user's recent trades for a specific market symbol |

All admin endpoints require `Authorization: Bearer <ADMIN_API_KEY>`.

## Dashboard Read API

The dashboard reads anonymous observation endpoints. These routes are read-only and do not require an admin key:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/dashboard/overview` | Get cross-user portfolio, valuation, market summary, and prediction leaderboard |
| `GET` | `/api/dashboard/equity-history` | Get historical equity snapshots by user |
| `GET` | `/api/dashboard/users/:id/timeline` | Get one user's unified audit feed |

Admin read-model notes:
- `GET /api/dashboard/overview` is read-only and does not write equity snapshots as a side effect
- `GET /api/dashboard/equity-history` is backed by the background equity snapshotter worker
- `GET /api/admin/users/:id/portfolio` mirrors the user portfolio read-model, including optional `symbolName`, prediction-market `side`, and order-level `outcome` labels when adapters can resolve them
- overview and admin portfolio reads expose explicit partial valuation state instead of silently omitting unpriced positions
- `GET /api/admin/users/:id/symbol-trades` returns a normalization error when the requested symbol cannot be resolved for that market

Admin execution boundary:
- the admin API does not expose order placement on behalf of users
- agents place orders with their own user credentials through `POST /api/orders`
- admin reads still show resulting positions, open orders, recent orders, trades, and timeline events

## Meta

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | — | Health check including API version |

## Runtime Configuration

The API loads environment variables from repo root in this order:
- `.env.local`
- `.env`

Existing process environment variables keep highest priority.

Relevant runtime settings:
- `RECONCILE_INTERVAL_MS`
- `SETTLE_INTERVAL_MS`
- `FUNDING_INTERVAL_MS`
- `LIQUIDATION_INTERVAL_MS`
- `EQUITY_SNAPSHOT_INTERVAL_MS`
- `MAINTENANCE_MARGIN_RATIO`
- `DEFAULT_TAKER_FEE_RATE`
- `${MARKET}_TAKER_FEE_RATE`
- `SERVE_WEB_DIST`
