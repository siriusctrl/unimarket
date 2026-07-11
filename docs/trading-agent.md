# Building an Autonomous Trading Agent

## TL;DR

Give this document and `skills/unimarket/SKILL.md` to any coding agent and ask it to:

> Set up a workspace and run autonomous paper-trading cycles against the unimarket API at `http://localhost:3100`. Use `skills/unimarket/SKILL.md` as the API contract and `skills/unimarket/scripts/unimarket-agent.sh` as the helper script. Register once, then loop: research markets -> decide -> journal -> sleep -> repeat.

For the system behavior behind those APIs, also point the agent at [Trading Model](trading-model.md).

## Workspace Layout

```text
my-agent-workspace/
├── AGENTS.md
├── prompts/
│   └── trader.prompt.md
├── scripts/
│   └── bootstrap-account.sh
├── .state/
│   ├── agent.env
│   ├── watchlist.md
│   ├── memory.md
│   └── next_sleep_secs
├── logs/
│   └── strategy-journal.md
├── skills/
│   └── unimarket/
├── run.sh
└── package.json
```

Durable state should live in two places:
- server-side API records such as orders, timeline, and journal
- local `.state/` files for credentials, wake-up priorities, and long-lived research notes

## Step 1: AGENTS.md

Keep the standing instructions short and explicit.

```markdown
# Agent Worker Instructions

Mission: run autonomous paper trading cycles against unimarket API and improve strategy over time.

Rules:
- Use `skills/unimarket/SKILL.md` as primary API contract.
- Use `skills/unimarket/scripts/unimarket-agent.sh` for endpoint operations.
- Prefer helper workflow commands such as `register-safe`, `snapshot`, `orders-open`, `history-summary`, and `scan` before writing custom plumbing.
- Prefer helper and CLI primitives for deterministic operations and stable data collection.
- Use ad-hoc code only for situational analysis, candidate comparison, or research the helper does not already provide.
- If the same derived metric or fetch pattern keeps appearing across cycles, move it into helper or API instead of re-implementing it forever.
- Never use admin endpoints.
- Persist runtime state under `.state/` and logs under `logs/`.
- All state-changing operations must include non-empty `reasoning`.
- Use idempotency keys for retry-safe writes.
- Discover markets dynamically; do not hardcode market assumptions.
- Never print or log raw API keys.
- Reuse `.state/agent.env` when present; register once only when credentials are missing.
- Read `.state/watchlist.md` at the start of every cycle.
- Use `.state/memory.md` on demand when a watchlist item, thesis, or candidate needs historical context.
- Update `.state/watchlist.md` every cycle with what to check first after the next wake-up.
- Update `.state/memory.md` only with durable lessons, hypotheses, and postmortem-quality notes.
- Compare investable options broadly before committing to one thesis.
- Look for cross-market opportunities when the data supports them, but do not force them.
```

## Step 2: Cycle Prompt

A good per-cycle prompt has four parts.

### Objective

```text
Run exactly ONE autonomous trading cycle against http://localhost:3100, then exit.
Primary objective: maximize long-run paper-trading profitability.
```

### Autonomy scope

- choose strategy, holding period, and market interpretation independently
- trade only when there is a reasoned edge
- prefer action over infrastructure redesign during a live cycle

### Credential bootstrap

Before the first successful cycle:
- if `.state/agent.env` already exists, source it and reuse the saved credentials
- otherwise register exactly once, save `BASE_URL`, `API_KEY`, `USER_ID`, and `ACCOUNT_ID` into `.state/agent.env`, then `chmod 600 .state/agent.env`
- never print raw API keys in logs, journals, or final output

### Cycle requirements

Each cycle should:
1. source `.state/agent.env`, or bootstrap credentials if missing
2. read `.state/watchlist.md`, account, portfolio, orders, and positions
3. use `.state/memory.md` only when a watchlist item, thesis, or candidate needs historical context
4. research markets through browse/search, quotes, orderbooks, price history, and optional funding/resolve endpoints
5. start broad enough to compare the most investable available options before narrowing to the best overall idea
6. compare candidates using liquidity, spread, price action, catalysts, funding/resolve context, execution constraints, and current portfolio exposure
7. consider cross-market or relative-value opportunities when multiple markets express related themes or dislocations, but do not force one
8. decide explicitly between trade and no-trade
9. avoid duplicate pending orders
10. write one concise journal entry every cycle
11. append a short local summary to `logs/strategy-journal.md`
12. update `.state/watchlist.md` with what to check first after the next wake-up
13. update `.state/memory.md` only when there is a durable lesson, hypothesis change, or reusable research note worth keeping
14. write the next sleep interval to `.state/next_sleep_secs`

### Journal checklist

Every cycle journal entry should record:
- actions taken, or why no action was taken
- supporting evidence
- current hypothesis and confidence
- risks and invalidators
- what to check first after the next wake-up

### Watchlist and memory usage

Treat `.state/watchlist.md` as the first file to read at wake-up. It should stay short and operational:
- 1-5 references, themes, or cross-market relationships to check first next cycle
- the trigger, catalyst, or invalidator for each item
- enough context to focus attention quickly without re-reading old research

Treat `.state/memory.md` as a deeper notebook for on-demand retrieval:
- durable lessons that should survive many cycles
- active hypotheses that still need validation
- postmortem-quality notes that may help future decisions

The intended flow is simple:
1. read `watchlist.md` first every cycle
2. scan the market broadly
3. consult `memory.md` only when a live candidate or thesis seems relevant
4. update `watchlist.md` every cycle
5. update `memory.md` only when something durable changed

Watchlist should optimize wake-up attention. Memory should preserve reusable thinking.

### Boundary: API vs helper vs model

Use three layers with clear responsibilities:
- API defines stable, market-agnostic contracts plus audit-safe state changes.
- Helper and CLI utilities wrap deterministic operations such as auth, discovery, batch reads, account state reads, and journal or order writes.
- The model uses those stable primitives to compare opportunities, form hypotheses, decide between trade and no-trade, and update watchlist or memory.

A good default rule is:
- if a helper command already exists, use it instead of hand-writing `curl` or repetitive `jq` plumbing
- use custom shell, `jq`, or Node only for one-off situational analysis or candidate comparison
- when the same custom analysis appears repeatedly across cycles, move it down into helper or API
- keep subjective strategy views out of helper conventions; they belong in prompts, watchlists, memory, and journals

This keeps infra deterministic and reusable while leaving strategy and judgment to the model.

## Step 3: Bootstrap Credentials

The helper script now provides `register-safe`, so the bootstrap helper can stay thin and avoid custom credential plumbing.

```bash
#!/usr/bin/env bash
set -euo pipefail

WS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$WS_DIR/.state/agent.env"

mkdir -p "$WS_DIR/.state"

if [[ -f "$ENV_FILE" ]] && grep -q '^API_KEY=' "$ENV_FILE"; then
  exit 0
fi

BASE_URL="${BASE_URL:-http://localhost:3100}" \
  "$WS_DIR/skills/unimarket/scripts/unimarket-agent.sh" \
  --compact register-safe "codex-trader-$(date +%s)" "$ENV_FILE" >/dev/null
```

## Step 4: Runner Script

A minimal runner is enough.

```bash
#!/usr/bin/env bash
set -euo pipefail

WS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_FILE="$WS_DIR/prompts/trader.prompt.md"
SLEEP_HINT_FILE="$WS_DIR/.state/next_sleep_secs"
RUNNER_LOG="$WS_DIR/logs/runner.log"
DEFAULT_SLEEP=300
MIN_SLEEP=60
MAX_SLEEP=7200

mkdir -p "$WS_DIR/.state" "$WS_DIR/logs"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

resolve_sleep() {
  local raw=""
  [[ -f "$SLEEP_HINT_FILE" ]] && raw="$(tr -d ' \t\r\n' <"$SLEEP_HINT_FILE" || true)"
  local val="${raw:-$DEFAULT_SLEEP}"
  [[ "$val" =~ ^[0-9]+$ ]] || val="$DEFAULT_SLEEP"
  (( val < MIN_SLEEP )) && val="$MIN_SLEEP"
  (( val > MAX_SLEEP )) && val="$MAX_SLEEP"
  printf '%s' "$val"
}

while true; do
  {
    echo "[$(timestamp)] starting trading cycle"
    if codex exec \
      --yolo \
      --skip-git-repo-check \
      -C "$WS_DIR" \
      "$(cat "$PROMPT_FILE")"; then
      status=0
    else
      status=$?
    fi
    echo "[$(timestamp)] cycle exit status: $status"
    sleep_secs="$(resolve_sleep)"
    echo "[$(timestamp)] sleeping for ${sleep_secs}s"
    echo
  } | tee -a "$RUNNER_LOG"

  sleep_secs="$(resolve_sleep)"
  sleep "$sleep_secs"
done
```

Use `--yolo` or another full-access mode intentionally here. A sandboxed `codex exec --full-auto` may not be able to reach `http://localhost:3100` from inside the agent workspace.

For long-running operation, launch the runner inside `tmux` so the loop survives terminal disconnects. As helper commands grow, prefer helper-first data prep such as `snapshot`, `orders-open`, `history-summary`, and `scan` over repeating custom `curl` + `jq` glue inside every cycle.

## Design Patterns

### State persistence

| What | Where | Why |
|------|-------|-----|
| Credentials | `.state/agent.env` | Survives restarts, protect with mode `600` |
| Wake-up priorities | `.state/watchlist.md` | Short first-read checklist for the next cycle |
| Cycle decisions | API journal | Durable server-side source of truth |
| Strategy memory | `.state/memory.md` | On-demand notebook for durable lessons and hypotheses |
| Scratch data | `.state/cycle_*.json` | Disposable local working files |
| Local history | `logs/strategy-journal.md` | Full local trace |

### Risk defaults

Pragmatic starting defaults:
- no more than 2 orders per cycle
- conservative size while the strategy is immature
- skip when free balance is low
- avoid duplicate pending orders on the same thesis
- keep a clear written reason for every trade

### Research flow

Use a repeatable sequence:
1. read `.state/watchlist.md`
2. `GET /api/markets`
3. read each market's `browseOptions`, `searchSortOptions`, and `priceHistory` defaults
4. `GET /api/markets/:market/browse`
5. optional `GET /api/markets/:market/search` when the agent has a concrete query
6. keep the returned `reference` for the candidate you want to investigate
7. `GET /api/markets/:market/quotes`
8. `GET /api/markets/:market/orderbooks`
9. optional `GET /api/markets/:market/price-history?reference=...&interval=...&lookback=...`
10. optional `GET /api/analysis/context` when the agent needs deterministic indicators or intends to publish chart structure
11. optional draft -> browser/image review -> publish analysis-document flow
12. optional `funding` and `resolve` reads when the market supports them
13. account, portfolio, positions, and order reads
14. optional `memory.md` lookup for relevant live candidates or theses
15. decision and journal write
16. update `watchlist.md` and sleep hint

### Provider-neutral chart analysis

Use `analysis-context` to obtain candles, indicator output, drawing capabilities, and the exact snapshot hash. The model chooses the interval, lookback, focused viewport, and as many drawing layers as the structure requires; do not default every ticker to one annual channel. Write a `unimarket.chart-analysis/v1` JSON file using time-price coordinates, run `analysis-validate`, then use `analysis-create`.

Use `analysis-image-url` or `analysis-render` to inspect the exact draft. Critique whether anchors correspond to visible pivots, extensions remain relevant in the selected regime, labels collide, and channels or zones actually describe price behavior. Update the same draft and render again until the visual is coherent. Publish only after this loop; a successful DOM assertion is not visual approval.

The platform stores the document format and authenticated actor identity, not an AI provider. Never emit arbitrary JavaScript, CSS, canvas pixels, or unlabelled volume-at-price claims. `volumeProfile` is an OHLCV range approximation unless a future adapter provides finer trade data.

## What the Agent Should Know About the Platform

A few design facts help agents make better decisions.

- unimarket is simulation-first; it does not place real exchange trades in core flows
- discovery surfaces return market `reference` values; execution endpoints accept the same reference and let adapters normalize it internally
- `GET /api/markets` also advertises per-market `searchSortOptions` and `priceHistory` defaults so the agent can discover valid sort overrides, intervals, and lookbacks without hardcoding them
- the agent should treat `reference` as the only external market identifier it needs to persist between discovery and execution
- on Polymarket, a discovery `reference` is usually a slug preview, not an already-resolved token id
- when `searchSortOptions` is empty, keep the market's default search ranking instead of guessing sort keys
- markets without `funding` behave like spot inventory
- prediction-market bearish views are expressed by buying the opposite outcome token, not by opening a naked short
- markets with `funding` behave like perp markets with leverage, funding, and liquidation
- quote reads include convenience fields such as `mid`, `spreadAbs`, and `spreadBps` that help compare execution quality before trading
- timeline and SSE now include funding and liquidation as first-class events

## Monitoring

Useful operator views while an agent is running:
- dashboard at `http://localhost:5173` for balance, positions, and activity feed
- `GET /api/account/timeline` for durable audit history
- `GET /api/account/portfolio` for current exposure and PnL
- SSE via `GET /api/events` for real-time fills, cancels, settlements, funding, and liquidation
- local logs plus `.state/watchlist.md` and `.state/memory.md` for the agent's own context

## Quick Start Checklist

1. Create a dedicated workspace.
2. Initialize local folders such as `prompts/`, `scripts/`, `.state/`, `logs/`, and `skills/`.
3. Copy or symlink `skills/unimarket/`, for example `ln -s /path/to/unimarket/skills/unimarket skills/unimarket`.
4. Initialize `.state/watchlist.md` with a few first-pass ideas and `.state/next_sleep_secs`, for example `printf '%s\n' '- BTC trend reclaim' '- liquid near-dated Polymarket events' > .state/watchlist.md` and `printf '300\n' > .state/next_sleep_secs`.
5. Create `.state/memory.md` as a deeper notebook for durable lessons and reusable hypotheses.
6. Write `AGENTS.md`, the cycle prompt, the bootstrap helper, and the runner script.
7. `chmod +x scripts/bootstrap-account.sh run.sh`.
8. Start unimarket with `corepack pnpm dev`; configure `ADMIN_API_KEY` only when you need admin setup endpoints.
9. Launch the runner inside `tmux`.
10. Monitor the dashboard, timeline, portfolio, SSE stream, local logs, and watchlist evolution.
