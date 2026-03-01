# AGENTS.md

Guidelines for AI agents working on this codebase.

## Architecture

Single-process TypeScript monorepo (pnpm workspaces). Hono serves both REST API and frontend static files on :3100.

```
packages/
├── core/      # Pure logic, no I/O. Zod schemas shared across stack.
├── markets/   # Market adapters. Unified interface, registered at startup.
├── api/       # Hono server. DB operations, auth, routing.
└── web/       # Vite + React SPA. Built output served by api/.
```

## Rules

- **core/ must stay pure.** No database calls, no HTTP requests, no side effects. Only types, Zod schemas, and functions that take data in and return data out.
- **Zod schemas are the single source of truth** for request/response types. Define once in core/, infer types with `z.infer<>`, use everywhere.
- **Market adapters implement `MarketAdapter` interface** from `packages/markets/types.ts`. Adding a market = adding an adapter + registering it. No changes to core/ or api/ routes needed.
- **Polymarket first.** The initial implementation focuses on Polymarket. US stocks and other markets come later as additional adapters.
- **Runtime market discovery.** `GET /api/markets` returns available markets + capabilities. Agents discover what's available, no hardcoding.
- **All market data endpoints use query params** (`?symbol=`, `?q=`). Path params are for resource IDs only (`/accounts/:id`, `/orders/:id`).
- **Admin vs public API separation.** Deposit/withdraw are admin-only (`/api/admin/*`). Regular API keys can only create accounts and trade.
- **Auth: API key → userId mapping.** We store keyHash + userId. We don't manage key rotation strategy — that's the caller's problem.
- **SQLite via Drizzle.** Single file DB. Migrations in `packages/api/db/`.
- **Quote caching.** Market adapters should cache upstream API responses (TTL ~10s for quotes, ~5min for market lists) to avoid rate limits.

## Data Model

```
users       → id, name, createdAt
api_keys    → id, userId, keyHash, prefix, createdAt, revokedAt
accounts    → id, userId, balance, name, createdAt
orders      → id, accountId, market, symbol, side, type, quantity, limitPrice, status, filledPrice, filledAt, createdAt
positions   → id, accountId, market, symbol, quantity, avgCost
trades      → id, orderId, accountId, market, symbol, side, quantity, price, createdAt
```

## Code Style

- Prefer `const` and arrow functions.
- Use Zod for all external input validation. Never trust raw input.
- Error responses follow `{ error: { code: string, message: string } }` shape.
- Use descriptive error codes: `UNAUTHORIZED`, `INSUFFICIENT_BALANCE`, `INVALID_ORDER`, `MARKET_NOT_FOUND`, `CAPABILITY_NOT_SUPPORTED`, etc.
- Tests go next to source files (`foo.ts` → `foo.test.ts`). Use Vitest.
- No `any`. If you need an escape hatch, use `unknown` and narrow.

## Commit Style

- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- Keep commits atomic. One logical change per commit.

## Testing

- Core logic: unit tests with plain assertions, no mocks needed (pure functions).
- Market adapters: mock HTTP responses, don't hit real APIs in tests.
- API routes: use Hono's test client (`app.request()`).
- Run `pnpm test` before pushing.

## Common Pitfalls

- Don't put DB logic in core/. If you need persistence, it goes in api/.
- Don't import from api/ or web/ inside core/ or markets/. Dependency flow is one-way: api → core, api → markets, web → (HTTP calls to api).
- Don't add `express`, `fastify`, or `next` — we use Hono + Vite.
- Don't use `node-fetch` — use native `fetch` (Node 18+).
- Don't hardcode market IDs in routes. Use the adapter registry.
