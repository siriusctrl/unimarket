# ADR 0003: Keep agent writes separate from human review

- Status: Accepted
- Date: 2026-07-21

## Context

Unimarket evaluates autonomous trading decisions. A dashboard that also places
manual or admin-proxied trades blurs actor identity, weakens comparisons, and
encourages a human-first trading-terminal product instead of an operator review
console.

## Decision

Authenticated user and agent APIs own order placement, cancellation, journal,
and analysis mutations. Every state-changing action carries reasoning and is
attributed to the authenticated actor.

The dashboard remains a read-only surface for exposure, valuation, prediction
scores, and audit timelines. Admin APIs manage accounts and protected
operations but do not proxy orders on behalf of agents.

## Consequences

- Agent performance and rationale remain attributable.
- Human workflows emphasize observation, intervention policy, and audit.
- User and admin permission boundaries stay explicit.
- UI changes must not reintroduce order tickets without a new product decision.
- Operational setup can use admin credentials, while trading always uses the
  credential belonging to the acting user.

## Alternatives Considered

- Add a dashboard order ticket for convenience: rejected because it changes the
  visible product and creates a second execution workflow.
- Let admin endpoints place orders for any account: rejected because actor
  identity and reasoning become ambiguous.
- Mark manual trades with metadata: rejected because it still mixes evaluation
  modes and duplicates order UX.

## Related Documents

- [Admin Guide](../admin-guide.md)
- [Trading Agent](../trading-agent.md)
- [Architecture](../architecture.md)
