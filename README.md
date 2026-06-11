# unimarket

Open paper trading platform for prediction markets and beyond. Built for agents, with an operator console for review.

A self-hosted paper trading engine with a clean REST API. Simulated trading across multiple markets — no real money, no risk. Any AI agent that can call an HTTP endpoint can trade, while humans inspect exposure, audit decisions, and compare performance.

- **Market agnostic** — unified API across all markets, discover capabilities at runtime
- **Polymarket** — prediction market trading with live odds from the CLOB API
- **Hyperliquid** — perpetual futures with reference-level fractional size precision, max leverage limits, and dex-prefixed builder listings
- **Extensible** — add new markets by implementing a simple adapter interface
- **Agent-friendly** — skill-based integration with version-aware SSE events, self-describing market capabilities
- **Decision transparency** — every action requires reasoning; journal + timeline for full audit trail
- **Constraint-aware orders** — decimal-capable quantities validated by per-market rules (`minQuantity`, `quantityStep`, integer/fractional support, `maxLeverage`)

---

## Getting Started

```bash
git clone https://github.com/siriusctrl/unimarket.git
cd unimarket
pnpm install
```

### Restore Agent Tooling (Optional for Contributors)

If you use `npx skills`, restore the team-locked tool skills from `skills-lock.json`:

```bash
npx skills experimental_install
```

This installs local tooling under `.agents/` (gitignored in this repo).

### Environment Variables

The API automatically loads environment variables from repo root in this order:
1. `.env.local`
2. `.env`

Any variable already present in the shell environment keeps highest priority.
You can start from [.env.example](.env.example).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_API_KEY` | **Yes** | — | Admin API key for dashboard login and admin endpoints |
| `DB_URL` / `DB_PATH` | No | `file:unimarket.sqlite` | SQLite database path |
| `RECONCILE_INTERVAL_MS` | No | `1000` | Pending order reconciliation interval (ms) |
| `SETTLE_INTERVAL_MS` | No | `60000` | Settlement worker interval (ms) |
| `FUNDING_INTERVAL_MS` | No | `3600000` | Funding collector interval (ms) |
| `LIQUIDATION_INTERVAL_MS` | No | `5000` | Liquidation worker interval (ms) |
| `MAINTENANCE_MARGIN_RATIO` | No | `0.05` | Maintenance margin ratio for perp positions |
| `DEFAULT_TAKER_FEE_RATE` | No | `0` | Default taker fee rate for all markets |
| `${MARKET}_TAKER_FEE_RATE` | No | — | Market-specific taker fee override (e.g. `HYPERLIQUID_TAKER_FEE_RATE`) |
| `SERVE_WEB_DIST` | No | `false` | Serve built frontend from API server on `:3100` when set to `true` |

### Trading Constraints

Order payload `quantity` is decimal-capable at schema layer, then validated per market/reference.

Discover constraints before placing orders:

```bash
GET /api/markets/:market/trading-constraints?reference=<reference>
```

Example response:

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

Notes:
- Some markets require integer quantities (`supportsFractional: false`, usually `quantityStep: 1`).
- Search and browse surfaces now return lightweight market references. Execution endpoints (`quote`, `orderbook`, `resolve`, order placement) accept those references directly.
- Discovery is intentionally separate from execution: `browse` and `search` help humans and agents find candidates quickly, then adapters lazily normalize the chosen `reference` only when a quote or order is requested.
- For Polymarket, discovery references are typically market slugs. The adapter resolves those slugs into outcome token ids behind the scenes when you ask for quotes or place orders.
- Polymarket search hydrates sparse search previews with market detail when Gamma search results omit volume or liquidity, so discovery cards can still show richer metrics.
- Hyperliquid derives `quantityStep` and fractional support from `szDecimals`, enforces per-reference `maxLeverage`, and search covers builder-deployed perp dex listings such as `xyz:NVDA` and `vntl:OPENAI`.
- Search now accepts an optional `sort`. Without it, adapters can apply a market-specific default ranking. When a market supports explicit search sorting, `GET /api/markets` exposes `searchSortOptions` for runtime discovery.
- Browse sort options and explicit search sort options are market-specific and discoverable from `GET /api/markets`. Polymarket exposes `volume`, `liquidity`, `endingSoon`, and `newest`; Hyperliquid exposes `price`, `volume`, and `openInterest`.
- `browse` and `search` now return `{ results, hasMore }`, so clients and agents do not need to infer pagination from page size. Unsupported `sort` values are rejected with `400 INVALID_INPUT` instead of silently falling back.

### Market Discovery

Typical discovery flow:

```bash
GET /api/markets
GET /api/markets/:market/browse?sort=<market-specific-sort>
GET /api/markets/:market/search?q=iran
GET /api/markets/:market/search?q=nvda&sort=volume
GET /api/markets/:market/quote?reference=<reference>
GET /api/markets/:market/price-history?reference=<reference>&interval=1h&lookback=7d
POST /api/orders
```

Quote responses include convenience fields for agents:
- `price`: execution-facing reference price
- `mid`: midpoint when both `bid` and `ask` are available, otherwise falls back to `price`
- `spreadAbs`: absolute spread when both sides exist
- `spreadBps`: spread in basis points when both sides exist

The platform now treats `reference` as the single external identifier across markets:
- Polymarket: usually a slug during discovery, resolved lazily to a token id for execution
- Hyperliquid: a ticker such as `BTC`, or a dex-prefixed builder-perp reference such as `xyz:NVDA` or `vntl:OPENAI`
- Future markets: whatever adapter-specific identifier makes the most sense externally

`GET /api/markets` also exposes market-specific `priceHistory` defaults so humans and agents can discover:
- `searchSortOptions`
- `supportedIntervals` and `nativeIntervals`
- `defaultInterval`
- `supportedLookbacks` and per-interval `defaultLookbacks`
- `maxCandles`, `supportsCustomRange`, and `supportsResampling`

Price history is agent-friendly by default:
- Use `interval + lookback` for the common case
- Use `asOf` to anchor a historical snapshot for repeatable analysis
- Use `startTime + endTime` only for advanced custom ranges

Example:

```bash
GET /api/markets/polymarket/price-history?reference=iran-hormuz&interval=4h&lookback=30d
```

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

### Running the Server

```bash
# Option A: put this in .env at repo root, then run
# ADMIN_API_KEY=your-secret-key
# pnpm dev

# Option B: set it inline
ADMIN_API_KEY=your-secret-key pnpm dev

# Individual services
pnpm dev:api   # API only (:3100, no dashboard static by default)
pnpm dev:web   # Dashboard only (:5173)

# Optional: serve built dashboard from API server (:3100)
SERVE_WEB_DIST=true pnpm dev:api
```

### Running Tests

```bash
pnpm test       # Run all tests
pnpm coverage   # Coverage with CI-enforced thresholds
```

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [Trading Model](docs/trading-model.md) | Current simulation semantics for spot markets, perp markets, funding, settlement, and liquidation |
| [Architecture](docs/architecture.md) | System design, package responsibilities, worker model, persistence, timeline and SSE architecture |
| [Refactor Roadmap](docs/refactor-roadmap.md) | Current simplification targets, read-model cleanup plan, worker cleanup plan, and future reconciler evolution |
| [API Reference](docs/api-reference.md) | Current REST and SSE surfaces, timeline event types, admin endpoints, and runtime configuration |
| [Admin Guide](docs/admin-guide.md) | Dashboard review workflows, admin APIs, timelines, and liquidation monitoring |
| [Trading Agent](docs/trading-agent.md) | How to build an autonomous trading agent against the current API and event model |
| [Testing](docs/testing.md) | Test strategy, smoke playbook, worker regression checklist, and SSE validation |

---

## Contributing

PRs welcome. Strong types, pure functions in core, clear separation of concerns.

## License

MIT
