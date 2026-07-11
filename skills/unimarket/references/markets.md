# Unimarket Markets

## Cross-Market Rules

- Persist the discovery `reference`; do not replace it with guessed exchange identifiers.
- Read `/api/markets` before requesting candles so the agent can discover:
  - `supportedIntervals`
  - `defaultInterval`
  - `defaultLookbacks`
  - `supportsResampling`
- Read `/api/markets/{market}/trading-constraints?reference=...` before placing orders.
- Use quote fields as:
  - `price`: execution-facing reference price
  - `mid`: best-effort midpoint
  - `spreadAbs` and `spreadBps`: spread diagnostics when both sides exist

## Polymarket (`polymarket`)

- Discovery `reference` is usually a market slug.
- Execution reads and order placement accept the same `reference`; the adapter resolves it internally to a tradable token id.
- Capabilities: `search`, `browse`, `quote`, `orderbook`, `resolve`, `priceHistory`.
- Browse sorts: `volume`, `liquidity`, `endingSoon`, `newest`.
- Explicit search sorts: `volume`, `liquidity`, `endingSoon`, `newest`.
- Default query search keeps relevance ordering unless the caller explicitly sends `sort`.
- Search may hydrate sparse Gamma search previews with market detail so `volume`, `liquidity`, `endDate`, and `createdAt` can still appear in discovery cards.
- Price range is usually `0.01` to `0.99`.
- Quantity is integer-only: `quantityStep = 1`, `supportsFractional = false`.
- Bearish views are usually expressed by buying the opposite outcome token, not by shorting.
- History behavior:
  - native intervals: `1m`, `1h`, `1d`
  - agent-facing intervals may include `5m`, `15m`, `4h`
  - `resampledFrom` tells you when the server aggregated native candles into the requested interval

## Hyperliquid (`hyperliquid`)

- Discovery and execution `reference` can be a plain ticker such as `BTC` or a dex-prefixed builder-perp reference such as `xyz:NVDA` or `vntl:OPENAI`.
- Aliases like `btc`, `btc-perp`, or mixed case are normalized internally. Unique builder symbols can also resolve without the prefix, but ambiguous names should keep the returned `dex:SYMBOL` reference.
- Capabilities: `search`, `browse`, `quote`, `orderbook`, `funding`, `priceHistory`.
- Browse sorts: `price`, `volume`, `openInterest`.
- Explicit search sorts: `price`, `volume`, `openInterest`.
- Default query search ordering is relevance first, then `volume`, then `openInterest`, then `price`.
- Quantity precision is per-symbol and derived from `szDecimals`.
- `maxLeverage` is enforced per symbol.
- Funding applies hourly and affects realized account balance over time.
- Perpetual futures do not resolve; close exposure with explicit trades.
- History behavior:
  - native intervals and supported intervals match
  - `supportsResampling = false`

## Read Sequences Before Orders

### Prediction-market order sequence
1. Browse or search Polymarket.
2. Keep the returned `reference`.
3. Read `quote` and `orderbook`.
4. Optionally read `price-history` when the caller needs candles.
5. Optionally read `resolve` if the market may already be settling.
6. Validate `trading-constraints` before ordering.

### Perp order sequence
1. Browse or search Hyperliquid.
2. Keep the returned `reference`.
3. Read `quote`, `orderbook`, and `funding`.
4. Optionally read `price-history` when the caller needs candles.
5. Validate `trading-constraints` before ordering.

## Analysis Context

Use `GET /api/analysis/context` after choosing a concrete market reference. The response is market-agnostic even when the upstream reference is adapter-specific. Hyperliquid `xyz:MU` is suitable for live stock-oracle chart validation, but it is a perpetual market reference rather than a direct Nasdaq spot-data contract.
