import {
  calculateMarketValue,
  calculateUnrealizedPnl,
  paginationQuerySchema,
} from "@unimarket/core";
import type { MarketRegistry } from "@unimarket/markets";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { AppVariables } from "../auth.js";
import { db } from "../db/client.js";
import { journal, orders, positions } from "../db/schema.js";
import { jsonError } from "../errors.js";
import { deserializeTags, getUserAccount, parseQuery, withErrorHandling } from "../helpers.js";

export const createAccountRoutes = (registry: MarketRegistry) => {
  const account = new Hono<{ Variables: AppVariables }>();

  account.get(
    "/",
    withErrorHandling(async (c) => {
      const userId = c.get("userId");
      if (!userId || userId === "admin") {
        return jsonError(c, 400, "INVALID_USER", "Invalid user for account retrieval");
      }

      const acc = await getUserAccount(userId);
      if (!acc) return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");

      return c.json({ id: acc.id, name: acc.name, balance: acc.balance, createdAt: acc.createdAt });
    }),
  );

  account.get(
    "/portfolio",
    withErrorHandling(async (c) => {
      const userId = c.get("userId");
      if (!userId || userId === "admin") {
        return jsonError(c, 400, "INVALID_USER", "Invalid user for portfolio");
      }

      const acc = await getUserAccount(userId);
      if (!acc) return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");

      const rows = await db.select().from(positions).where(eq(positions.accountId, acc.id)).all();

      const resultPositions: Array<{
        market: string;
        symbol: string;
        quantity: number;
        avgCost: number;
        currentPrice: number;
        unrealizedPnl: number;
        marketValue: number;
      }> = [];

      let totalMarketValue = 0;
      for (const row of rows) {
        const adapter = registry.get(row.market);
        if (!adapter) continue;

        const quote = await adapter.getQuote(row.symbol);
        const marketValue = calculateMarketValue({ quantity: row.quantity, avgCost: row.avgCost }, quote.price);
        const unrealizedPnl = calculateUnrealizedPnl({ quantity: row.quantity, avgCost: row.avgCost }, quote.price);
        totalMarketValue += marketValue;

        resultPositions.push({
          market: row.market,
          symbol: row.symbol,
          quantity: row.quantity,
          avgCost: row.avgCost,
          currentPrice: quote.price,
          unrealizedPnl,
          marketValue,
        });
      }

      const totalValue = Number((acc.balance + totalMarketValue).toFixed(6));
      const totalPnl = Number(resultPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0).toFixed(6));

      return c.json({
        accountId: acc.id,
        balance: acc.balance,
        positions: resultPositions,
        totalValue,
        totalPnl,
      });
    }),
  );

  account.get(
    "/timeline",
    withErrorHandling(async (c) => {
      const userId = c.get("userId");
      if (!userId || userId === "admin") {
        return jsonError(c, 400, "INVALID_USER", "Invalid user for timeline");
      }

      const acc = await getUserAccount(userId);
      if (!acc) return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");

      const parsedQuery = parseQuery(c, paginationQuerySchema);
      if (!parsedQuery.success) return parsedQuery.response;

      const orderRows = await db.select().from(orders).where(eq(orders.accountId, acc.id)).orderBy(desc(orders.createdAt)).all();
      const journalRows = await db.select().from(journal).where(eq(journal.userId, acc.userId)).orderBy(desc(journal.createdAt)).all();

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
          },
          reasoning: null,
          createdAt: row.createdAt,
        })),
      ]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(parsedQuery.data.offset, parsedQuery.data.offset + parsedQuery.data.limit);

      return c.json({ events });
    }),
  );

  return account;
};
