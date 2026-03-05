# API Reference

## Auth
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/auth/register` | — | Register (`userName`), get first API key + default account |
| `POST` | `/api/auth/keys` | key | Generate additional API key |
| `DELETE` | `/api/auth/keys/:id` | key | Revoke a key |

## Accounts
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/account` | key | Get current user's default account details |
| `GET` | `/api/account/portfolio` | key | Current user's portfolio summary with P&L and accumulated funding |
| `GET` | `/api/account/timeline` | key | Current user's timeline (orders + journal + funding events) |

## Trading
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/orders` | key | Place an order (requires `reasoning`; supports `Idempotency-Key`; `quantity` is validated per market/symbol constraints) |
| `GET` | `/api/orders` | key | List orders (`view=open|history|all`) |
| `GET` | `/api/orders/:id` | key | Get a single order by id |
| `POST` | `/api/orders/reconcile` | key/admin | Optional manual reconcile trigger for pending limit orders (requires `reasoning`) |
| `DELETE` | `/api/orders/:id` | key | Cancel an order (requires `reasoning`; supports `Idempotency-Key`) |

Order sizing behavior:
- `quantity` accepts decimal values at schema layer.
- Markets enforce final rules per symbol: `minQuantity`, `quantityStep`, `supportsFractional`, and optional `maxLeverage`.
- If a market does not provide custom constraints, defaults are `minQuantity=1`, `quantityStep=1`, `supportsFractional=false`, `maxLeverage=null`.

## Real-Time Events
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/events` | key | Subscribe to SSE events; supports replay via `Last-Event-ID` or `?since=` |

## Positions
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/positions` | key | List open positions |

## Journal
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `POST` | `/api/journal` | key | Write a journal entry (supports `Idempotency-Key`) |
| `GET` | `/api/journal` | key | List entries (`?limit=5&offset=0&q=&tags=`) |

## Market Data
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/markets` | key | List markets + capabilities |
| `GET` | `/api/markets/:market/search` | key | Search or browse assets (`?q=&limit=20&offset=0`, default 20, max 100) |
| `GET` | `/api/markets/:market/trading-constraints` | key | Get symbol-level order constraints (`?symbol=`) including `minQuantity`, `quantityStep`, `supportsFractional`, `maxLeverage` |
| `GET` | `/api/markets/:market/quote` | key | Get quote (`?symbol=`) |
| `GET` | `/api/markets/:market/quotes` | key | Get quotes in batch (`?symbols=s1,s2,...`, up to 50) |
| `GET` | `/api/markets/:market/orderbook` | key | Get orderbook (`?symbol=`) |
| `GET` | `/api/markets/:market/orderbooks` | key | Get orderbooks in batch (`?symbols=s1,s2,...`, up to 50) |
| `GET` | `/api/markets/:market/funding` | key | Get funding rate (`?symbol=`) for markets with `funding` capability |
| `GET` | `/api/markets/:market/fundings` | key | Get funding rates in batch (`?symbols=s1,s2,...`, up to 50) |
| `GET` | `/api/markets/:market/resolve` | key | Check settlement (`?symbol=`) |

Hyperliquid notes:
- Fractional quantity support is symbol-specific and derived from `szDecimals`.
- Per-symbol `maxLeverage` is enforced for leveraged perp orders.

## Meta
| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/health` | — | Health check (includes API version) |

Runtime env loading:
- API loads repo-root `.env.local` first, then `.env`.
- Existing process environment variables keep highest priority.
- Fee configuration uses `DEFAULT_TAKER_FEE_RATE` with optional `${MARKET}_TAKER_FEE_RATE` overrides (for example `HYPERLIQUID_TAKER_FEE_RATE`).
