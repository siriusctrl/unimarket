---
name: unimarket
description: >
  Paper trading platform API for simulated trading on prediction markets (Polymarket) and more.
  Use when an agent needs to: place simulated trades, check portfolio positions and P&L,
  look up prediction market odds or stock quotes, manage a virtual trading account,
  record trading rationale and observations, or test any trading strategy without real money.
  Markets are discovered at runtime — no hardcoded market knowledge needed.
  Every write operation requires a reasoning field explaining the decision.
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
   { "accountId", "market", "symbol", "side", "type", "quantity",
     "reasoning": "why you're making this trade" }
   → place a trade

6. POST /api/journal
   { "content": "observations, analysis, plans", "tags": ["optional"] }
   → record thoughts between trades

7. GET /api/accounts/:id/portfolio
   → check positions + P&L

8. GET /api/accounts/:id/timeline
   → review full decision history (orders + journal)
```

## Reasoning is Required

Every write operation must include a `reasoning` field explaining the decision:

- `POST /api/orders` → why you're placing this trade
- `DELETE /api/orders/:id` → why you're cancelling
- `POST /api/accounts` → why you're creating this account

This is not optional. Requests without `reasoning` will be rejected.

## Journal

Use the journal for thoughts that aren't tied to a specific trade:

```
POST /api/journal
{ "content": "Noticed correlation between polling shifts and price movement...", "tags": ["analysis"] }
```

Query journal entries:
```
GET /api/journal?limit=5&offset=0          → latest 5 entries
GET /api/journal?q=election                → search content + tags
GET /api/journal?tags=risk-management      → filter by tag
```

`tags` is optional. `content` is required.

## Timeline

The timeline aggregates all activity (orders + journal) for an account in chronological order:

```
GET /api/accounts/:id/timeline?limit=20&offset=0
```

Use this to review the full decision history.

## Auth

Register once, get an API key. Use it for all subsequent requests.

```
POST /api/auth/register  → { apiKey: "pt_live_xxx", account: { id, balance } }
POST /api/auth/keys      → generate additional keys (authenticated)
DELETE /api/auth/keys/:id → revoke a key (authenticated)
```

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

Do not hardcode market IDs — always discover via `/api/markets` first.

## Key Rules

- Accounts start with a fixed initial balance. You cannot deposit funds — only trade with what you have.
- All trades are simulated. No real money moves.
- Market data is real (live quotes from upstream APIs).
- Every write operation requires `reasoning`. No exceptions.
- Markets with `resolve` capability have positions that settle automatically.

## Error Handling

All errors return:
```json
{ "error": { "code": "INSUFFICIENT_BALANCE", "message": "..." } }
```

Common codes: `UNAUTHORIZED`, `INSUFFICIENT_BALANCE`, `INVALID_ORDER`, `MARKET_NOT_FOUND`, `SYMBOL_NOT_FOUND`, `ORDER_NOT_FOUND`, `CAPABILITY_NOT_SUPPORTED`, `REASONING_REQUIRED`.

## Full API Reference

See [references/api.md](references/api.md) for complete endpoint documentation with request/response examples.

## Market-Specific Notes

See [references/markets.md](references/markets.md) for details on individual markets.
