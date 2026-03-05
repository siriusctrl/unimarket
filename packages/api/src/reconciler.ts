import { calculatePerpLiquidationPrice, executeFill, executePerpFill } from "@unimarket/core";
import type { MarketRegistry, Quote } from "@unimarket/markets";
import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "./db/client.js";
import { accounts, orderExecutionParams, orders, perpPositionState, positions, trades } from "./db/schema.js";
import { eventBus } from "./events.js";
import { getTakerFeeRate } from "./fees.js";
import { makeId, nowIso } from "./utils.js";

const getFirst = async <T>(query: Promise<T[]>): Promise<T | undefined> => {
  const rows = await query;
  return rows[0];
};

const defaultMaintenanceMarginRatio = Number(process.env.MAINTENANCE_MARGIN_RATIO) || 0.05;

export const reconcilePendingOrders = async (
  registry: MarketRegistry,
  accountIds?: string[],
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
    .where(accountIds && accountIds.length > 0 ? and(eq(orders.status, "pending"), inArray(orders.accountId, accountIds)) : eq(orders.status, "pending"))
    .orderBy(asc(orders.createdAt))
    .all();

  let filled = 0;
  let cancelled = 0;
  let skipped = 0;
  const filledOrderIds: string[] = [];
  const cancelledOrderIds: string[] = [];
  const cancelledOrderIdSet = new Set<string>();
  const pendingOrdersBySymbol = new Map<string, typeof pendingOrders>();

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
          const updated = await db
            .update(orders)
            .set({
              status: "cancelled",
              cancelReasoning:
                errorCode === "SYMBOL_NOT_FOUND"
                  ? "Auto-cancelled: symbol no longer available"
                  : "Auto-cancelled: upstream contract no longer exists (404)",
              cancelledAt,
            })
            .where(and(eq(orders.id, order.id), eq(orders.status, "pending")))
            .run();

          if (updated.rowsAffected === 0) continue;

          cancelled += 1;
          cancelledOrderIds.push(order.id);
          cancelledOrderIdSet.add(order.id);

          const userId = userIdsByAccountId.get(order.accountId);
          if (userId) {
            eventBus.emit({
              type: "order.cancelled",
              userId,
              accountId: order.accountId,
              orderId: order.id,
              data: {
                market: order.market,
                symbol: order.symbol,
                side: order.side,
                quantity: order.quantity,
                reasoning:
                  errorCode === "SYMBOL_NOT_FOUND"
                    ? "Auto-cancelled: symbol no longer available"
                    : "Auto-cancelled: upstream contract no longer exists (404)",
                cancelledAt,
              },
            });
          }
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
      const adapter = registry.get(pendingOrder.market);
      const isPerp = Boolean(adapter?.capabilities.includes("funding"));
      const filledAt = nowIso();
      const persisted = await db.transaction(async (tx) => {
        const account = await getFirst(tx.select().from(accounts).where(eq(accounts.id, pendingOrder.accountId)).limit(1).all());
        if (!account) return null;

        const existingPosition = await getFirst(
          tx
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

        const existingPerp = isPerp && existingPosition
          ? await tx.select().from(perpPositionState).where(eq(perpPositionState.positionId, existingPosition.id)).get()
          : null;
        const persistedParams = await tx
          .select()
          .from(orderExecutionParams)
          .where(eq(orderExecutionParams.orderId, pendingOrder.id))
          .get();
        const leverage = persistedParams?.leverage ?? 1;
        const reduceOnly = persistedParams?.reduceOnly ?? false;
        const takerFeeRate = persistedParams?.takerFeeRate ?? getTakerFeeRate(pendingOrder.market);

        const spotFillResult = isPerp
          ? null
          : executeFill({
              balance: account.balance,
              position: existingPosition ? { quantity: existingPosition.quantity, avgCost: existingPosition.avgCost } : null,
              side: pendingOrder.side as "buy" | "sell",
              quantity: pendingOrder.quantity,
              price: quotePrice,
              allowShort: false,
              takerFeeRate,
            });
        const perpFillResult = isPerp
          ? executePerpFill({
              balance: account.balance,
              position: existingPosition
                ? {
                    quantity: existingPosition.quantity,
                    avgCost: existingPosition.avgCost,
                    margin:
                      existingPerp?.margin ??
                      Number((Math.abs(existingPosition.quantity * existingPosition.avgCost) / Math.max(existingPerp?.leverage ?? leverage, 1)).toFixed(6)),
                    leverage: existingPerp?.leverage ?? leverage,
                    maintenanceMarginRatio: existingPerp?.maintenanceMarginRatio ?? defaultMaintenanceMarginRatio,
                  }
                : null,
              side: pendingOrder.side as "buy" | "sell",
              quantity: pendingOrder.quantity,
              price: quotePrice,
              leverage,
              maintenanceMarginRatio: existingPerp?.maintenanceMarginRatio ?? defaultMaintenanceMarginRatio,
              reduceOnly,
              takerFeeRate,
            })
          : null;
        const fillResult = isPerp ? perpFillResult : spotFillResult;
        if (!fillResult) {
          throw new Error("Order fill result not generated during reconciliation");
        }

        const claimedOrder = await tx
          .update(orders)
          .set({ status: "filled", filledPrice: quotePrice, filledAt, cancelReasoning: null, cancelledAt: null })
          .where(and(eq(orders.id, pendingOrder.id), eq(orders.status, "pending")))
          .run();
        if (claimedOrder.rowsAffected === 0) return null;

        const updatedAccount = await tx.update(accounts).set({ balance: fillResult.nextBalance }).where(eq(accounts.id, account.id)).run();
        if (updatedAccount.rowsAffected === 0) {
          throw new Error("Account update failed during reconciliation");
        }

        if (!fillResult.nextPosition) {
          if (existingPosition) {
            const deletedPosition = await tx.delete(positions).where(eq(positions.id, existingPosition.id)).run();
            if (deletedPosition.rowsAffected === 0) {
              throw new Error("Position delete failed during reconciliation");
            }

            if (isPerp) {
              await tx.delete(perpPositionState).where(eq(perpPositionState.positionId, existingPosition.id)).run();
            }
          }
        } else if (existingPosition) {
          const updatedPosition = await tx
            .update(positions)
            .set({ quantity: fillResult.nextPosition.quantity, avgCost: fillResult.nextPosition.avgCost })
            .where(eq(positions.id, existingPosition.id))
            .run();
          if (updatedPosition.rowsAffected === 0) {
            throw new Error("Position update failed during reconciliation");
          }

          if (isPerp) {
            const perpNextPosition = perpFillResult?.nextPosition;
            if (!perpNextPosition) {
              throw new Error("Perp position state missing for reconciled fill");
            }
            const liquidationPrice = calculatePerpLiquidationPrice(perpNextPosition);
            await tx
              .insert(perpPositionState)
              .values({
                positionId: existingPosition.id,
                accountId: account.id,
                market: pendingOrder.market,
                symbol: pendingOrder.symbol,
                leverage: perpNextPosition.leverage,
                margin: perpNextPosition.margin,
                maintenanceMarginRatio: perpNextPosition.maintenanceMarginRatio,
                liquidationPrice,
                updatedAt: filledAt,
              })
              .onConflictDoUpdate({
                target: perpPositionState.positionId,
                set: {
                  leverage: perpNextPosition.leverage,
                  margin: perpNextPosition.margin,
                  maintenanceMarginRatio: perpNextPosition.maintenanceMarginRatio,
                  liquidationPrice,
                  updatedAt: filledAt,
                },
              })
              .run();
          }
        } else {
          const newPositionId = makeId("pos");
          await tx
            .insert(positions)
            .values({
              id: newPositionId,
              accountId: account.id,
              market: pendingOrder.market,
              symbol: pendingOrder.symbol,
              quantity: fillResult.nextPosition.quantity,
              avgCost: fillResult.nextPosition.avgCost,
            })
            .run();

          if (isPerp) {
            const perpNextPosition = perpFillResult?.nextPosition;
            if (!perpNextPosition) {
              throw new Error("Perp position state missing for reconciled fill");
            }
            const liquidationPrice = calculatePerpLiquidationPrice(perpNextPosition);
            await tx
              .insert(perpPositionState)
              .values({
                positionId: newPositionId,
                accountId: account.id,
                market: pendingOrder.market,
                symbol: pendingOrder.symbol,
                leverage: perpNextPosition.leverage,
                margin: perpNextPosition.margin,
                maintenanceMarginRatio: perpNextPosition.maintenanceMarginRatio,
                liquidationPrice,
                updatedAt: filledAt,
              })
              .run();
          }
        }

        await tx
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
            fee: fillResult.feePaid,
            createdAt: filledAt,
          })
          .run();

        return { userId: account.userId, accountId: account.id };
      });

      if (!persisted) {
        skipped += 1;
        continue;
      }

      eventBus.emit({
        type: "order.filled",
        userId: persisted.userId,
        accountId: persisted.accountId,
        orderId: pendingOrder.id,
        data: {
          market: pendingOrder.market,
          symbol: pendingOrder.symbol,
          side: pendingOrder.side as "buy" | "sell",
          quantity: pendingOrder.quantity,
          executionPrice: quotePrice,
          filledAt,
          limitPrice: pendingOrder.limitPrice,
        },
      });

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
      if (result.cancelled > 0) {
        console.log(`[reconciler] auto-cancelled ${result.cancelled} pending orders`);
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
