# AGENTS.md

This file is the operating map for agents working in this repository. Keep the
product and user workflow in `README.md`, contributor setup in
`CONTRIBUTING.md`, current contracts in topic documents under `docs/`,
historical decisions in `docs/adr/`, and this file focused on navigation,
invariants, verification, synchronization, and handoff.

## Source Map

- `packages/core/`: deterministic trading engine, shared schemas, perps, and
  timeline contracts. It must not depend on HTTP, storage, or a market adapter.
- `packages/analysis/`: provider-neutral chart documents, indicators, drawing
  metadata, and render projections.
- `packages/markets/`: adapter contract, registry, cache, history, quotes,
  Hyperliquid, and Polymarket integrations.
- `packages/api/`: HTTP routes, application services, persistence, auth,
  idempotency, events, timelines, and periodic workers.
- `packages/web/`: read-only operator dashboard and analysis workspace.
- `packages/renderer/`: persistent Playwright inspection and image service.
- `skills/unimarket/`: portable agent instructions, operational API references,
  and the deterministic endpoint helper.
- `scripts/`: local verification, rendering, proof capture, and smoke workflows.
- `tests/browser/`: deterministic Playwright fixtures and browser behavior.
- `docs/INDEX.md`: documentation ownership and navigation.
- `docs/source-map.md`: file-level entry points.
- `docs/adr/`: accepted and superseded architecture decisions.

## Runtime Entrypoints

- API composition: `packages/api/src/index.ts`; HTTP assembly:
  `packages/api/src/app.ts`.
- Database schema and migration: `packages/api/src/db/schema.ts` and
  `packages/api/src/db/client.ts`.
- Web composition: `packages/web/src/main.tsx` and `packages/web/src/App.tsx`.
- Renderer process: `packages/renderer/src/index.ts`.
- Market registration: `packages/api/src/app.ts`; adapter contract:
  `packages/markets/src/types.ts`.
- Agent helper: `skills/unimarket/scripts/unimarket-agent.sh`.
- Browser proof: `scripts/record-proof.mjs`; live analysis verification:
  `scripts/verify-live-analysis.mjs`.

## Product And Engineering Invariants

- Simulation first: never execute real trades or require private exchange keys
  for core paper-trading flows.
- Market agnostic: add markets through adapters and capability checks, not
  scattered market-name branching.
- Agent writes, human reviews: order placement belongs to authenticated user or
  agent APIs; the dashboard remains a read-only operator surface.
- Every state-changing action carries rationale and preserves an audit trail.
- Authentication maps credentials to identity consistently. Keep user and admin
  operations explicit and separate.
- Keep domain behavior deterministic. Isolate network, storage, timing, and
  framework side effects at package boundaries.
- Validate external input and preserve the shared API error envelope.
- Chart analysis remains provider-neutral data, never generated JavaScript or
  executable browser instructions. Published documents are immutable.
- Do not add compatibility aliases, silent fallbacks, dual reads or writes, or
  automatic degradation unless explicitly requested.
- If migration risk or a public-contract conflict appears, stop and discuss it
  instead of inventing compatibility behavior.

The rationale for costly-to-reverse choices lives in `docs/adr/`. Do not
silently rewrite an accepted decision; supersede or refine it with a new ADR.

## Task Routing

- Trading math, schemas, or timeline types: start in `packages/core/`.
- Chart schema, indicators, or drawing metadata: start in `packages/analysis/`.
- Market data or a new integration: start in `packages/markets/`.
- Routes, auth, persistence, fees, timelines, or workers: start in
  `packages/api/`.
- Dashboard or analysis UI: start in `packages/web/`.
- Browser-backed chart review: start in `packages/renderer/`.
- Public REST or SSE behavior: read `docs/api-reference.md`.
- Trading semantics: read `docs/trading-model.md`.
- Agent workflow or helper behavior: read `docs/trading-agent.md` and
  `skills/unimarket/`.
- Architecture or package ownership: read `docs/architecture.md` and
  `docs/source-map.md`.

## Change Matrix

| Change | Required focused verification | Documentation to check |
|---|---|---|
| Core trading or schemas | core tests, API consumers, coverage | trading model, API reference |
| Market adapter or capability | markets tests, API route tests | API reference, trading agent, skill references |
| API route or response | API tests, typecheck, contract callers | API reference, skill references/helper |
| Auth or admin boundary | focused API tests for both user and admin paths | API reference, admin guide |
| Worker behavior | unit plus integration tests for that worker | architecture, trading model, testing |
| Web behavior | web tests, UI and preview verification | README/admin guide when user-visible |
| Visual design | UI, preview, proof bundle inspection | visual verification; preserve product direction |
| Analysis or renderer | analysis/web/renderer tests, live analysis when applicable | architecture, API reference, trading agent |
| Tooling or commands | docs link check and the changed command | README, CONTRIBUTING, testing |

## Verification

Use the narrowest relevant checks while iterating, then broaden before handoff.

- Documentation-only change: `corepack pnpm verify:docs`.
- Normal code change: `corepack pnpm check` and `corepack pnpm build`.
- Broad local gate: `corepack pnpm verify`.
- Core, markets, API, renderer, or analysis behavior: run
  `corepack pnpm coverage` when coverage is material.
- Dashboard interaction or rendering: run `corepack pnpm verify:ui` and
  `corepack pnpm verify:preview`.
- User-facing visual change: run `corepack pnpm verify:proof`, inspect the GIF
  and contact sheet, and report the absolute artifact path.
- Live chart context or renderer change: run
  `corepack pnpm verify:analysis-live`, inspect the result, and report the
  ignored MU artifact path.
- API contract change: add or update focused tests, then check both the human
  API reference and the portable agent skill projection.

Do not claim a live path, browser artifact, or external integration was
verified unless it was actually exercised.

## Documentation And Skill Synchronization

- User-visible product, setup, or common workflow: update `README.md`.
- Contributor setup or validation: update `CONTRIBUTING.md`.
- Runtime configuration: update `.env.example` and `docs/configuration.md`.
- Public API or SSE contract: update `docs/api-reference.md`.
- Admin behavior: update `docs/admin-guide.md`.
- Architecture or package boundary: update `docs/architecture.md`.
- File-level navigation: update `docs/source-map.md`.
- Test workflow: update `docs/testing.md`.
- Trading-agent workflow: update `docs/trading-agent.md`.
- Trading-domain semantics: update `docs/trading-model.md`.
- Delegation workflow: update `docs/codex-exec.md`.
- Agent-consumed API, market, or helper behavior: update the relevant files in
  `skills/unimarket/` in the same change.
- Significant cross-package decision or rejected credible alternative: add or
  supersede an ADR and update `docs/adr/README.md`.

`docs/api-reference.md` is the canonical human-readable API contract.
`skills/unimarket/references/` is a concise operational projection for agents,
not an independent source of truth.

## Review And Handoff

- Review package ownership before adding cross-layer imports or duplicating a
  domain rule.
- Prefer focused services and modules over route-local or component-local
  copies of shared behavior.
- Report commands actually run, failures or skipped live paths, and generated
  artifact locations.
- Keep credentials, `.state/`, local databases, coverage, builds, and proof
  artifacts out of Git.
- Do not revert or overwrite unrelated user changes.

## Commit Rules

- Use readable Conventional Commit messages with a body when the reason is not
  obvious from the subject.
- Prefer focused commits for distinct logical changes, even when one task lands
  several commits together.
- Do not commit generated output or credentials.
