import {
  adminAmountSchema,
  calculateMarketValue,
  calculateUnrealizedPnl,
  paginationQuerySchema,
} from "@unimarket/core";
import type { MarketRegistry } from "@unimarket/markets";
import { and, desc, eq, gte } from "drizzle-orm";
import { Hono } from "hono";

import type { AppVariables } from "../auth.js";
import { db } from "../db/client.js";
import { accounts, equitySnapshots, journal, orders, positions, users } from "../db/schema.js";
import { jsonError } from "../errors.js";
import { deserializeTags, getUserAccount, parseJson, parseQuery, withErrorHandling } from "../helpers.js";
import { makeId, nowIso } from "../utils.js";

export const createAdminRoutes = (registry: MarketRegistry) => {
  const router = new Hono<{ Variables: AppVariables }>();

  router.post(
    "/accounts/:id/deposit",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, adminAmountSchema);
      if (!parsed.success) return parsed.response;

      const accountId = c.req.param("id");
      const account = await db.select().from(accounts).where(eq(accounts.id, accountId)).get();
      if (!account) return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");

      const nextBalance = Number((account.balance + parsed.data.amount).toFixed(6));
      await db.update(accounts).set({ balance: nextBalance }).where(eq(accounts.id, accountId)).run();
      return c.json({ balance: nextBalance });
    }),
  );

  router.post(
    "/accounts/:id/withdraw",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, adminAmountSchema);
      if (!parsed.success) return parsed.response;

      const accountId = c.req.param("id");
      const account = await db.select().from(accounts).where(eq(accounts.id, accountId)).get();
      if (!account) return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");

      if (account.balance < parsed.data.amount) {
        return jsonError(c, 400, "INSUFFICIENT_BALANCE", "Insufficient balance for withdrawal");
      }

      const nextBalance = Number((account.balance - parsed.data.amount).toFixed(6));
      await db.update(accounts).set({ balance: nextBalance }).where(eq(accounts.id, accountId)).run();
      return c.json({ balance: nextBalance });
    }),
  );



  // Backward-compatible aliases (legacy user-id based admin routes)
  router.post(
    "/users/:id/deposit",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, adminAmountSchema);
      if (!parsed.success) return parsed.response;

      const userId = c.req.param("id");
      const account = await getUserAccount(userId);
      if (!account) return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");

      const nextBalance = Number((account.balance + parsed.data.amount).toFixed(6));
      await db.update(accounts).set({ balance: nextBalance }).where(eq(accounts.id, account.id)).run();
      return c.json({ balance: nextBalance });
    }),
  );

  router.post(
    "/users/:id/withdraw",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, adminAmountSchema);
      if (!parsed.success) return parsed.response;

      const userId = c.req.param("id");
      const account = await getUserAccount(userId);
      if (!account) return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");

      if (account.balance < parsed.data.amount) {
        return jsonError(c, 400, "INSUFFICIENT_BALANCE", "Insufficient balance for withdrawal");
      }

      const nextBalance = Number((account.balance - parsed.data.amount).toFixed(6));
      await db.update(accounts).set({ balance: nextBalance }).where(eq(accounts.id, account.id)).run();
      return c.json({ balance: nextBalance });
    }),
  );

  router.get(
    "/overview",
    withErrorHandling(async (c) => {
      const userRows = await db.select().from(users).all();
      const accountRows = await db.select().from(accounts).all();
      const positionRows = await db.select().from(positions).all();

      const primaryAccountByUserId = new Map<string, (typeof accountRows)[number]>();
      for (const account of [...accountRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (!primaryAccountByUserId.has(account.userId)) {
          primaryAccountByUserId.set(account.userId, account);
        }
      }

      const quotePriceByKey = new Map<string, number | null>();
      const quoteTimestampByKey = new Map<string, string | null>();

      for (const row of positionRows) {
        const key = `${row.market}::${row.symbol}`;
        if (quotePriceByKey.has(key)) continue;

        const adapter = registry.get(row.market);
        if (!adapter) {
          quotePriceByKey.set(key, null);
          quoteTimestampByKey.set(key, null);
          continue;
        }

        try {
          const quote = await adapter.getQuote(row.symbol);
          quotePriceByKey.set(key, quote.price);
          quoteTimestampByKey.set(key, quote.timestamp);
        } catch {
          quotePriceByKey.set(key, null);
          quoteTimestampByKey.set(key, null);
        }
      }

      const positionsByAccount = new Map<string, Array<{
        market: string; symbol: string; quantity: number; avgCost: number;
        currentPrice: number | null; marketValue: number | null;
        unrealizedPnl: number | null; quoteTimestamp: string | null;
      }>>();

      const marketSummaryById = new Map<string, {
        marketId: string; marketName: string; users: Set<string>;
        positions: number; totalQuantity: number; totalMarketValue: number;
        totalUnrealizedPnl: number; quotedPositions: number; unpricedPositions: number;
      }>();

      const accountById = new Map(accountRows.map((a) => [a.id, a]));

      for (const row of positionRows) {
        const account = accountById.get(row.accountId);
        if (!account) continue;

        const adapter = registry.get(row.market);
        const key = `${row.market}::${row.symbol}`;
        const currentPrice = quotePriceByKey.get(key) ?? null;
        const quoteTimestamp = quoteTimestampByKey.get(key) ?? null;

        const marketValue = currentPrice === null ? null : calculateMarketValue({ quantity: row.quantity, avgCost: row.avgCost }, currentPrice);
        const unrealizedPnl = currentPrice === null ? null : calculateUnrealizedPnl({ quantity: row.quantity, avgCost: row.avgCost }, currentPrice);

        if (!positionsByAccount.has(row.accountId)) positionsByAccount.set(row.accountId, []);
        positionsByAccount.get(row.accountId)?.push({
          market: row.market, symbol: row.symbol, quantity: row.quantity, avgCost: row.avgCost,
          currentPrice, marketValue, unrealizedPnl, quoteTimestamp,
        });

        if (!marketSummaryById.has(row.market)) {
          marketSummaryById.set(row.market, {
            marketId: row.market, marketName: adapter?.displayName ?? row.market,
            users: new Set(), positions: 0, totalQuantity: 0, totalMarketValue: 0,
            totalUnrealizedPnl: 0, quotedPositions: 0, unpricedPositions: 0,
          });
        }

        const ms = marketSummaryById.get(row.market)!;
        ms.positions += 1;
        ms.totalQuantity += row.quantity;
        ms.users.add(account.userId);

        if (marketValue === null || unrealizedPnl === null) {
          ms.unpricedPositions += 1;
        } else {
          ms.quotedPositions += 1;
          ms.totalMarketValue += marketValue;
          ms.totalUnrealizedPnl += unrealizedPnl;
        }
      }

      const agents = userRows
        .map((user) => {
          const primaryAccount = primaryAccountByUserId.get(user.id) ?? null;
          const agentPositions = [...(primaryAccount ? positionsByAccount.get(primaryAccount.id) ?? [] : [])].sort((a, b) =>
            `${a.market}:${a.symbol}`.localeCompare(`${b.market}:${b.symbol}`),
          );

          const totalBalance = Number((primaryAccount?.balance ?? 0).toFixed(6));
          const totalMarketValue = Number(agentPositions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0).toFixed(6));
          const totalUnrealizedPnl = Number(agentPositions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0).toFixed(6));
          const totalEquity = Number((totalBalance + totalMarketValue).toFixed(6));

          return {
            userId: user.id, userName: user.name, createdAt: user.createdAt,
            accountId: primaryAccount?.id ?? null, accountName: primaryAccount?.name ?? null,
            balance: totalBalance, positions: agentPositions,
            totals: { positions: agentPositions.length, balance: totalBalance, marketValue: totalMarketValue, unrealizedPnl: totalUnrealizedPnl, equity: totalEquity },
          };
        })
        .sort((a, b) => b.totals.equity - a.totals.equity);

      const markets = Array.from(marketSummaryById.values())
        .map((m) => ({
          marketId: m.marketId, marketName: m.marketName, users: m.users.size,
          positions: m.positions, totalQuantity: m.totalQuantity,
          totalMarketValue: Number(m.totalMarketValue.toFixed(6)),
          totalUnrealizedPnl: Number(m.totalUnrealizedPnl.toFixed(6)),
          quotedPositions: m.quotedPositions, unpricedPositions: m.unpricedPositions,
        }))
        .sort((a, b) => b.totalMarketValue - a.totalMarketValue);

      const totalBalance = Number(agents.reduce((sum, a) => sum + a.totals.balance, 0).toFixed(6));
      const totalMarketValue = Number(markets.reduce((sum, m) => sum + m.totalMarketValue, 0).toFixed(6));
      const totalUnrealizedPnl = Number(markets.reduce((sum, m) => sum + m.totalUnrealizedPnl, 0).toFixed(6));
      const totalEquity = Number((totalBalance + totalMarketValue).toFixed(6));

      // Record equity snapshots (fire-and-forget, at most once per 5 minutes per agent)
      const now = nowIso();
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      for (const agent of agents) {
        const recent = await db.select({ id: equitySnapshots.id })
          .from(equitySnapshots)
          .where(and(eq(equitySnapshots.userId, agent.userId), gte(equitySnapshots.snapshotAt, fiveMinAgo)))
          .limit(1)
          .all();
        if (recent.length === 0) {
          await db.insert(equitySnapshots).values({
            id: makeId("snap"),
            userId: agent.userId,
            balance: agent.totals.balance,
            marketValue: agent.totals.marketValue,
            equity: agent.totals.equity,
            unrealizedPnl: agent.totals.unrealizedPnl,
            snapshotAt: now,
          }).run();
        }
      }

      return c.json({
        generatedAt: now,
        totals: { users: userRows.length, positions: positionRows.length, balance: totalBalance, marketValue: totalMarketValue, unrealizedPnl: totalUnrealizedPnl, equity: totalEquity },
        markets,
        agents,
      });
    }),
  );

  router.get(
    "/users/:id/timeline",
    withErrorHandling(async (c) => {
      const userId = c.req.param("id");
      const user = await db.select().from(users).where(eq(users.id, userId)).get();
      if (!user) return jsonError(c, 404, "USER_NOT_FOUND", "User not found");

      const parsedQuery = parseQuery(c, paginationQuerySchema);
      if (!parsedQuery.success) return parsedQuery.response;

      const acc = await getUserAccount(userId);

      const orderRows = acc
        ? await db.select().from(orders).where(eq(orders.accountId, acc.id)).orderBy(desc(orders.createdAt)).all()
        : [];
      const journalRows = await db.select().from(journal).where(eq(journal.userId, userId)).orderBy(desc(journal.createdAt)).all();

      const events = [
        ...orderRows.map((row) => ({
          type: row.status === "cancelled" ? "order_cancelled" : "order",
          data: {
            id: row.id,
            symbol: row.symbol,
            market: row.market,
            side: row.side,
            quantity: row.quantity,
            status: row.status,
            filledPrice: row.filledPrice,
            symbolName: null as string | null,
          },
          reasoning: row.status === "cancelled" ? row.cancelReasoning : row.reasoning,
          createdAt: row.createdAt,
        })),
        ...journalRows.map((row) => ({
          type: "journal",
          data: {
            id: row.id,
            content: row.content,
            tags: deserializeTags(row.tags),
            symbolName: null as string | null,
          },
          reasoning: null,
          createdAt: row.createdAt,
        })),
      ]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(parsedQuery.data.offset, parsedQuery.data.offset + parsedQuery.data.limit);

      // Resolve Polymarket symbol names via Gamma API
      const pmSymbols = new Set<string>();
      for (const event of events) {
        if ("market" in event.data && event.data.market === "polymarket" && event.data.symbol) {
          pmSymbols.add(event.data.symbol);
        }
      }

      const symbolNameMap = new Map<string, string>();
      if (pmSymbols.size > 0) {
        try {
          const ids = [...pmSymbols].join(",");
          const gammaRes = await fetch(`https://gamma-api.polymarket.com/markets?clob_token_ids=${encodeURIComponent(ids)}&limit=50`);
          if (gammaRes.ok) {
            const markets = (await gammaRes.json()) as Array<Record<string, unknown>>;
            for (const m of markets) {
              const question = typeof m.question === "string" ? m.question : null;
              const tokens = Array.isArray(m.tokens) ? m.tokens : [];
              // map each token_id → "Question (Outcome)"
              for (const token of tokens) {
                if (typeof token === "object" && token !== null) {
                  const t = token as Record<string, unknown>;
                  const tokenId = typeof t.token_id === "string" ? t.token_id : null;
                  const outcome = typeof t.outcome === "string" ? t.outcome : null;
                  if (tokenId && question) {
                    symbolNameMap.set(tokenId, outcome ? `${question} — ${outcome}` : question);
                  }
                }
              }
            }
          }
        } catch {
          // Non-critical: skip name resolution on error
        }
      }

      // Attach resolved names
      for (const event of events) {
        if ("symbol" in event.data && event.data.symbol) {
          const name = symbolNameMap.get(event.data.symbol);
          if (name) event.data.symbolName = name;
        }
      }

      return c.json({ events });
    }),
  );

  const RANGE_MS: Record<string, number> = {
    "1w": 7 * 86_400_000,
    "1m": 30 * 86_400_000,
    "3m": 90 * 86_400_000,
    "6m": 180 * 86_400_000,
    "1y": 365 * 86_400_000,
  };

  router.get(
    "/equity-history",
    withErrorHandling(async (c) => {
      const range = (c.req.query("range") ?? "1m").toLowerCase();
      const ms = RANGE_MS[range] ?? RANGE_MS["1m"];
      const since = new Date(Date.now() - ms).toISOString();

      const rows = await db.select()
        .from(equitySnapshots)
        .where(gte(equitySnapshots.snapshotAt, since))
        .orderBy(equitySnapshots.snapshotAt)
        .all();

      // Group by userId
      const byUser = new Map<string, Array<{
        snapshotAt: string;
        equity: number;
        balance: number;
        marketValue: number;
        unrealizedPnl: number;
      }>>();

      for (const row of rows) {
        if (!byUser.has(row.userId)) byUser.set(row.userId, []);
        byUser.get(row.userId)!.push({
          snapshotAt: row.snapshotAt,
          equity: row.equity,
          balance: row.balance,
          marketValue: row.marketValue,
          unrealizedPnl: row.unrealizedPnl,
        });
      }

      // Get user names
      const userRows = await db.select().from(users).all();
      const nameById = new Map(userRows.map((u) => [u.id, u.name]));

      const series = Array.from(byUser.entries()).map(([userId, snapshots]) => ({
        userId,
        userName: nameById.get(userId) ?? userId,
        snapshots,
      }));

      return c.json({ range, series });
    }),
  );

  return router;
};
