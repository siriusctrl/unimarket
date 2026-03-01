---
name: paper-trade
description: >
  Paper trading platform API for simulated trading on prediction markets (Polymarket) and more.
  Use when an agent needs to: place simulated trades, check portfolio positions and P&L,
  look up prediction market odds or stock quotes, manage a virtual trading account,
  or test any trading strategy without real money.
  Markets are discovered at runtime — no hardcoded market knowledge needed.
  The platform exposes a standard REST API with Bearer token auth.
---

# Paper Trade

## Quick Start

Base URL: `http://<host>:3100/api`

All requests (except register and health) require `Authorization: Bearer <api_key>`.

## Core Workflow

```
1. POST /api/auth/register { "name": "my-agent" }
   → get api_key + first account with initial balance

2. GET /api/markets
   → discover available markets and their capabilities

3. GET /api/markets/{market}/search?q=election
   → find tradeable assets in a market

4. GET /api/markets/{market}/quote?symbol=0x1234
   → get current price

5. POST /api/orders
   { "accountId", "market", "symbol", "side": "buy"|"sell",
     "type": "market"|"limit", "quantity", "limitPrice?" }
   → place a trade

6. GET /api/accounts/:id/portfolio
   → check positions + P&L
```

## Auth

Register once, get an API key. Use it for all subsequent requests.

```
POST /api/auth/register  → { apiKey: "pt_live_xxx", account: { id, balance } }
POST /api/auth/keys      → generate additional keys (authenticated)
DELETE /api/auth/keys/:id → revoke a key (authenticated)
```

Keys are tied to a user. One user can have multiple keys and multiple accounts.

## Market Discovery

Markets are discovered at runtime via `GET /api/markets`:

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

Capabilities tell you which endpoints are available under `/api/markets/{marketId}/`:
- `search` → `GET /api/markets/{id}/search?q={query}`
- `quote` → `GET /api/markets/{id}/quote?symbol={symbol}`
- `orderbook` → `GET /api/markets/{id}/orderbook?symbol={symbol}`
- `resolve` → `GET /api/markets/{id}/resolve?symbol={symbol}`

All market data endpoints use query params. Do not hardcode market IDs — always discover via `/api/markets` first.

## Key Rules

- Accounts start with a fixed initial balance. You cannot deposit funds — only trade with what you have.
- All trades are simulated. No real money moves.
- Market data is real (live quotes from upstream APIs).
- Orders execute against real market prices in a simulated order book.
- Markets with `resolve` capability have positions that settle automatically.

## Error Handling

All errors return:
```json
{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "..." } }
```

Common codes: `UNAUTHORIZED`, `INSUFFICIENT_BALANCE`, `INVALID_ORDER`, `MARKET_NOT_FOUND`, `SYMBOL_NOT_FOUND`, `ORDER_NOT_FOUND`, `CAPABILITY_NOT_SUPPORTED`.

## Full API Reference

See [references/api.md](references/api.md) for complete endpoint documentation with request/response examples.

## Market-Specific Notes

See [references/markets.md](references/markets.md) for details on individual markets (symbol formats, price ranges, settlement mechanics).
