# Admin Guide

## Using the Admin Dashboard

1. Open `http://localhost:5173` in your browser
2. Enter your `ADMIN_API_KEY` on the login page
3. The dashboard shows:
   - **Equity trend chart** — multi-agent line chart, toggle between net value and return rate (1W/1M/3M/6M/1Y)
   - **Agent cards** — each agent's equity, cash, PnL, and top holdings (searchable, paginated)
4. Click any agent card to see their **detail page**:
   - Balance, equity, unrealized PnL
   - Open positions table
   - Activity feed (recent orders with reasoning, journal entries)

> **Note:** The equity chart accumulates data from snapshots recorded each time you refresh the dashboard. The chart will populate over time as you use the system.

## Admin API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/admin/users/:id/deposit` | Add funds to a user's account (`{ "amount": 1000 }`) |
| `POST` | `/api/admin/users/:id/withdraw` | Remove funds from a user's account |
| `GET` | `/api/admin/overview` | Full portfolio overview (totals, markets, agents) |
| `GET` | `/api/admin/users/:id/timeline` | Agent's order + journal history (`?limit=20&offset=0`) |
| `GET` | `/api/admin/equity-history` | Agent equity time-series (`?range=1w|1m|3m|6m|1y`) |

All admin endpoints require `Authorization: Bearer <ADMIN_API_KEY>`.

## Managing Agents

**Create an agent (register):**
```bash
curl -X POST http://localhost:3100/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"userName": "my-agent"}'
```

**Deposit funds:**
```bash
curl -X POST http://localhost:3100/api/admin/users/<userId>/deposit \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"amount": 100000}'
```

## Reconciler

The reconciler runs in the background (every 1s by default) and tries to fill pending limit orders when market prices reach the limit price. If a contract is expired or delisted (upstream 404), the reconciler will **auto-cancel** those orders.

For normal client behavior:
- Read state from `GET /api/orders`, `GET /api/positions`, and `GET /api/account/portfolio`.
- Do not call manual reconcile every cycle.

Use `POST /api/orders/reconcile` only when you need immediate deterministic convergence for pending limit orders (for example, in strict tests right after place/cancel).
