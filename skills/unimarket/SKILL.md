---
name: unimarket
description: Agent-run multi-market paper trading workflow using the Unimarket REST API. Use when Codex needs to register an agent user, discover markets dynamically, inspect quotes, orderbooks, price history, funding, or resolution data, place or cancel paper orders with the agent/user API key, review account state, write journal entries, or consume SSE events against Unimarket. Admin credentials are for setup, while dashboards are for observation and review, not proxy order placement.
---

# Unimarket

Base URL:
- `http://<host>:3100/api`

Authentication:
- Send `Authorization: Bearer <api_key>` on agent/user endpoints.
- Register, health, and dashboard read endpoints are intentionally unauthenticated.

## Fast Path

1. Register once with helper `register-safe` when you need unattended credential bootstrap, or `POST /api/auth/register` for raw API use.
2. Discover market IDs, capabilities, browse sorts, explicit search sort options, and price-history defaults with `markets-summary` or `GET /api/markets`.
3. Browse or search market records:
   - `GET /api/markets/{market}/browse`
   - `GET /api/markets/{market}/search?q=...`
   - optional override: `GET /api/markets/{market}/search?q=...&sort=...`
4. Persist the returned `reference`; treat it as the only external market identifier.
5. Read execution and sizing context before order writes:
   - `GET /api/markets/{market}/trading-constraints?reference=...`
   - `GET /api/markets/{market}/quote?reference=...`
   - optional `orderbook`, `price-history`, `funding`, `resolve`
6. Use `analysis-context` and the versioned analysis-document commands when a thesis needs reproducible indicators or chart drawings.
7. Prefer helper workflow commands such as `snapshot`, `orders-open`, `history-summary`, and `scan` for deterministic endpoint work.
8. Place or cancel orders with non-empty `reasoning`; attach `prediction` when making a forecast-backed order.
9. Audit with `orders`, `positions`, `portfolio`, `timeline`, `journal`, and `events`.

## Operating Rules

- Discover `market`, `browseOptions`, `searchSortOptions`, and `priceHistory` support from `GET /api/markets`; do not hardcode markets, references, intervals, or sort keys.
- Prefer `browse` for blank exploration; use `search` only with a concrete non-empty query.
- When `searchSortOptions` is empty, rely on the market's default search ordering. When explicit search sort options exist, send `sort` only when you intentionally want to override the default ordering.
- Use `reference` everywhere in public market-data and order endpoints.
- Read `priceHistory.supportedIntervals`, `defaultInterval`, `defaultLookbacks`, and `supportsResampling` before requesting candles.
- Prefer `interval + lookback` for routine candle reads.
- Use `asOf` only when you need reproducible historical analysis.
- Use `startTime + endTime` only for custom ranges.
- Treat quote fields as:
  - `price`: execution-facing reference price
  - `mid`: midpoint when both `bid` and `ask` exist, otherwise `price`
  - `spreadAbs` and `spreadBps`: only meaningful when both sides exist
- Satisfy `minQuantity`, `quantityStep`, `supportsFractional`, and `maxLeverage` before `POST /api/orders`.
- When placing a prediction-market order, include `prediction.outcome`, `prediction.probability`, and optional `prediction.conviction` so benchmark scoring can run after resolution.
- Treat `prediction.conviction` as the model's submitted execution confidence, not the platform score.
- Include `Idempotency-Key` on retryable writes:
  - `POST /api/orders`
  - `DELETE /api/orders/:id`
  - `POST /api/journal`
- Avoid `POST /api/orders/reconcile` in routine cycles; the background reconciler already runs.
- Reload this skill and its references if `system.ready.data.version` changes.

## Dashboard Boundary

- Treat the web dashboard as an operator review console for humans, not as the primary trading surface.
- Agents should trade through the API and helper script; humans should use the dashboard to inspect exposure, valuation health, PnL, funding/liquidation events, and audit timelines.
- Admin credentials are for setup and protected operational endpoints, not proxy order placement. Order writes should use the agent/user API key that owns the account.
- Do not reintroduce manual buy/sell order tickets, market discovery panels, or human-first trading workflows into the dashboard unless explicitly requested as a new product direction.
- Preserve the established visual direction when touching the web UI: neutral graphite surfaces, moss/eucalyptus primary accents, and muted material chart colors. Avoid sci-fi cyan, AI purple/blue gradients, neon glows, washed-out gray-green, and dirty yellow/olive casts.
- Keep reasoning and journal/audit context prominent. The UI should make it easy to understand what agents did and why.

## Boundary Rules

- Use `skills/unimarket/scripts/unimarket-agent.sh` for deterministic endpoint work whenever a matching command already exists.
- Prefer batch helper commands such as `quotes`, `orderbooks`, and `fundings` before writing per-reference loops.
- Use raw `curl`, ad-hoc shell, `jq`, or Node only for one-off endpoint checks, response shaping, or helper gaps.
- Do not duplicate helper responsibilities such as auth headers, endpoint paths, write payload construction, or idempotency handling in custom code unless the helper lacks the operation.
- If the same derived metric, fetch pattern, or response-shaping script keeps reappearing, treat that as a signal to extend the helper or API instead of re-implementing it forever.
- Do not add market-selection heuristics, scoring formulas, or trading rules to the skill and helper conventions. This skill should only teach the model how to use Unimarket correctly.

## Helper Script

Use `skills/unimarket/scripts/unimarket-agent.sh` for repetitive calls and any existing helper-first workflow before falling back to custom scripts.

Global output options:
- `--compact` for machine-friendly one-line JSON
- `--jq '<filter>'` for stable field extraction without extra wrapper code
- `--raw` when the caller needs untouched JSON

Preferred workflow commands:
- `register-safe [user_name] [env_file]` for unattended bootstrap
- `markets-summary` for a concise market capability view
- `snapshot [orders_view] [limit] [offset]` for account + portfolio + positions + orders in one response
- `orders-open [limit] [offset]` for duplicate-order prevention without guessing query params
- `history-summary <market> <reference> [interval] [lookback] [as_of]` for summary + last candles without full-history plumbing
- `scan <market> <references_csv> [interval] [lookback] [as_of]` for batch inspection of supplied references with constraints, quotes, orderbook summaries, optional funding, and optional history summaries
- `analysis-context <market> <reference> [interval] [lookback] [as_of]` for candles, deterministic indicators, snapshot hash, and drawing capabilities
- `analysis-validate`, `analysis-create`, `analysis-update`, `analysis-publish`, and `analysis-render-metadata` for provider-neutral chart documents
- `analysis-image-url` and `analysis-render` for repeated image review through the persistent renderer; inspect the image, revise the draft, and render again before publishing
- `order-json <payload_json> [idempotency_key]` for forecast-backed orders that include a `prediction` object

Core commands still available:
- `register`, `markets`, `browse`, `search`
- `constraints`, `quote`, `quotes`, `orderbook`, `orderbooks`, `funding`, `fundings`, `resolve`
- `history`, `history-range`, `analysis-schema`, `analysis-list`
- `buy`, `sell`, `order-json`, `cancel`, `orders`, `orders-history`, `orders-status`
- `account`, `portfolio`, `positions`, `timeline`, `journal-add`, `journal-list`, `events`

Use `history` when you need the full candle payload:
- `history <market> <reference> [interval] [lookback] [as_of]`

Use `history-range` only when an exact time window is required:
- `history-range <market> <reference> <interval> <start_time> <end_time>`

## Read References On Demand

- Read `references/api.md` when you need exact request/response shapes, batch-query syntax, or price-history query examples.
- Read `references/markets.md` when you need market-specific discovery behavior, execution semantics, or history nuances.
