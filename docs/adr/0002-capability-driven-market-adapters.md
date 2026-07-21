# ADR 0002: Discover markets through capability-driven adapters

- Status: Accepted
- Date: 2026-07-21

## Context

Prediction markets and perpetual futures expose different identifiers,
constraints, histories, funding, orderbooks, and resolution behavior. Scattered
checks such as `market === "hyperliquid"` would couple application logic to the
first integrations and make public capabilities drift from implementation.

## Decision

Every market integrates through the `MarketAdapter` contract and registry.
Required methods provide common discovery, quote, normalization, and trading
constraints. Optional methods express capabilities such as browse, orderbook,
funding, history, and resolution. API clients discover those capabilities at
runtime.

Market-specific normalization and upstream response handling stay inside the
adapter package. The API, engines, workers, and clients branch on capabilities,
not market names.

## Consequences

- New markets have one explicit integration boundary.
- The API can reject unsupported behavior consistently.
- Adapter tests can mock upstream services without involving persistence.
- Cross-market business rules remain reusable.
- A capability added to an adapter must also update its public descriptor,
  contract tests, docs, and portable skill projection.

## Alternatives Considered

- Maintain a separate static capability table: rejected because it can drift
  from implemented methods.
- Add market-specific branches in API routes and workers: rejected because it
  duplicates integration knowledge outside its owner.
- Force every adapter to fake every capability: rejected because silent empty
  behavior is less observable than an explicit unsupported capability.

## Related Documents

- [Architecture](../architecture.md)
- [API Reference](../api-reference.md)
- [Trading Model](../trading-model.md)
