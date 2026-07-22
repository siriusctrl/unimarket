# ADR 0004: Store provider-neutral chart-analysis documents

- Status: Accepted
- Date: 2026-07-21

## Context

Agents need to communicate chart reasoning, indicators, and time-price
structures. Persisting generated JavaScript, canvas pixels, or provider-specific
tool payloads would make analysis non-portable, difficult to validate, and hard
to reproduce against the original market snapshot.

## Decision

Store versioned `unimarket.chart-analysis/v1` JSON documents. Documents contain
provider-neutral instrument metadata, candle range and hash, deterministic
indicator parameters, time-price drawings, thesis, invalidation, and actor
provenance.

The API validates documents against an exact candle snapshot. Drafts use
explicit revision control; published documents are immutable. The web client
projects structured data, and the separate Playwright renderer supports
inspect-revise-render loops without executing model-generated code.

## Consequences

- Any model or client can author the same public contract.
- Stored analysis can be replayed and audited against its candle hash.
- Rendering and model choice evolve independently.
- Visual quality still requires image inspection; schema validation alone does
  not prove that a drawing is useful or visible.
- Contract changes require schema versioning rather than silent reinterpretation.

## Alternatives Considered

- Store screenshots only: rejected because pixels are not queryable or
  reproducible.
- Store generated JavaScript or canvas commands: rejected because it creates an
  executable-content and provider-coupling boundary.
- Store provider-native messages as the document: rejected because they do not
  define a stable cross-provider rendering contract.

## Related Documents

- [Architecture](../architecture.md)
- [API Reference](../api-reference.md)
- [Visual Verification](../visual-verification.md)
