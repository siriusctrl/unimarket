import { executeFill } from "@unimarket/core";
import type { MarketRegistry } from "@unimarket/markets";
import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "./db/client.js";
import { accounts, orders, positions, trades } from "./db/schema.js";
import { makeId, nowIso } from "./utils.js";

const getFirst = async <T>(query: Promise<T[]>): Promise<T | undefined> => {
  const rows = await query;
  return rows[0];
};

export const reconcilePendingOrders = async (registry: MarketRegistry, accountIds?: string[]): Promise<{ processed: number; filled: number; skipped: number; filledOrderIds: string[] }> => {
  const pendingOrders = await db
    .select()
    .from(orders)
    .where(accountIds && accountIds.length > 0 ? and(eq(orders.status, "pending"), inArray(orders.accountId, accountIds)) : eq(orders.status, "pending"))
    .orderBy(asc(orders.createdAt))
    .all();

  let filled = 0;
  let skipped = 0;
  const filledOrderIds: string[] = [];

  for (const pendingOrder of pendingOrders) {
    if (pendingOrder.type !== "limit" || pendingOrder.limitPrice === null) {
      skipped += 1;
      continue;
    }

    const adapter = registry.get(pendingOrder.market);
    if (!adapter) {
      skipped += 1;
      continue;
    }

    let quotePrice: number;
    try {
      const quote = await adapter.getQuote(pendingOrder.symbol);
      quotePrice = pendingOrder.side === "buy" ? (quote.ask ?? quote.price) : (quote.bid ?? quote.price);
    } catch {
      skipped += 1;
      continue;
    }

    const shouldFill =
      pendingOrder.side === "buy" ? quotePrice <= pendingOrder.limitPrice : quotePrice >= pendingOrder.limitPrice;

    if (!shouldFill) {
      skipped += 1;
      continue;
    }

    const account = await getFirst(db.select().from(accounts).where(eq(accounts.id, pendingOrder.accountId)).limit(1).all());
    if (!account) {
      skipped += 1;
      continue;
    }

    const existingPosition = await getFirst(
      db
        .select()
        .from(positions)
        .where(
          and(
            eq(positions.accountId, account.id),
            eq(positions.market, pendingOrder.market),
            eq(positions.symbol, pendingOrder.symbol),
          ),
        )
        .limit(1)
        .all(),
    );

    try {
      const fillResult = executeFill({
        balance: account.balance,
        position: existingPosition ? { quantity: existingPosition.quantity, avgCost: existingPosition.avgCost } : null,
        side: pendingOrder.side as "buy" | "sell",
        quantity: pendingOrder.quantity,
        price: quotePrice,
        allowShort: false,
      });

      await db.update(accounts).set({ balance: fillResult.nextBalance }).where(eq(accounts.id, account.id)).run();

      if (!fillResult.nextPosition) {
        if (existingPosition) {
          await db.delete(positions).where(eq(positions.id, existingPosition.id)).run();
        }
      } else if (existingPosition) {
        await db
          .update(positions)
          .set({ quantity: fillResult.nextPosition.quantity, avgCost: fillResult.nextPosition.avgCost })
          .where(eq(positions.id, existingPosition.id))
          .run();
      } else {
        await db
          .insert(positions)
          .values({
            id: makeId("pos"),
            accountId: account.id,
            market: pendingOrder.market,
            symbol: pendingOrder.symbol,
            quantity: fillResult.nextPosition.quantity,
            avgCost: fillResult.nextPosition.avgCost,
          })
          .run();
      }

      const filledAt = nowIso();
      await db
        .insert(trades)
        .values({
          id: makeId("trd"),
          orderId: pendingOrder.id,
          accountId: account.id,
          market: pendingOrder.market,
          symbol: pendingOrder.symbol,
          side: pendingOrder.side,
          quantity: pendingOrder.quantity,
          price: quotePrice,
          createdAt: filledAt,
        })
        .run();

      await db
        .update(orders)
        .set({ status: "filled", filledPrice: quotePrice, filledAt })
        .where(eq(orders.id, pendingOrder.id))
        .run();

      filled += 1;
      filledOrderIds.push(pendingOrder.id);
    } catch {
      skipped += 1;
    }
  }

  return { processed: pendingOrders.length, filled, skipped, filledOrderIds };
};

const DEFAULT_INTERVAL_MS = 15_000;

export const startReconciler = (registry: MarketRegistry): (() => void) => {
  const intervalMs = Number(process.env.RECONCILE_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await reconcilePendingOrders(registry);
      if (result.filled > 0) {
        console.log(`[reconciler] filled ${result.filled} pending orders`);
      }
    } catch (err) {
      console.error("[reconciler] error:", err);
    } finally {
      running = false;
    }
  }, intervalMs);

  console.log(`[reconciler] started (interval: ${intervalMs}ms)`);

  return () => {
    clearInterval(timer);
    console.log("[reconciler] stopped");
  };
};
