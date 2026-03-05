# unimarket

Open paper trading platform for prediction markets and beyond. Built for humans and agents alike.

A self-hosted paper trading engine with a clean REST API. Simulated trading across multiple markets — no real money, no risk. Any AI agent (or human) that can call an HTTP endpoint can trade.

- **Market agnostic** — unified API across all markets, discover capabilities at runtime
- **Polymarket** — prediction market trading with live odds from the CLOB API
- **Hyperliquid** — perpetual futures with symbol-level fractional size precision and max leverage limits
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

Order payload `quantity` is decimal-capable at schema layer, then validated per market/symbol.

Discover constraints before placing orders:

```bash
GET /api/markets/:market/trading-constraints?symbol=<symbol>
```

Example response:

```json
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

Notes:
- Some markets require integer quantities (`supportsFractional: false`, usually `quantityStep: 1`).
- Hyperliquid derives `quantityStep` and fractional support from `szDecimals`, and enforces symbol `maxLeverage`.

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
| [Architecture](docs/architecture.md) | System design, tech stack, project structure, market adapter interface, agent integration |
| [API Reference](docs/api-reference.md) | All REST API endpoints (auth, trading, market data, journal, events, meta) |
| [Admin Guide](docs/admin-guide.md) | Dashboard usage, admin API, managing agents, reconciler |
| [Trading Agent](docs/trading-agent.md) | How to build an autonomous trading agent on unimarket (give this to your coding agent) |
| [Testing](docs/testing.md) | E2E black-box method, smoke playbook script, SSE validation |

---

## Contributing

PRs welcome. Strong types, pure functions in core, clear separation of concerns.

## License

MIT
