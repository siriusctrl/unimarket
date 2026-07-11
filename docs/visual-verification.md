# Visual Verification

User-facing dashboard changes should leave browser evidence in addition to
passing static and behavioral checks.

## Evidence Pipeline

Run from the repository root:

```bash
pnpm verify:proof
```

The command starts the Vite dashboard, injects the same deterministic API data
used by the Playwright smoke suite, drives a fixed operator-review flow in
Chromium, and writes:

- `proof.gif`: quick end-to-end review;
- `recording.webm`: original Playwright recording;
- `final-screenshot.png`: full dashboard in the final state;
- `contact-sheet.png`: sampled frames for temporal inspection;
- `frame-check.json`: lightweight blank-frame statistics;
- `manifest.json`: actions, fixture, API calls, browser errors, and file paths;
- `inspection.txt`: short human-readable review checklist.

Artifacts are written to `artifacts/verification/<timestamp>/` and ignored by
git. The command requires Playwright Chromium (`pnpm setup:browsers`) and
`ffmpeg` on `PATH`.

## Required Review

Inspect `proof.gif` and `contact-sheet.png` before reporting a visual change as
complete. Use the full-page screenshot and frame report as supporting evidence.
Check for:

- blank or partially loaded frames;
- clipped cards, charts, tables, or toolbar controls;
- unreadable light/dark theme combinations;
- chart redraw flashes during range or mode changes;
- search results jumping or leaving stale cards;
- broken dashboard/detail navigation;
- timeline filters hiding the wrong event types;
- unexpected horizontal page overflow;
- fallback/error UI appearing with the deterministic fixture.

Report the absolute verification directory in the final handoff.

## Boundary

This pipeline proves frontend rendering and operator interactions, not the live
market adapters or database-backed dashboard aggregation. Continue to use the
API smoke playbook in [Testing](testing.md) for those integration boundaries.
