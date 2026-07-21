# Contributing

Unimarket is an agent-first paper-trading platform. Contributions should keep
the simulation deterministic, market integrations isolated, public contracts
explicit, and operator behavior auditable.

## Prerequisites

- Node.js 22
- Corepack with the repository-pinned pnpm version
- Git
- `curl` and `jq` for the API smoke workflow
- Chromium installed through Playwright for browser verification
- `ffmpeg` only when recording visual proof bundles

## Setup

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm dev
```

The dashboard runs at <http://localhost:5173> and proxies API requests to
<http://localhost:3100>. The API creates a local SQLite database by default.

No exchange credential is required. Create `.env.local` only when you need
admin endpoints or non-default runtime settings:

```bash
cp .env.example .env.local
```

Never commit `.env.local`, `.state/agent.env`, a database, or generated proof
artifacts.

## Workspace Guide

- `packages/core`: pure trading rules and shared contracts
- `packages/analysis`: provider-neutral chart-analysis data and calculations
- `packages/markets`: market adapters and public data normalization
- `packages/api`: HTTP, auth, persistence, services, events, and workers
- `packages/web`: read-only operator and analysis UI
- `packages/renderer`: persistent browser-backed chart inspection
- `skills/unimarket`: portable agent workflow and endpoint helper
- `scripts`: repeatable verification and proof commands

Read [Architecture](docs/architecture.md) for dependency boundaries and
[Source Map](docs/source-map.md) for concrete entry points.

## Development Loop

Run a focused package while iterating:

```bash
corepack pnpm --filter @unimarket/core test
corepack pnpm --filter @unimarket/markets test
corepack pnpm --filter @unimarket/api test
corepack pnpm --filter @unimarket/web test
```

Before handing off a normal code change:

```bash
corepack pnpm check
corepack pnpm build
```

The broad local gate adds production and browser verification:

```bash
corepack pnpm setup:browsers # once per machine
corepack pnpm verify
```

Use specialized verification when the change requires it:

```bash
corepack pnpm coverage
corepack pnpm smoke:api
corepack pnpm verify:proof
corepack pnpm verify:analysis-live
```

`smoke:api` expects a running API and live public market connectivity.
`verify:proof` produces browser-review artifacts. `verify:analysis-live` is an
opt-in live Hyperliquid MU check. Do not report those paths as verified unless
you ran and inspected them.

## Change Boundaries

- Keep trading math and state transitions in `packages/core` when possible.
- Keep upstream API shapes and market-specific behavior in adapters.
- Keep HTTP permission checks in routes and shared orchestration in services.
- Keep the dashboard read-only; authenticated agents own order writes.
- Preserve non-empty reasoning and audit records for state changes.
- Treat public request, response, event, and error shapes as contracts.
- Do not add compatibility aliases or silent fallbacks without an explicit
  migration decision.

## Documentation Ownership

- `README.md`: product framing and first-run workflow
- `CONTRIBUTING.md`: contributor setup and validation
- `docs/api-reference.md`: canonical human-readable API and SSE contract
- `docs/trading-model.md`: simulation and accounting semantics
- `docs/trading-agent.md`: autonomous-agent operating workflow
- `docs/admin-guide.md`: operator and admin behavior
- `docs/architecture.md`: current system and package boundaries
- `docs/adr/`: durable decisions, alternatives, and consequences
- `skills/unimarket/`: concise, portable agent instructions and API projections

When an API or market capability changes, update the canonical docs, the
portable skill projection, and focused tests together. Run
`corepack pnpm verify:docs` after documentation changes.

Write an ADR only for a costly-to-reverse cross-package decision, persistence
contract, security boundary, or product invariant with credible alternatives.
Ordinary refactors and bug fixes do not need one.

## Pull Requests And Handoff

- Use Conventional Commits.
- Keep unrelated changes out of the patch.
- Explain the user-visible or architectural reason for the change.
- List the exact commands run.
- Call out live integrations or visual paths that were not exercised.
- For visual changes, include the absolute proof artifact path after inspection.
- For API changes, name the contract tests and synchronized docs/skill files.

See [AGENTS.md](AGENTS.md) for the complete maintainer change matrix.
