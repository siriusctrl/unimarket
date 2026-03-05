# API Reference

## Table of Contents

- [Auth](#auth)
- [Accounts](#accounts)
- [Orders](#orders)
- [Positions](#positions)
- [Journal](#journal)
- [Market Data](#market-data)
- [Real-Time Events (SSE)](#real-time-events-sse)
- [Admin Endpoints](#admin-endpoints)
- [Health](#health)
- [Error Format](#error-format)

Base URL: `http://<host>:3100/api`

All responses include an `X-API-Version` header with the current server version.

All endpoints except `/api/auth/register` and `/health` require:
```
Authorization: Bearer <api_key>
```

All write operations require a `reasoning` field (string, non-empty).

For safe retries, these write endpoints support `Idempotency-Key`:
- `POST /api/orders`
- `DELETE /api/orders/:id`
- `POST /api/journal`

Order `quantity` is decimal-capable at schema validation. Final acceptance is enforced per market/symbol using:
- `GET /api/markets/:market/trading-constraints?symbol=...`

## Auth

### Register
```
POST /api/auth/register
Content-Type: application/json

{ "userName": "my-agent" }

→ 201
{
  "userId": "usr_xxxx",
  "apiKey": "pt_live_xxxxxxxxxxxx",
  "account": {
    "id": "acc_xxxx",
    "balance": 100000,
    "createdAt": "2026-03-01T00:00:00Z"
  }
}
```

The API key is only shown once at creation time. Store it securely.

### Generate New Key
```
POST /api/auth/keys

→ 201
{
  "id": "key_xxxx",
  "apiKey": "pt_live_yyyyyyyyyyyy",
  "prefix": "pt_live_yy****"
}
```

### Revoke Key
```
DELETE /api/auth/keys/:id

→ 200
{ "revoked": true }
```

## Accounts

### Get Account
```
GET /api/account

→ 200
{
  "id": "acc_xxxx",
  "name": "strategy-alpha",
  "balance": 97500.50,
  "createdAt": "2026-03-01T00:00:00Z"
}
```

### Get Portfolio
```
GET /api/account/portfolio

→ 200
{
  "accountId": "acc_xxxx",
  "balance": 97500.50,
  "positions": [
    {
      "market": "polymarket",
      "symbol": "0x1234...abcd",
      "symbolName": "Will Trump win 2028?",
      "quantity": 100,
      "avgCost": 0.42,
      "currentPrice": 0.48,
      "unrealizedPnl": 6.00,
      "marketValue": 48.00
    }
  ],
  "totalValue": 97548.50,
  "totalPnl": -2451.50
}
```

### Get Timeline
```
GET /api/account/timeline?limit=20&offset=0

→ 200
{
  "events": [
    {
      "type": "order",
      "data": {
        "id": "ord_xxxx",
        "side": "buy",
        "symbol": "0x1234...abcd",
        "quantity": 100,
        "filledPrice": 0.42,
        "status": "filled"
      },
      "reasoning": "Market overpricing NO at 0.58, polling suggests YES ~55%",
      "createdAt": "2026-03-01T12:00:01Z"
    },
    {
      "type": "journal",
      "data": {
        "id": "jrn_xxxx",
        "content": "Debate tonight — expecting volatility, will hold current positions",
        "tags": ["election", "risk-management"]
      },
      "createdAt": "2026-03-01T11:30:00Z"
    },
    {
      "type": "order.cancelled",
      "data": {
        "id": "ord_yyyy",
        "symbol": "0x5678...efgh",
        "side": "buy",
        "cancelledAt": "2026-03-01T10:00:00Z"
      },
      "reasoning": "New information invalidated the thesis — withdrawing limit order",
      "createdAt": "2026-03-01T10:00:00Z"
    }
  ]
}
```

## Orders

### Place Order
```
POST /api/orders
Content-Type: application/json
Idempotency-Key: <optional-unique-key>

{
  "market": "polymarket",
  "symbol": "0x1234...abcd",
  "side": "buy",
  "type": "market",
  "quantity": 100,
  "reasoning": "Market overpricing NO at 0.58, recent polling data suggests YES probability ~55%"
}

→ 201
{
  "id": "ord_xxxx",
  "accountId": "acc_xxxx",
  "market": "polymarket",
  "symbol": "0x1234...abcd",
  "side": "buy",
  "type": "market",
  "quantity": 100,
  "status": "filled",
  "filledPrice": 0.42,
  "reasoning": "Market overpricing NO at 0.58, recent polling data suggests YES probability ~55%",
  "filledAt": "2026-03-01T00:00:01Z"
}
```

For limit orders, add `"limitPrice": 0.40`. Status will be `"pending"` until filled or cancelled.
`accountId` is optional. If provided, it must match the caller's own account.
`quantity` can be decimal, but it must satisfy the selected symbol's constraints (`minQuantity`, `quantityStep`, `supportsFractional`).
For perpetual markets, `leverage` must also satisfy symbol `maxLeverage`.

### List Orders
```
GET /api/orders?accountId=acc_xxxx&status=filled&market=polymarket

→ 200
{ "orders": [...] }
```

Query params (all optional): `accountId`, `view` (`all|open|history`), `status` (`pending|filled|cancelled|rejected`), `market`, `symbol`, `limit`, `offset`.

### Cancel Order
```
DELETE /api/orders/:id
Content-Type: application/json
Idempotency-Key: <optional-unique-key>

{ "reasoning": "New information invalidated the thesis" }

→ 200
{ "id": "ord_xxxx", "status": "cancelled" }
```

Only pending orders can be cancelled.

### Reconcile Pending Orders (Optional Manual Trigger)
```
POST /api/orders/reconcile
Content-Type: application/json

{ "reasoning": "need deterministic immediate pending-order state" }

→ 200
{
  "processed": 3,
  "filled": 1,
  "cancelled": 0,
  "skipped": 2,
  "filledOrderIds": ["ord_xxxx"],
  "cancelledOrderIds": []
}
```

Notes:
- The server already runs a background reconciler (default interval `RECONCILE_INTERVAL_MS=1000`).
- Use this endpoint only when you need immediate deterministic convergence for pending limit orders.
- For normal state reads, use `GET /api/orders`, `GET /api/positions`, and `GET /api/account/portfolio`.

## Positions

### List Positions
```
GET /api/positions?accountId=acc_xxxx

→ 200
{ "positions": [...] }
```

`accountId` is optional. For non-admin keys, only the caller's own account is accessible.

## Journal

### Write Entry
```
POST /api/journal
Content-Type: application/json
Idempotency-Key: <optional-unique-key>

{
  "content": "Noticed correlation between polling shifts and election market price movement. Will monitor for entry opportunity below 0.40.",
  "tags": ["analysis", "election"]
}

→ 201
{
  "id": "jrn_xxxx",
  "userId": "usr_xxxx",
  "content": "...",
  "tags": ["analysis", "election"],
  "createdAt": "2026-03-01T12:00:00Z"
}
```

`content` is required. `tags` is optional.

### List Entries
```
GET /api/journal?limit=5&offset=0
GET /api/journal?q=election
GET /api/journal?tags=risk-management

→ 200
{ "entries": [...] }
```

Default `limit=20`. Supports `offset` for pagination, `q` for full-text search, `tags` for filtering.

## Market Data

All market data endpoints use query params.

### List Markets
```
GET /api/markets

→ 200
{
  "markets": [
    {
      "id": "polymarket",
      "name": "Polymarket",
      "description": "Prediction markets — contracts resolve to $0 or $1",
      "symbolFormat": "Condition ID or token ID",
      "priceRange": [0.01, 0.99],
      "capabilities": ["search", "quote", "orderbook", "resolve"]
    }
  ]
}
```

### Search / Browse Assets
```
GET /api/markets/polymarket/search?q=trump+election
GET /api/markets/polymarket/search?limit=20&offset=0

→ 200
{
  "results": [
    {
      "symbol": "0x1234...abcd",
      "name": "Will Trump win the 2028 presidential election?",
      "price": 0.42,
      "volume": 1500000,
      "metadata": {
        "conditionId": "0x1234...abcd",
        "tokenIds": ["123...", "456..."],
        "outcomes": ["Yes", "No"],
        "outcomePrices": [0.42, 0.58],
        "defaultTokenId": "123..."
      }
    }
  ]
}
```

`q` is optional — omit it to browse all active contracts. Supports `limit` (default 20, max 100) and `offset` (default 0) for pagination.
For Polymarket, `search` returns condition IDs that can be used directly in `quote`, `orderbook`, and `orders`.
If you need explicit YES/NO token selection, use `results[].metadata.tokenIds` and `results[].metadata.outcomes`.

### Get Trading Constraints
```
GET /api/markets/hyperliquid/trading-constraints?symbol=btc-perp

→ 200
{
  "symbol": "BTC",
  "constraints": {
    "minQuantity": 0.00001,
    "quantityStep": 0.00001,
    "supportsFractional": true,
    "maxLeverage": 50
  }
}
```

Use this endpoint before placing orders to validate quantity/leverage inputs.
If `supportsFractional` is `false`, quantity must be an integer (for example, Polymarket returns step `1`).

### Get Quote
```
GET /api/markets/polymarket/quote?symbol=0x1234...abcd

→ 200
{
  "symbol": "0x1234...abcd",
  "price": 0.42,
  "bid": 0.41,
  "ask": 0.43,
  "volume": 1500000,
  "timestamp": "2026-03-01T00:00:00Z"
}
```

### Get Quotes (Batch)
```
GET /api/markets/polymarket/quotes?symbols=0x1234...abcd,0x5678...efgh

→ 200
{
  "quotes": [
    { "symbol": "0x1234...abcd", "price": 0.42, "bid": 0.41, "ask": 0.43, "timestamp": "2026-03-01T00:00:00Z" }
  ],
  "errors": [
    { "symbol": "0x5678...efgh", "error": { "code": "SYMBOL_NOT_FOUND", "message": "..." } }
  ]
}
```

`symbols` is a comma-separated list (up to 50 unique symbols).

### Get Orderbook
```
GET /api/markets/polymarket/orderbook?symbol=0x1234...abcd

→ 200
{
  "bids": [{ "price": 0.41, "size": 5000 }, ...],
  "asks": [{ "price": 0.43, "size": 3000 }, ...]
}
```

### Get Orderbooks (Batch)
```
GET /api/markets/polymarket/orderbooks?symbols=0x1234...abcd,0x5678...efgh

→ 200
{
  "orderbooks": [
    { "symbol": "0x1234...abcd", "bids": [...], "asks": [...], "timestamp": "2026-03-01T00:00:00Z" }
  ],
  "errors": [
    { "symbol": "0x5678...efgh", "error": { "code": "SYMBOL_NOT_FOUND", "message": "..." } }
  ]
}
```

`symbols` is a comma-separated list (up to 50 unique symbols).

### Get Funding Rate
```
GET /api/markets/<market>/funding?symbol=<symbol>

→ 200
{
  "symbol": "BTC",
  "rate": 0.0002,
  "nextFundingAt": "2026-03-01T01:00:00.000Z",
  "timestamp": "2026-03-01T00:32:10.000Z"
}
```

Only available on markets where `capabilities` includes `funding`.

### Get Funding Rates (Batch)
```
GET /api/markets/<market>/fundings?symbols=btc,eth,missing

→ 200
{
  "fundings": [
    { "symbol": "BTC", "rate": 0.0002, "nextFundingAt": "2026-03-01T01:00:00.000Z", "timestamp": "2026-03-01T00:32:10.000Z" }
  ],
  "errors": [
    { "symbol": "missing", "error": { "code": "SYMBOL_NOT_FOUND", "message": "..." } }
  ]
}
```

`symbols` is a comma-separated list (up to 50 unique symbols).

### Check Resolution
```
GET /api/markets/polymarket/resolve?symbol=0x1234...abcd

→ 200
{ "symbol": "0x1234...abcd", "resolved": false, "outcome": null }

// or when resolved:
{ "symbol": "0x1234...abcd", "resolved": true, "outcome": "yes", "settlementPrice": 1.00 }
```

## Real-Time Events (SSE)

```
GET /api/events
Authorization: Bearer <api_key>
```

On connect, the first event is `system.ready`.
User-scoped trading events include monotonic `id` values.

Resume from the last seen event:
```
GET /api/events?since=<event_id>
```

Or:
```
Last-Event-ID: <event_id>
GET /api/events
```

Example stream payloads:
```
data: {"type":"system.ready","data":{"version":"2.0.0","connectedAt":"2026-03-02T12:00:00.000Z"}}
data: {"type":"order.filled","userId":"usr_xxx","accountId":"acc_xxx","orderId":"ord_xxx","data":{...}}
data: {"type":"order.cancelled","userId":"usr_xxx","accountId":"acc_xxx","orderId":"ord_xxx","data":{...}}
data: {"type":"position.settled","userId":"usr_xxx","accountId":"acc_xxx","data":{...}}
data: {"type":"funding.applied","userId":"usr_xxx","accountId":"acc_xxx","data":{...}}
```

Event types:
- `system.ready` — emitted on connect with server version and connection timestamp
- `order.filled` — emitted when an order executes
- `order.cancelled` — emitted when a pending order is cancelled
- `position.settled` — emitted when a position settles
- `funding.applied` — emitted when periodic funding is applied to an open position

## Admin Endpoints

Require admin key in `Authorization: Bearer <admin_key>` header.

### Deposit
```
POST /api/admin/users/:id/deposit
Content-Type: application/json

{ "amount": 50000 }

→ 200
{ "balance": 147500.50 }
```

### Withdraw
```
POST /api/admin/users/:id/withdraw
Content-Type: application/json

{ "amount": 10000 }

→ 200
{ "balance": 137500.50 }
```

## Health
```
GET /health

→ 200
{ "status": "ok", "version": "2.0.0", "markets": { "polymarket": "available" } }
```

## Error Format

All errors use:
```json
{ "error": { "code": "SOME_CODE", "message": "..." } }
```

Common codes:
- `UNAUTHORIZED`
- `INVALID_JSON`
- `INVALID_INPUT`
- `REASONING_REQUIRED`
- `MARKET_NOT_FOUND`
- `SYMBOL_NOT_FOUND`
- `CAPABILITY_NOT_SUPPORTED`
- `ACCOUNT_NOT_FOUND`
- `ORDER_NOT_FOUND`
- `INVALID_ORDER`
- `INSUFFICIENT_BALANCE`
- `INSUFFICIENT_POSITION`
