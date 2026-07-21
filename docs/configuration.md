# Configuration

Unimarket runs without an environment file for the default paper-trading flow.
Use `.env.local` for machine-local settings and `.env` for shared deployment
settings. Existing shell variables always win.

The API loads repo-root files in this order:

1. `.env.local`
2. `.env`

Start from `.env.example` when overrides are needed. Never commit a populated
environment file or an agent credential file.

## API And Storage

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3100` | API listen port |
| `ADMIN_API_KEY` | unset | Bearer credential for `/api/admin/*`; unnecessary for normal agent flows |
| `DB_URL` | `file:unimarket.sqlite` | libSQL/SQLite connection URL |
| `DB_PATH` | unset | Legacy path-shaped fallback used only when `DB_URL` is absent |
| `SERVE_WEB_DIST` | `false` | Serve `packages/web/dist` from the API process |
| `BROWSE_CACHE_TTL_MS` | `300000` | Market discovery cache lifetime |
| `SYMBOL_METADATA_TTL_MS` | `86400000` | Successful symbol metadata cache lifetime |
| `SYMBOL_METADATA_MISS_TTL_MS` | `600000` | Missing symbol metadata cache lifetime |

Prefer `DB_URL`. `DB_PATH` remains an accepted runtime input in the current
implementation but new deployment documentation should use `DB_URL`.

## Worker Cadence

All intervals are positive milliseconds. Missing, invalid, or non-positive
values fall back to the defaults below.

| Variable | Default | Worker |
|---|---|---|
| `RECONCILE_INTERVAL_MS` | `1000` | Pending limit-order reconciliation |
| `SETTLE_INTERVAL_MS` | `60000` | Resolved prediction-market settlement |
| `FUNDING_INTERVAL_MS` | `3600000` | Perp funding application |
| `LIQUIDATION_INTERVAL_MS` | `5000` | Maintenance-margin liquidation |
| `EQUITY_SNAPSHOT_INTERVAL_MS` | `300000` | Operator equity history snapshots |

Workers start inside the API process after database migration. Unimarket does
not currently split them into independently deployed services.

## Risk And Fees

| Variable | Default | Purpose |
|---|---|---|
| `MAINTENANCE_MARGIN_RATIO` | `0.05` | Default isolated maintenance-margin ratio |
| `DEFAULT_TAKER_FEE_RATE` | `0` | Default simulated taker fee in `[0, 1)` |
| `${MARKET}_TAKER_FEE_RATE` | unset | Market override such as `HYPERLIQUID_TAKER_FEE_RATE` |

Market-specific fee variables take precedence over the default. Invalid rates
are rejected rather than silently clamped.

## Web Development

The Vite development server listens on `5173` and proxies `/api`, `/health`, and
`/openapi.json` to:

| Variable | Default | Purpose |
|---|---|---|
| `UNIMARKET_API_PROXY` | `http://localhost:3100` | API target used by Vite |

For a single-process production-style preview:

```bash
corepack pnpm --filter @unimarket/web build
SERVE_WEB_DIST=true corepack pnpm dev:api
```

## Analysis Renderer

The renderer reads its environment from the launching shell. It does not load
the API's repo-root environment files itself.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3101` | Renderer listen port |
| `HOST` | `127.0.0.1` | Renderer bind address |
| `UNIMARKET_WEB_BASE_URL` | `http://127.0.0.1:5173` | Web deployment opened by Playwright |
| `UNIMARKET_RENDER_CONCURRENCY` | `2` | Maximum simultaneous render/inspect requests |

The renderer exposes a browser process and should stay bound to localhost
unless a trusted gateway provides authentication and network isolation.

## Verification Overrides

| Variable | Default | Purpose |
|---|---|---|
| `UNIMARKET_PREVIEW_PORT` | `43178` | Production preview verification port |
| `UNIMARKET_PROOF_PORT` | `43179` | Browser proof capture port |
| `UNIMARKET_PROOF_TRIM_START` | script default | Optional proof-video trim override |

See [Testing](testing.md) and [Visual Verification](visual-verification.md) for
the commands that use these settings.
