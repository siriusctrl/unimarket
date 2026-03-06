# Refactor Roadmap

This document tracks the main simplification and cleanup opportunities in the codebase after the current order-lifecycle and admin-dashboard refactors.

It is intentionally pragmatic:

- focus on reducing duplicate orchestration,
- keep market-agnostic behavior intact,
- preserve auditability and permission boundaries,
- avoid speculative abstractions that do not remove real complexity.

## Current Direction

The codebase has already made two important moves:

- order placement now runs through shared services instead of separate user/admin execution paths
- order cancellation now also runs through shared services instead of separate route/worker code

The next simplifications should continue in the same direction:

- keep routes thin
- keep workers focused on scheduling and trigger decisions
- keep read models and write paths centralized

## Recommended Refactor Sequence

### 1. Shared Portfolio Read Models

Priority: high
Status: completed

Problem:

- user portfolio and admin single-user portfolio both enrich positions, quotes, and pending orders
- admin overview also contains a third read-model path that re-derives similar account and position summaries

Current duplication exists across:

- `packages/api/src/routes/account.ts`
- `packages/api/src/routes/admin.ts`

Why this matters:

- portfolio fields can drift between user and admin views
- quote handling and perp enrichment rules are being maintained in more than one place
- small additions such as `maintenanceMargin`, `accumulatedFunding`, or future audit fields require repeated edits

Implemented shape:

- `packages/api/src/services/portfolio-read.ts`
- `packages/api/src/services/admin-overview.ts`

These builders now centralize:

- quote fetching
- perp state enrichment
- funding aggregation
- open-order shaping
- account-level totals

### 2. Move Snapshot Writes Out Of `GET /api/admin/overview`

Priority: high
Status: completed

Problem:

- the admin overview route performs asynchronous `equity_snapshots` writes after building the response

Current location:

- `packages/api/src/routes/admin.ts`

Why this matters:

- a read endpoint is performing background writes
- failure handling is hidden in route-local `void (...)` fire-and-forget code
- snapshot cadence policy is tied to a dashboard read path instead of an explicit worker or service

Implemented shape:

- `/api/admin/overview` is read-only
- snapshot generation runs through `packages/api/src/workers/equity-snapshotter.ts`
- snapshot cadence is controlled by `EQUITY_SNAPSHOT_INTERVAL_MS`

### 3. Shared Worker Scaffold

Priority: medium
Status: completed

Problem:

- reconciler, settler, funding collector, and liquidator all repeat the same interval/locking/logging structure

Current locations:

- `packages/api/src/workers/reconciler.ts`
- `packages/api/src/workers/settler.ts`
- `packages/api/src/workers/funding-collector.ts`
- `packages/api/src/workers/liquidator.ts`

Why this matters:

- interval parsing, running guards, startup logging, and stop handlers are duplicated
- worker ergonomics are inconsistent by file over time

Implemented shape:

- `packages/api/src/workers/periodic-worker.ts`
- reconciler, settler, funding collector, liquidator, and equity snapshotter all use the shared scaffold

### 4. Shared Timeline Contract Types

Priority: medium
Status: completed

Problem:

- the web dashboard re-declares the timeline event contract instead of consuming a shared source

Current duplication exists across:

- `packages/api/src/timeline.ts`
- `packages/api/src/platform/events.ts`
- `packages/web/src/lib/useAgentTimeline.ts`
- `packages/web/src/components/ActivityFeed.tsx`

Why this matters:

- adding or renaming event fields requires touching both API and web manually
- UI assumptions can drift from the actual backend timeline payload

Implemented shape:

- timeline event record types live in `@unimarket/core`
- API timeline builders and dashboard timeline hooks consume the shared contract

### 5. Break Up `TradePage`

Priority: medium
Status: completed

Problem:

- the admin trade console currently owns market loading, agent loading, quote refresh, search, portfolio fetch, order form state, and trader creation in one page component

Current location:

- `packages/web/src/pages/TradePage.tsx`

Why this matters:

- the file is large and mixes multiple concerns
- repeated auth-failure handling is embedded in page-level effects
- API response types are redeclared inline instead of being shared or centralized

Implemented shape:

- `packages/web/src/pages/TradePage.tsx` now acts as an orchestration page
- trade-specific UI lives under `packages/web/src/components/trade/`
- networking and response types no longer live inline inside the page file

### 6. Shared Admin API Client Helpers

Priority: medium
Status: completed

Problem:

- admin web code still performs repeated `fetch + auth header + auth failure handling + response parsing` logic

Current locations:

- `packages/web/src/pages/TradePage.tsx`
- other admin-facing web modules

Implemented shape:

- `packages/web/src/lib/admin-api.ts`
- admin hooks and pages now share:
  - auth header injection
  - `401/403` logout handling
  - JSON error extraction
  - typed response parsing

## Future Reconciler Evolution

Priority: not short-term

The current reconciler model is intentionally simple:

- global scan of `pending` limit orders
- one quote fetch per `market:symbol`
- executable-side check using `buy -> ask`, `sell -> bid`
- once crossed, the whole order fills

This is the right short-term model for paper trading because it is easy to explain and easy to audit.

### What may be added later

If the platform later wants more realistic limit-order simulation, the reconciler may evolve toward:

- depth-aware matching for markets with `orderbook`
- price-time priority instead of simple traversal order
- partial fills
- explicit residual pending quantity

### What should not happen

The platform should not introduce a half-step model such as:

- “sometimes liquidity matters”
- but without orderbook depth
- and without partial fills
- and without price-time priority

That would be more complex than the current model without being meaningfully more correct.

### Recommended future boundary

If this work is taken on later:

- keep the current simple reconciler as the default path
- enable depth-aware behavior only for markets that expose `orderbook`
- preserve a clear, documented distinction between:
  - trigger price
  - execution price
  - filled quantity
  - remaining pending quantity

This is intentionally a future path, not an immediate roadmap item.

## What To Avoid

These changes would likely add churn without removing enough complexity:

- merging user and admin HTTP routes into one path
- pushing permission logic down into core trading functions
- adding market-specific branches outside adapters and capability checks
- introducing a generic abstraction before there are at least two real call sites

## Decision Rule

Before taking on any simplification, ask:

1. Does it remove an actual duplicate business rule or orchestration path?
2. Does it preserve auditability and permission boundaries?
3. Does it make the next feature cheaper without hiding current behavior?

If the answer is not clearly yes, the refactor probably is not worth doing yet.
