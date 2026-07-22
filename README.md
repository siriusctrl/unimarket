# unimarket

Agent-first paper trading across prediction markets and perpetual futures, with
a human operator console for exposure, performance, and decision review.

Unimarket combines a deterministic simulation engine, live public market data,
a market-agnostic REST API, and a read-only dashboard. Agents discover markets
and place simulated orders; humans inspect what happened and why.

- **Simulation first** — no real-money execution or private exchange keys
- **Market agnostic** — capabilities are discovered from adapters at runtime
- **Agent friendly** — every state change carries reasoning and an audit trail
- **Prediction aware** — submitted probabilities can be scored after resolution
- **Perp capable** — fractional size, leverage, funding, margin, and liquidation
- **Analysis ready** — provider-neutral chart documents and iterative image review

## Product Boundary

Unimarket is deliberately agent-run and human-reviewed.

- Agents use the API or bundled skill to discover markets, analyze candidates,
  place paper orders, maintain a journal, and follow the event stream.
- Humans use the dashboard to review exposure, valuation health, PnL,
  predictions, and audit timelines.
- The Analysis Workspace stores versioned, provider-neutral chart documents.
- The dashboard does not provide manual order tickets or proxy agent trading.
- Live integrations read public market data only. Core paper-trading flows must
  not require private exchange credentials.

This is simulation software, not a live execution venue or financial advice.

## Quick Start

Requirements:

- Node.js 22
- Corepack

```bash
git clone https://github.com/siriusctrl/unimarket.git
cd unimarket
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

Open the dashboard at <http://localhost:5173>. The API listens on
<http://localhost:3100>.

```bash
curl http://localhost:3100/health
```

No environment file is required for the default paper-trading flow. Copy
`.env.example` to `.env.local` only when you need admin operations or want to
override runtime settings. See [Configuration](docs/configuration.md).

## Connect an Agent

The bundled helper requires `curl` and `jq`. It can register an agent, keep the
returned credential outside Git, and expose concise API workflows.

```bash
helper=./skills/unimarket/scripts/unimarket-agent.sh

"$helper" register-safe quickstart-agent .state/agent.env
set -a
source .state/agent.env
set +a

"$helper" markets-summary
"$helper" snapshot
```

The normal cycle is:

```text
discover capabilities
  -> browse or search
  -> read constraints, quotes, depth, funding, and history
  -> record a thesis and probability
  -> place a reasoned simulated order
  -> monitor portfolio, timeline, journal, and events
```

Read [Building an Autonomous Trading Agent](docs/trading-agent.md) for the
complete operating model. Exact endpoints live in the
[API Reference](docs/api-reference.md).

## Runtime Topology

```text
Agent / API client ───────────────┐
                                 v
Human ──> Web dashboard ──> API + background workers ──> SQLite
                                  │
                                  ├──> Polymarket public data
                                  └──> Hyperliquid public data

Model ──> Analysis renderer ──> Web analysis route ──> API
```

The default development command starts the API and web dashboard. The analysis
renderer is an optional third service:

```bash
corepack pnpm dev:renderer
```

The API can also serve a production web build when `SERVE_WEB_DIST=true`.
Deployment modes and environment variables are documented in
[Configuration](docs/configuration.md).

## Common Commands

| Command | Purpose |
|---|---|
| `corepack pnpm dev` | Run API and dashboard in development |
| `corepack pnpm dev:renderer` | Run the persistent chart renderer |
| `corepack pnpm build` | Build every workspace package |
| `corepack pnpm check` | Check docs, types, and package tests |
| `corepack pnpm verify` | Run broad local build and browser verification |
| `corepack pnpm coverage` | Run package coverage suites |
| `corepack pnpm smoke:api` | Exercise the live local API end to end |
| `corepack pnpm verify:proof` | Record the dashboard review bundle |
| `corepack pnpm verify:analysis-live` | Verify live MU analysis and rendering |

Browser proof and live analysis commands have additional local dependencies and
artifact-review requirements. See [Testing](docs/testing.md) and
[Visual Verification](docs/visual-verification.md).

## Package Layout

| Package | Responsibility |
|---|---|
| `packages/core` | Deterministic schemas, fills, perps, and timeline contracts |
| `packages/analysis` | Chart document schema, indicators, and render metadata |
| `packages/markets` | Market adapter contract, registry, cache, and integrations |
| `packages/api` | HTTP boundaries, persistence, services, workers, and events |
| `packages/web` | Read-only operator dashboard and analysis workspace |
| `packages/renderer` | Persistent Playwright chart inspection and image service |

See [Architecture](docs/architecture.md) for dependency rules and runtime
flows, or [Source Map](docs/source-map.md) for file-level entry points.

## Documentation

Start with the [documentation index](docs/INDEX.md), or go directly to:

| Audience | Document |
|---|---|
| API clients | [API Reference](docs/api-reference.md) |
| Agent builders | [Trading Agent](docs/trading-agent.md) |
| Operators | [Admin Guide](docs/admin-guide.md) |
| Trading-model reviewers | [Trading Model](docs/trading-model.md) |
| Contributors | [Contributing](CONTRIBUTING.md) |
| Maintainers and coding agents | [AGENTS.md](AGENTS.md) |
| Architecture reviewers | [Architecture Decisions](docs/adr/README.md) |

## Agent Tooling for Contributors

If you use `npx skills`, restore the repository-locked contributor skills with:

```bash
npx skills experimental_install
```

This installs local tooling under `.agents/`, which is ignored by Git.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, validation, documentation
ownership, and pull-request expectations.

## License

MIT
