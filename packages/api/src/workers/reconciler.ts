import type { MarketRegistry, Quote } from "@unimarket/markets";
import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { accounts, orders } from "../db/schema.js";
import { startPeriodicWorker } from "./periodic-worker.js";
import { cancelPendingOrder } from "../services/order-cancellation.js";
import { createOrderPlacementService } from "../services/order-placement.js";
import { nowIso } from "../utils.js";

export const reconcilePendingOrders = async (
  registry: MarketRegistry,
): Promise<{
  processed: number;
  filled: number;
  cancelled: number;
  skipped: number;
  filledOrderIds: string[];
  cancelledOrderIds: string[];
}> => {
  const pendingOrders = await db
    .select()
    .from(orders)
    .where(eq(orders.status, "pending"))
    .orderBy(asc(orders.createdAt))
    .all();

  let filled = 0;
  let cancelled = 0;
  let skipped = 0;
  const filledOrderIds: string[] = [];
  const cancelledOrderIds: string[] = [];
  const cancelledOrderIdSet = new Set<string>();
  const pendingOrdersBySymbol = new Map<string, typeof pendingOrders>();
  const { fillPendingOrder } = createOrderPlacementService(registry);

  for (const pendingOrder of pendingOrders) {
    const symbolKey = `${pendingOrder.market}:${pendingOrder.symbol}`;
    const grouped = pendingOrdersBySymbol.get(symbolKey);
    if (grouped) {
      grouped.push(pendingOrder);
    } else {
      pendingOrdersBySymbol.set(symbolKey, [pendingOrder]);
    }
  }

  const quoteMap = new Map<string, Quote>();
  const failedQuoteKeys = new Set<string>();

  for (const [symbolKey, groupedOrders] of pendingOrdersBySymbol) {
    const sampleOrder = groupedOrders[0];
    if (!sampleOrder) continue;

    const adapter = registry.get(sampleOrder.market);
    if (!adapter) {
      failedQuoteKeys.add(symbolKey);
      console.warn(`[reconciler] missing adapter for ${sampleOrder.market}; skipping ${groupedOrders.length} orders`);
      continue;
    }

    try {
      const quote = await adapter.getQuote(sampleOrder.symbol);
      quoteMap.set(symbolKey, quote);
    } catch (error) {
      failedQuoteKeys.add(symbolKey);

      // Auto-cancel orders for expired/delisted contracts (404 from upstream)
      const is404 = error instanceof Error && error.message.includes("(404)");
      const errorCode =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code)
          : null;
      const shouldAutoCancel = is404 || errorCode === "SYMBOL_NOT_FOUND";
      if (shouldAutoCancel) {
        const userIdsByAccountId = new Map<string, string>();
        const uniqueAccountIds = [...new Set(groupedOrders.map((order) => order.accountId))];
        if (uniqueAccountIds.length > 0) {
          const accountRows = await db
            .select({ id: accounts.id, userId: accounts.userId })
            .from(accounts)
            .where(inArray(accounts.id, uniqueAccountIds))
            .all();
          for (const accountRow of accountRows) {
            userIdsByAccountId.set(accountRow.id, accountRow.userId);
          }
        }

        for (const order of groupedOrders) {
          const cancelledAt = nowIso();
          const reasoning =
            errorCode === "SYMBOL_NOT_FOUND"
              ? "Auto-cancelled: symbol no longer available"
              : "Auto-cancelled: upstream contract no longer exists (404)";
          const result = await cancelPendingOrder({
            order,
            reasoning,
            cancelledAt,
            userId: userIdsByAccountId.get(order.accountId),
          });

          if (result.kind !== "cancelled") continue;

          cancelled += 1;
          cancelledOrderIds.push(order.id);
          cancelledOrderIdSet.add(order.id);
        }
        console.warn(`[reconciler] auto-cancelled ${groupedOrders.length} orders for expired contract ${symbolKey}`);
      } else {
        console.warn(`[reconciler] quote fetch failed for ${symbolKey}; skipping ${groupedOrders.length} orders`, error);
      }
    }
  }

  for (const pendingOrder of pendingOrders) {
    if (cancelledOrderIdSet.has(pendingOrder.id)) {
      continue;
    }

    if (pendingOrder.type !== "limit" || pendingOrder.limitPrice === null) {
      skipped += 1;
      continue;
    }

    const symbolKey = `${pendingOrder.market}:${pendingOrder.symbol}`;
    if (failedQuoteKeys.has(symbolKey)) {
      skipped += 1;
      continue;
    }

    const quote = quoteMap.get(symbolKey);
    if (!quote) {
      skipped += 1;
      continue;
    }

    const quotePrice = pendingOrder.side === "buy" ? (quote.ask ?? quote.price) : (quote.bid ?? quote.price);

    const shouldFill =
      pendingOrder.side === "buy" ? quotePrice <= pendingOrder.limitPrice : quotePrice >= pendingOrder.limitPrice;

    if (!shouldFill) {
      skipped += 1;
      continue;
    }

    try {
      const persisted = await fillPendingOrder({
        pendingOrder,
        executionPrice: quotePrice,
        filledAt: nowIso(),
      });

      if (persisted.kind !== "filled") {
        skipped += 1;
        continue;
      }

      filled += 1;
      filledOrderIds.push(pendingOrder.id);
    } catch {
      skipped += 1;
    }
  }

  return { processed: pendingOrders.length, filled, cancelled, skipped, filledOrderIds, cancelledOrderIds };
};

const DEFAULT_INTERVAL_MS = 1_000;

export const startReconciler = (registry: MarketRegistry): (() => void) => {
  return startPeriodicWorker({
    name: "reconciler",
    defaultIntervalMs: DEFAULT_INTERVAL_MS,
    envVar: "RECONCILE_INTERVAL_MS",
    run: () => reconcilePendingOrders(registry),
    onResult: (result) => {
      if (result.filled > 0) {
        console.log(`[reconciler] filled ${result.filled} pending orders`);
      }
      if (result.cancelled > 0) {
        console.log(`[reconciler] auto-cancelled ${result.cancelled} pending orders`);
      }
    },
  });
};
