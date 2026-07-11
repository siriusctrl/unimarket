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
Chromium, continues into the MU Analysis Workspace, and writes:

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
- drawings present in the DOM but hidden under the financial-chart canvas;
- trend/channel anchors projecting outside the visible market range;
- missing or mislabeled approximate volume-profile bins.

For a single deployed analysis URL, including an exact draft revision, run:

```bash
pnpm render:analysis http://host/analysis/hyperliquid/xyz%3AMU artifacts/analysis/mu.png
pnpm render:analysis 'http://host/analysis/hyperliquid/xyz%3AMU?documentId=ana_example' artifacts/analysis/mu-draft.png
```

This captures the actual chart container without rebuilding the application and writes adjacent render metadata containing the candle hash, annotation count, rendered drawing IDs, and browser errors.

For repeated model review, keep the renderer running instead:

```bash
UNIMARKET_WEB_BASE_URL=https://app.example.com pnpm dev:renderer
curl -o draft.png 'http://localhost:3101/render?market=hyperliquid&reference=xyz%3AMU&documentId=ana_example'
```

The model must inspect `draft.png`, record a concrete visual critique, update the draft JSON, and request another image. The renderer stays provider-neutral and does not decide whether a line is analytically valid.

Report the absolute verification directory in the final handoff.

## Boundary

This pipeline proves frontend rendering and operator interactions, not the live
market adapters or database-backed dashboard aggregation. Continue to use the
API smoke playbook in [Testing](testing.md) for those integration boundaries.
