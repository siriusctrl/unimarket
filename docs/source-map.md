# Source Map

Use this map after reading the package boundaries in
[Architecture](architecture.md). It identifies composition roots and the files
that own important contracts.

## Core Trading

- `packages/core/src/schemas.ts`: public request schemas and shared primitives.
- `packages/core/src/engine.ts`: deterministic spot fill behavior.
- `packages/core/src/perp.ts`: perp positions, leverage, margin, PnL, and liquidation math.
- `packages/core/src/timeline.ts`: discriminated timeline event contracts.
- `packages/core/src/index.ts`: public package exports.

## Chart Analysis

- `packages/analysis/src/schema.ts`: `unimarket.chart-analysis/v1` document schema.
- `packages/analysis/src/context.ts`: provider-neutral analysis context contract.
- `packages/analysis/src/indicators.ts`: deterministic indicator calculations.
- `packages/analysis/src/render-metadata.ts`: projection and inspection metadata.
- `packages/analysis/src/index.ts`: public package exports.

## Market Data

- `packages/markets/src/types.ts`: `MarketAdapter` contract and capability types.
- `packages/markets/src/registry.ts`: deterministic adapter registration and lookup.
- `packages/markets/src/polymarket.ts`: Gamma/CLOB discovery and execution-data reads.
- `packages/markets/src/hyperliquid.ts`: perp metadata, quotes, funding, and history.
- `packages/markets/src/history.ts`: history ranges and resampling helpers.
- `packages/markets/src/cache.ts`: bounded upstream discovery caching.
- `packages/markets/src/quotes.ts`: quote normalization helpers.

## API And Persistence

- `packages/api/src/index.ts`: API process bootstrap and worker startup.
- `packages/api/src/app.ts`: Hono assembly, market registration, auth boundaries, health, and optional static web hosting.
- `packages/api/src/env.ts`: repo-root `.env.local` and `.env` loading.
- `packages/api/src/db/schema.ts`: SQLite/Drizzle persistence schema.
- `packages/api/src/db/client.ts`: database client and migration path.
- `packages/api/src/routes/`: HTTP validation, authorization, and response boundaries.
- `packages/api/src/services/order-placement.ts`: shared order-placement orchestration.
- `packages/api/src/services/order-cancellation.ts`: shared cancellation path.
- `packages/api/src/services/portfolio-read.ts`: user/admin portfolio read model.
- `packages/api/src/services/chart-analysis.ts`: analysis validation and service behavior.
- `packages/api/src/services/chart-analysis-repository.ts`: analysis persistence and revision control.
- `packages/api/src/platform/auth.ts`: API-key identity and admin authentication.
- `packages/api/src/platform/errors.ts`: stable API error envelope.
- `packages/api/src/platform/idempotency.ts`: retry-safe write behavior.
- `packages/api/src/platform/events.ts`: in-process SSE event bus.
- `packages/api/src/timeline.ts`: persisted audit timeline aggregation.
- `packages/api/src/workers/periodic-worker.ts`: shared scheduler guard and lifecycle.
- `packages/api/src/workers/`: reconcile, settle, funding, liquidation, and equity snapshot policies.

## Web Dashboard

- `packages/web/src/main.tsx`: browser entry point.
- `packages/web/src/App.tsx`: routes and top-level application composition.
- `packages/web/src/pages/DashboardPage.tsx`: operator overview.
- `packages/web/src/pages/AgentDetailPage.tsx`: one-agent audit and exposure view.
- `packages/web/src/pages/AnalysisPage.tsx`: chart-analysis workspace.
- `packages/web/src/lib/dashboard-api.ts`: typed dashboard HTTP client.
- `packages/web/src/lib/analysis-api.ts`: chart-analysis HTTP client.
- `packages/web/src/lib/useDashboardClient.ts`: dashboard request boundary.
- `packages/web/src/components/analysis/FinancialChart.tsx`: chart composition.
- `packages/web/src/components/analysis/chart-projection.ts`: drawing projection math.
- `packages/web/src/styles.css`: global design tokens and visual system.

## Renderer And Verification

- `packages/renderer/src/index.ts`: long-running renderer HTTP process.
- `packages/renderer/src/request.ts`: bounded render request contract.
- `packages/renderer/src/render.ts`: Playwright projection, inspection, and screenshot behavior.
- `tests/browser/dashboard.spec.mjs`: deterministic dashboard browser contract.
- `tests/browser/fixtures/dashboard.mjs`: shared deterministic browser data.
- `scripts/verify-preview.mjs`: production web build and preview smoke.
- `scripts/record-proof.mjs`: GIF/contact-sheet evidence capture.
- `scripts/verify-live-analysis.mjs`: live MU analysis and renderer verification.
- `scripts/render-analysis.mjs`: one-shot local render fallback.
- `scripts/smoke-api.sh`: live local API workflow.
- `scripts/check-docs.mjs`: local Markdown link validation.

## Portable Agent Skill

- `skills/unimarket/SKILL.md`: operating rules and progressive reference routing.
- `skills/unimarket/scripts/unimarket-agent.sh`: deterministic endpoint helper.
- `skills/unimarket/references/api.md`: operational API shapes.
- `skills/unimarket/references/markets.md`: Polymarket and Hyperliquid nuances.
- `skills/unimarket/agents/openai.yaml`: agent integration metadata.

## Repository Configuration

- `package.json`: canonical root commands and toolchain metadata.
- `pnpm-workspace.yaml`: workspace discovery.
- `tsconfig.base.json`: shared TypeScript contract.
- `.env.example`: API runtime configuration template.
- `.github/workflows/`: static checks, package tests, builds, and browser verification.
- `AGENTS.md`: change routing, invariants, synchronization, and handoff rules.
