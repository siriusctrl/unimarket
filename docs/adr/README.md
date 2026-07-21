# Architecture Decision Records

Architecture Decision Records explain why a durable choice was made. Current
runtime contracts remain in their topic documents; ADRs preserve decision
context, credible alternatives, and consequences that would otherwise be lost
in commit history or chat.

## When To Write One

Add an ADR when a change establishes or revises a cross-package invariant,
persistence or public contract, security boundary, or other costly-to-reverse
choice with credible alternatives. Ordinary fixes, local refactors, and
straightforward features do not need an ADR.

## Workflow

1. Create `NNNN-short-title.md` using the next four-digit number.
2. Start with `Proposed`; change it to `Accepted` when adopted.
3. Treat accepted records as historical. Replace a decision with a new ADR that
   declares `Supersedes`; mark the old record `Superseded by` without rewriting
   its original reasoning.
4. Use `Refines` for a narrower decision that leaves the original accepted.
5. Update this index and link the ADR from the relevant current contract.

Use this shape:

```text
# ADR NNNN: Title

- Status: Proposed | Accepted | Rejected | Superseded
- Date: YYYY-MM-DD
- Supersedes: ADR NNNN (when applicable)
- Refines: ADR NNNN (scope, when applicable)

## Context
## Decision
## Consequences
## Alternatives Considered
## Related Documents
```

## Index

- [ADR 0001: Keep execution simulation-only](0001-simulation-only-execution.md)
- [ADR 0002: Discover markets through capability-driven adapters](0002-capability-driven-market-adapters.md)
- [ADR 0003: Keep agent writes separate from human review](0003-agent-writes-human-review.md)
- [ADR 0004: Store provider-neutral chart-analysis documents](0004-provider-neutral-chart-analysis.md)
