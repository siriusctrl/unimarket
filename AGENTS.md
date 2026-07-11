# AGENTS.md

This file is the operating map for agents working in this repo. Keep product
framing in `README.md`, trading model details in `docs/trading-model.md`, and
durable architecture in `docs/architecture.md`.

## Source Map

- `packages/core/`: deterministic trading engine, schemas, perps, and timeline
  primitives.
- `packages/markets/`: market adapters, registry, cache, history, Hyperliquid,
  and Polymarket integration.
- `packages/api/`: HTTP API, env, fees, timeline, symbol metadata, workers, and
  server entrypoint.
- `packages/web/`: read-only dashboard UI.
- `docs/api-reference.md`: user/API contract.
- `docs/admin-guide.md`: admin-only operations.
- `docs/architecture.md`: package boundaries and system design.
- `docs/testing.md`: verification workflow.
- `docs/visual-verification.md`: browser proof artifacts and review workflow.
- `docs/trading-agent.md`: agent-facing trading workflow.
- `docs/trading-model.md`: market/trading domain model.
- `docs/codex-exec.md`: delegation prompt patterns.

## Product And Engineering Invariants

- Simulation first: never execute real trades or require private exchange keys
  for core paper-trading flows.
- Market-agnostic by default: add markets through adapters, not scattered
  market-specific branching.
- State-changing actions must carry rationale and preserve an audit trail.
- Keep user and admin operations clearly separated.
- Authentication must map credentials to identity consistently.
- Keep domain logic deterministic and testable.
- Isolate network, storage, and framework side effects.
- Validate external input and keep API errors consistent.
- Prefer simple observable data flow over clever abstractions.
- Do not preserve legacy behavior with compatibility branches, aliases, silent
  fallbacks, dual reads/writes, or automatic degradation unless explicitly
  requested.
- If migration risk or a contract conflict appears, stop and discuss it instead
  of inventing compatibility behavior.

## Task Routing

- Trading engine, schemas, timeline primitives: inspect `packages/core/`.
- Market adapter or data integration: inspect `packages/markets/`.
- API route, worker, auth, fees, timeline, or persistence behavior: inspect
  `packages/api/`.
- Dashboard UI: inspect `packages/web/`.
- Public API contract: read `docs/api-reference.md`.
- Admin behavior: read `docs/admin-guide.md`.
- Trading agent workflow: read `docs/trading-agent.md`.
- Architecture or package boundary: read `docs/architecture.md`.

## Verification

- Run `corepack pnpm -r typecheck`.
- Run `corepack pnpm -r test`.
- Run `corepack pnpm test` for broad repo verification.
- Run `corepack pnpm coverage` when touching core trading, markets, or API
  behavior where coverage matters.
- Run `corepack pnpm verify:ui` for dashboard interaction or rendering changes.
- Run `corepack pnpm verify:preview` for production-build dashboard changes.
- Run `corepack pnpm verify:proof` for user-facing visual changes, inspect the
  generated GIF/contact sheet, and report the absolute artifact path.
- For API contract changes, add or update focused package tests and check
  `docs/api-reference.md`.
- For admin-boundary changes, verify user/admin separation explicitly.

## Docs Update Rules

- User-visible setup or workflows: update `README.md`.
- API contract changes: update `docs/api-reference.md`.
- Admin behavior changes: update `docs/admin-guide.md`.
- Architecture or package-boundary changes: update `docs/architecture.md`.
- Test workflow changes: update `docs/testing.md`.
- Trading-agent workflow changes: update `docs/trading-agent.md`.
- Trading-domain changes: update `docs/trading-model.md`.
- Delegation workflow changes: update `docs/codex-exec.md`.

## Commit Rules

- Use readable Conventional Commit messages.
- Prefer multiple focused commits for distinct logical changes.
- Do not revert unrelated user changes.
