# Building an Autonomous Trading Agent

## TL;DR

Give this document + `skills/unimarket/SKILL.md` to any coding agent (Codex, Claude Code, Gemini CLI, etc.) and ask it to:

> Set up a workspace and run autonomous paper-trading cycles against the unimarket API at `http://localhost:3100`. Use `skills/unimarket/SKILL.md` as the API contract and `skills/unimarket/scripts/unimarket-agent.sh` as the helper script. Register once, then loop: research markets → decide (trade or no-trade) → journal your reasoning → sleep → repeat.

That's it. The rest of this document explains _why_ this works and how to tune it.

---

## Workspace Layout

```
my-agent-workspace/
├── AGENTS.md              # Agent instructions (rules, constraints)
├── prompts/
│   └── trader.prompt.md   # The per-cycle prompt fed to `codex exec` (or equivalent)
├── .state/
│   ├── agent.env          # API_KEY, USER_ID, ACCOUNT_ID (mode 600, never logged)
│   ├── memory.md          # Persistent strategy memory across cycles
│   └── next_sleep_secs    # Dynamic interval control (agent writes, runner reads)
├── logs/
│   └── strategy-journal.md  # Local cycle history
├── skills/
│   └── unimarket/         # Copied or symlinked from the main repo
├── run.sh                 # Runner script (loop + codex exec)
└── package.json           # Optional, for local tool deps
```

**Key principle:** the workspace is a _throwaway sandbox_. The agent can create scratch files, build tools, and experiment freely. Durable state lives in two places: the **API journal** (server-side, source of truth) and **`.state/`** (local).

---

## Step 1: AGENTS.md — Ground Rules

This file gives the coding agent its standing instructions. Keep it short:

```markdown
# Agent Worker Instructions

Mission: run autonomous paper trading cycles against unimarket API and improve strategy over time.

Rules:
- Use `skills/unimarket/SKILL.md` as primary API contract.
- Use `skills/unimarket/scripts/unimarket-agent.sh` for endpoint operations.
- Never use admin endpoints.
- Persist runtime state under `.state/` and logs under `logs/`.
- All state-changing operations must include non-empty `reasoning`.
- Use idempotency keys for retry-safe writes.
- Discover markets dynamically; do not hardcode market assumptions.
- Never print or log raw API keys.
```

---

## Step 2: The Cycle Prompt

The prompt is what gets executed each cycle. A good cycle prompt has four sections:

### 1. Objective
```
Run exactly ONE autonomous trading cycle against http://localhost:3100, then exit.
Primary objective: maximize long-run paper-trading profitability.
```

### 2. Autonomy scope
- Agent chooses its own strategy, holding period, and market interpretation
- May trade or choose no-trade if edge is weak
- Prefer action over meta-work (don't spend cycles redesigning infrastructure)

### 3. Cycle requirements
Each cycle must:
1. Read account + portfolio + current open orders + positions
2. Research markets (search + quote/orderbook reads)
3. Make one explicit decision: **trade** or **no-trade**
4. If trading, keep size prudent and avoid duplicate pending orders
5. Write one concise journal entry to the API (every cycle, no exceptions)
6. Choose next trigger interval and write seconds to `.state/next_sleep_secs`

### 4. State handling
- Reuse `.state/agent.env` if present
- If missing, register one user and persist `BASE_URL`/`API_KEY`/`USER_ID`/`ACCOUNT_ID`

### Journal entries

Each cycle's journal entry should cover these points (in any format):
- What actions were taken (or why no action)
- Key evidence and reasoning behind the decision
- Current hypothesis and confidence level
- Risks, invalidators, and what to watch for next

---

## Step 3: The Runner Script

The runner is a simple shell loop that invokes the coding agent repeatedly:

```bash
#!/usr/bin/env bash
set -euo pipefail

WS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_FILE="$WS_DIR/prompts/trader.prompt.md"
SLEEP_HINT_FILE="$WS_DIR/.state/next_sleep_secs"
DEFAULT_SLEEP=300  # 5 minutes
MIN_SLEEP=60
MAX_SLEEP=7200

mkdir -p "$WS_DIR/.state" "$WS_DIR/logs"

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
  echo "[$(date -Is)] cycle start"

  # Replace this with your coding agent's CLI
  codex exec \
    --dangerously-bypass-approvals-and-sandbox \
    --skip-git-repo-check \
    -C "$WS_DIR" \
    "$(cat "$PROMPT_FILE")" || true

  sleep_secs="$(resolve_sleep)"
  echo "[$(date -Is)] sleeping ${sleep_secs}s"
  sleep "$sleep_secs"
done
```

**Swap `codex exec` for any agent CLI.** The pattern is the same: feed the prompt, let the agent do one cycle, sleep, repeat.

### Dynamic sleep

The agent controls its own pacing by writing to `.state/next_sleep_secs`:
- Quiet market, no active risk → `300–3600`
- Active positions, pending orders, high volatility → `60–900`
- The runner clamps to `[MIN_SLEEP, MAX_SLEEP]` for safety

---

## Design Patterns

### State persistence

| What | Where | Why |
|------|-------|-----|
| Credentials | `.state/agent.env` | Survives restarts, mode 600 for safety |
| Cycle decisions | API journal (`POST /api/journal`) | Server-side source of truth, queryable |
| Strategy memory | `.state/memory.md` | Working hypotheses, lessons, invalidators |
| Scratch data | `.state/cycle_*.json` | Disposable per-cycle data files |
| Local history | `logs/strategy-journal.md` | Full local record of all cycle entries |

### Risk management

Good defaults for a paper-trading agent:
- Max 2 orders per cycle, max quantity 2 per order (conservative start)
- Skip if account cash is too low
- Avoid duplicate pending orders for same market+symbol+side
- Keep directional exposure modest
- All trades require `reasoning` and `Idempotency-Key`

### Research pattern

Each cycle should follow: **discover → filter → evaluate → decide**:

1. `GET /api/markets` — discover available markets
2. `GET /api/markets/:market/search` — find candidates
3. `GET /api/markets/:market/quotes` — batch price check
4. `GET /api/markets/:market/orderbooks` — evaluate execution quality (spread, depth)
5. Read account/positions/orders for current state
6. Make decision with full context

### Memory across cycles

The agent can maintain a `memory.md` file with:
- Working hypotheses and what evidence supports them
- What would invalidate current positions
- Lessons learned from previous cycles
- Market observations that persist across time

This gives the agent continuity even though each `codex exec` invocation is stateless.

---

## Monitoring

Once the runner is going, you can monitor from the admin dashboard:

1. **Dashboard** (`http://localhost:5173`) — equity chart, agent cards, activity feed
2. **API journal** — `GET /api/account/timeline` shows the agent's full decision history
3. **Local logs** — `tail -f logs/strategy-journal.md`
4. **Runner output** — cycle start/end timestamps and sleep intervals

---

## Quick Start Checklist

1. [ ] Clone or create a workspace directory
2. [ ] Copy `skills/unimarket/` from the main repo (or symlink it)
3. [ ] Write `AGENTS.md` with ground rules
4. [ ] Write `prompts/trader.prompt.md` with cycle instructions
5. [ ] Write `run.sh` with the runner loop
6. [ ] Start the unimarket server (`ADMIN_API_KEY=xxx pnpm dev`)
7. [ ] Run `bash run.sh` and watch it trade
