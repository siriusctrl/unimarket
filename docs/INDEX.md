# Documentation

This index is the navigation and ownership map for Unimarket documentation.
`README.md` is the short product entry point; topic documents below own the
durable details.

## Start Here

- [Project README](../README.md): product boundary, quick start, and common commands.
- [Contributing](../CONTRIBUTING.md): local setup, validation, and change workflow.
- [AGENTS.md](../AGENTS.md): maintainer and coding-agent operating rules.
- [Configuration](configuration.md): environment variables and service modes.

## Product And API Contracts

- [API Reference](api-reference.md): canonical human-readable REST and SSE contract.
- [Trading Model](trading-model.md): fills, positions, funding, settlement, liquidation, and audit semantics.
- [Trading Agent](trading-agent.md): autonomous-agent workspace and operating cycle.
- [Admin Guide](admin-guide.md): operator dashboard and protected admin operations.

## Architecture And Maintenance

- [Architecture](architecture.md): deployment topology, package dependencies, runtime flows, and extension points.
- [Source Map](source-map.md): file-level entry points and ownership.
- [Architecture Decision Records](adr/README.md): costly-to-reverse decisions, alternatives, and consequences.
- [Testing](testing.md): verification layers, focused commands, smoke tests, and worker regressions.
- [Visual Verification](visual-verification.md): browser proof artifacts and inspection rules.
- [Delegating Work To Codex](codex-exec.md): repository-specific delegation prompt patterns.

## Portable Agent Integration

- [`skills/unimarket/SKILL.md`](../skills/unimarket/SKILL.md): portable agent workflow.
- [`skills/unimarket/references/api.md`](../skills/unimarket/references/api.md): concise operational API projection.
- [`skills/unimarket/references/markets.md`](../skills/unimarket/references/markets.md): market-specific operating notes.

The API reference in this directory is canonical. Skill references are compact
agent-facing projections and must be synchronized when their covered contract
changes.

## Historical Records

- [Completed Refactor Roadmap (2026)](archive/refactor-roadmap-2026.md): completed cleanup work and its original rationale.
