import {
  adminAmountSchema,
  calculateMarketValue,
  calculateUnrealizedPnl,
} from "@unimarket/core";
import type { MarketRegistry } from "@unimarket/markets";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

import type { AppVariables } from "../auth.js";
import { db } from "../db/client.js";
import { accounts, positions, users } from "../db/schema.js";
import { jsonError } from "../errors.js";
import { getUserAccount, parseJson, withErrorHandling } from "../helpers.js";
import { nowIso } from "../utils.js";

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

      return c.json({
        generatedAt: nowIso(),
        totals: { users: userRows.length, positions: positionRows.length, balance: totalBalance, marketValue: totalMarketValue, unrealizedPnl: totalUnrealizedPnl, equity: totalEquity },
        markets,
        agents,
      });
    }),
  );

  return router;
};
