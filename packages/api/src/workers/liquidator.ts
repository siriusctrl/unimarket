import {
  calculatePerpMaintenanceMargin,
  calculatePerpPositionEquity,
  calculatePerpUnrealizedPnl,
} from "@unimarket/core";
import type { MarketRegistry, Quote } from "@unimarket/markets";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "../db/client.js";
import { accounts, liquidations, orderExecutionParams, orders, perpPositionState, positions, trades } from "../db/schema.js";
import { eventBus } from "../platform/events.js";
import { getTakerFeeRate } from "../fees.js";
import { startPeriodicWorker } from "./periodic-worker.js";
import {
  cancelPendingOrderInTx,
  emitOrderCancelled,
  type CancelledOrderRecord,
} from "../services/order-cancellation.js";
import { makeId, nowIso } from "../utils.js";

const DEFAULT_INTERVAL_MS = 5_000;

const roundCurrency = (value: number): number => Number(value.toFixed(6));

const selectLiquidationExecutionPrice = (
  quote: Pick<Quote, "price" | "bid" | "ask">,
  quantity: number,
): number => {
  if (quantity > 0) return quote.bid ?? quote.price;
  return quote.ask ?? quote.price;
};

type LiquidationSettlement = {
  executionPrice: number;
  triggerPositionEquity: number;
  maintenanceMargin: number;
  grossPayout: number;
  feeCharged: number;
  netPayout: number;
};

const calculateLiquidationSettlement = ({
  quantity,
  avgCost,
  margin,
  maintenanceMarginRatio,
  triggerPrice,
  executionPrice,
  takerFeeRate,
}: {
  quantity: number;
  avgCost: number;
  margin: number;
  maintenanceMarginRatio: number;
  triggerPrice: number;
  executionPrice: number;
  takerFeeRate: number;
}): LiquidationSettlement => {
  const triggerPositionView = {
    quantity,
    avgCost,
    margin,
    maintenanceMarginRatio,
  };
  const triggerPositionEquity = calculatePerpPositionEquity(triggerPositionView, triggerPrice);
  const maintenanceMargin = calculatePerpMaintenanceMargin(triggerPositionView, triggerPrice);
  const executionPositionEquity = calculatePerpPositionEquity(triggerPositionView, executionPrice);
  const grossPayout = roundCurrency(Math.max(0, executionPositionEquity));
  const requestedFee = roundCurrency(Math.abs(quantity) * executionPrice * takerFeeRate);
  const feeCharged = roundCurrency(Math.min(grossPayout, requestedFee));
  const netPayout = roundCurrency(Math.max(0, grossPayout - feeCharged));

  return {
    executionPrice,
    triggerPositionEquity,
    maintenanceMargin,
    grossPayout,
    feeCharged,
    netPayout,
  };
};

export const liquidateUnsafePerpPositions = async (
  registry: MarketRegistry,
): Promise<{ checked: number; liquidated: number; skipped: number }> => {
  const rows = await db.select().from(positions).all();

  let checked = 0;
  let liquidated = 0;
  let skipped = 0;

  for (const row of rows) {
    const adapter = registry.get(row.market);
    if (!adapter || !adapter.capabilities.includes("funding")) {
      skipped += 1;
      continue;
    }

    const state = await db.select().from(perpPositionState).where(eq(perpPositionState.positionId, row.id)).get();
    if (!state) {
      skipped += 1;
      continue;
    }

    checked += 1;

    let quote: Quote;
    try {
      quote = await adapter.getQuote(row.symbol);
    } catch {
      skipped += 1;
      continue;
    }

    const triggerPositionView = {
      quantity: row.quantity,
      avgCost: row.avgCost,
      margin: state.margin,
      maintenanceMarginRatio: state.maintenanceMarginRatio,
    };
    const maintenance = calculatePerpMaintenanceMargin(triggerPositionView, quote.price);
    const positionEquity = calculatePerpPositionEquity(triggerPositionView, quote.price);

    if (positionEquity > maintenance) {
      continue;
    }

    try {
      const outcome = await db.transaction(async (tx) => {
        const latestPosition = await tx.select().from(positions).where(eq(positions.id, row.id)).get();
        if (!latestPosition) return null;

        const latestState = await tx
          .select()
          .from(perpPositionState)
          .where(eq(perpPositionState.positionId, latestPosition.id))
          .get();
        if (!latestState) return null;

        const account = await tx.select().from(accounts).where(eq(accounts.id, latestPosition.accountId)).get();
        if (!account) return null;

        const latestTriggerPositionView = {
          quantity: latestPosition.quantity,
          avgCost: latestPosition.avgCost,
          margin: latestState.margin,
          maintenanceMarginRatio: latestState.maintenanceMarginRatio,
        };
        const latestMaintenance = calculatePerpMaintenanceMargin(latestTriggerPositionView, quote.price);
        const latestTriggerEquity = calculatePerpPositionEquity(latestTriggerPositionView, quote.price);
        if (latestTriggerEquity > latestMaintenance) {
          return null;
        }

        const closeSide: "buy" | "sell" = latestPosition.quantity > 0 ? "sell" : "buy";
        const closeQuantity = Math.abs(latestPosition.quantity);
        if (closeQuantity <= 0) {
          return null;
        }

        const executionPrice = selectLiquidationExecutionPrice(quote, latestPosition.quantity);
        const takerFeeRate = getTakerFeeRate(latestPosition.market);
        const settlement = calculateLiquidationSettlement({
          quantity: latestPosition.quantity,
          avgCost: latestPosition.avgCost,
          margin: latestState.margin,
          maintenanceMarginRatio: latestState.maintenanceMarginRatio,
          triggerPrice: quote.price,
          executionPrice,
          takerFeeRate,
        });

        const orderId = makeId("ord");
        const liquidationId = makeId("liq");
        const tradeId = makeId("trd");
        const liquidatedAt = nowIso();
        const nextBalance = roundCurrency(account.balance + settlement.netPayout);
        const unrealized = calculatePerpUnrealizedPnl(latestTriggerPositionView, quote.price);
        const pendingOrders = await tx
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.accountId, latestPosition.accountId),
              eq(orders.market, latestPosition.market),
              eq(orders.symbol, latestPosition.symbol),
              eq(orders.status, "pending"),
            ),
          )
          .all();

        let reduceOnlyOrderIds = new Set<string>();
        if (pendingOrders.length > 0) {
          const params = await tx
            .select()
            .from(orderExecutionParams)
            .where(inArray(orderExecutionParams.orderId, pendingOrders.map((order) => order.id)))
            .all();
          reduceOnlyOrderIds = new Set(params.filter((param) => param.reduceOnly).map((param) => param.orderId));
        }

        const cancelledReduceOnlyOrders: CancelledOrderRecord[] = [];
        for (const pendingOrder of pendingOrders) {
          if (!reduceOnlyOrderIds.has(pendingOrder.id)) continue;
          const cancelledAt = liquidatedAt;
          const cancelled = await cancelPendingOrderInTx(tx, {
            order: pendingOrder,
            reasoning: "Auto-cancelled: linked position was liquidated",
            cancelledAt,
          });
          if (!cancelled) continue;
          cancelledReduceOnlyOrders.push(cancelled);
        }

        const reasoning = `Auto-liquidation: maintenance margin breached (triggerPrice=${quote.price}, executionPrice=${settlement.executionPrice}, triggerEquity=${settlement.triggerPositionEquity}, maintenance=${settlement.maintenanceMargin}, grossPayout=${settlement.grossPayout}, fee=${settlement.feeCharged}, unrealizedPnl=${unrealized})`;

        await tx
          .insert(orders)
          .values({
            id: orderId,
            accountId: latestPosition.accountId,
            market: latestPosition.market,
            symbol: latestPosition.symbol,
            side: closeSide,
            type: "market",
            quantity: closeQuantity,
            limitPrice: null,
            status: "filled",
            filledPrice: settlement.executionPrice,
            reasoning,
            cancelReasoning: null,
            cancelledAt: null,
            filledAt: liquidatedAt,
            createdAt: liquidatedAt,
          })
          .run();

        await tx
          .insert(orderExecutionParams)
          .values({
            orderId,
            leverage: latestState.leverage,
            reduceOnly: true,
            takerFeeRate,
          })
          .onConflictDoNothing()
          .run();

        await tx
          .insert(trades)
          .values({
            id: tradeId,
            orderId,
            accountId: latestPosition.accountId,
            market: latestPosition.market,
            symbol: latestPosition.symbol,
            side: closeSide,
            quantity: closeQuantity,
            price: settlement.executionPrice,
            fee: settlement.feeCharged,
            createdAt: liquidatedAt,
          })
          .run();

        await tx
          .insert(liquidations)
          .values({
            id: liquidationId,
            orderId,
            accountId: latestPosition.accountId,
            market: latestPosition.market,
            symbol: latestPosition.symbol,
            side: closeSide,
            quantity: closeQuantity,
            leverage: latestState.leverage,
            margin: latestState.margin,
            maintenanceMarginRatio: latestState.maintenanceMarginRatio,
            triggerPrice: quote.price,
            executionPrice: settlement.executionPrice,
            triggerPositionEquity: settlement.triggerPositionEquity,
            maintenanceMargin: settlement.maintenanceMargin,
            grossPayout: settlement.grossPayout,
            feeCharged: settlement.feeCharged,
            netPayout: settlement.netPayout,
            reasoning,
            cancelledReduceOnlyOrderIds: JSON.stringify(cancelledReduceOnlyOrders.map((order) => order.id)),
            createdAt: liquidatedAt,
          })
          .run();

        const updatedAccount = await tx
          .update(accounts)
          .set({ balance: nextBalance })
          .where(eq(accounts.id, account.id))
          .run();
        if (updatedAccount.rowsAffected === 0) {
          throw new Error("Account update failed during liquidation");
        }

        await tx.delete(perpPositionState).where(eq(perpPositionState.positionId, latestPosition.id)).run();
        await tx.delete(positions).where(eq(positions.id, latestPosition.id)).run();

        return {
          liquidationId,
          userId: account.userId,
          accountId: latestPosition.accountId,
          orderId,
          market: latestPosition.market,
          symbol: latestPosition.symbol,
          side: closeSide,
          quantity: closeQuantity,
          triggerPrice: quote.price,
          executionPrice: settlement.executionPrice,
          triggerPositionEquity: settlement.triggerPositionEquity,
          maintenanceMargin: settlement.maintenanceMargin,
          grossPayout: settlement.grossPayout,
          feeCharged: settlement.feeCharged,
          netPayout: settlement.netPayout,
          cancelledReduceOnlyOrders,
          liquidatedAt,
        };
      });

      if (!outcome) {
        skipped += 1;
        continue;
      }

      for (const cancelledOrder of outcome.cancelledReduceOnlyOrders) {
        emitOrderCancelled({
          userId: outcome.userId,
          order: cancelledOrder,
        });
      }

      eventBus.emit({
        type: "order.filled",
        userId: outcome.userId,
        accountId: outcome.accountId,
        orderId: outcome.orderId,
        data: {
          market: outcome.market,
          symbol: outcome.symbol,
          side: outcome.side,
          quantity: outcome.quantity,
          executionPrice: outcome.executionPrice,
          filledAt: outcome.liquidatedAt,
          limitPrice: null,
        },
      });

      eventBus.emit({
        type: "position.liquidated",
        userId: outcome.userId,
        accountId: outcome.accountId,
        orderId: outcome.orderId,
        data: {
          liquidationId: outcome.liquidationId,
          market: outcome.market,
          symbol: outcome.symbol,
          side: outcome.side,
          quantity: outcome.quantity,
          triggerPrice: outcome.triggerPrice,
          executionPrice: outcome.executionPrice,
          triggerPositionEquity: outcome.triggerPositionEquity,
          maintenanceMargin: outcome.maintenanceMargin,
          grossPayout: outcome.grossPayout,
          feeCharged: outcome.feeCharged,
          netPayout: outcome.netPayout,
          cancelledReduceOnlyOrderIds: outcome.cancelledReduceOnlyOrders.map((order) => order.id),
          liquidatedAt: outcome.liquidatedAt,
        },
      });

      liquidated += 1;
    } catch (error) {
      console.error("[liquidator] liquidation failed", error);
      skipped += 1;
    }
  }

  return { checked, liquidated, skipped };
};

export const startLiquidator = (registry: MarketRegistry): (() => void) => {
  return startPeriodicWorker({
    name: "liquidator",
    defaultIntervalMs: DEFAULT_INTERVAL_MS,
    envVar: "LIQUIDATION_INTERVAL_MS",
    run: () => liquidateUnsafePerpPositions(registry),
    onResult: (result) => {
      if (result.liquidated > 0) {
        console.log(`[liquidator] liquidated ${result.liquidated} positions`);
      }
    },
  });
};
