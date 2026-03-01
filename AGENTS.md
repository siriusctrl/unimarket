# AGENTS.md

Principles for agents contributing to this repository.

This file intentionally stays **high-level and durable**. Avoid coupling behavior to folder names, temporary endpoints, or implementation details that may change.

## Mission

Build a reliable, market-agnostic paper trading platform that:
- simulates trading safely (no real money movement),
- can be integrated by humans and agents through standard APIs,
- remains easy to extend to new markets.

## Product Invariants (Do Not Break)

1. **Simulation-first**
   - Never execute real trades or require private exchange keys for core paper-trading flows.

2. **Market agnostic by default**
   - Core behavior must not depend on one specific market.
   - New markets should plug in through adapters, not by rewriting business logic.

3. **Explicit decision trace**
   - State-changing actions should carry rationale so users can audit decisions.
   - Preserve a readable timeline of what happened and why.

4. **Clear permission boundaries**
   - User operations and admin operations must be separated.
   - Authentication should map credentials to identity consistently.

5. **Self-describing integration**
   - Agents should discover capabilities at runtime.
   - Avoid hardcoded assumptions in clients when discovery can be used.

## Engineering Principles

1. **Domain logic stays pure**
   - Keep trading rules deterministic and testable.
   - Isolate side effects (network, storage, framework wiring) from core decision logic.

2. **Design for extension, not branching complexity**
   - Prefer composable interfaces/adapters over market-specific conditionals spread across the codebase.

3. **Prefer simple, observable systems**
   - Favor straightforward data flow and debuggable behavior over clever abstractions.

4. **Be strict at boundaries**
   - Validate all external input.
   - Return consistent error shapes and stable error codes.

5. **Backward compatibility matters**
   - Evolve APIs carefully.
   - If behavior changes, update docs and migration notes in the same change.

## Testing Principles

- Test core business behavior with deterministic unit tests.
- Test adapters with controlled/mocked upstream responses.
- Test API behavior as contract tests (status codes, payload shape, auth/permission behavior).
- Treat regressions in accounting, position math, and authorization as high severity.

## Documentation Principles

- Keep README user-facing.
- Keep AGENTS.md principle-based (this file).
- Keep integration instructions machine-readable and implementation-ready.
- When behavior changes, update docs in the same PR/commit.

## Change Checklist (Before Merge)

- Does this preserve market-agnostic behavior?
- Does this preserve auditability of decisions?
- Does this preserve auth and admin boundaries?
- Are contracts (API + errors) still consistent?
- Are tests and docs updated together?

If any answer is "no" or "unclear", stop and redesign before merging.
