# ADR 0001: Keep execution simulation-only

- Status: Accepted
- Date: 2026-07-21

## Context

Unimarket consumes live public data from prediction and perpetual markets, but
its purpose is to compare agent decisions in an observable environment. Adding
live order routing would introduce custody, exchange authentication, approval,
and loss boundaries that are fundamentally different from paper trading.

## Decision

Core order placement, fills, positions, funding, settlement, and liquidation
remain simulated. Market adapters provide public discovery and pricing data but
do not execute exchange orders. Normal operation never requires private
exchange keys.

## Consequences

- Trading behavior stays deterministic and testable against controlled quotes.
- Agent credentials authorize Unimarket state, not an external brokerage account.
- Public market outages can affect reference data without exposing funds.
- Exchange-level fill realism is intentionally limited and must be documented.
- Any future live-execution product requires a separate explicit architecture
  and security decision rather than an adapter flag or silent mode switch.

## Alternatives Considered

- Support paper and live modes in the same order path: rejected because a
  configuration mistake could cross a real-money boundary.
- Require users to provide read/write exchange keys: rejected because it is not
  needed for the product's evaluation and audit goals.

## Related Documents

- [Trading Model](../trading-model.md)
- [Architecture](../architecture.md)
- [ADR 0002](0002-capability-driven-market-adapters.md)
