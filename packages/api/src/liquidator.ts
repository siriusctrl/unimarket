import {
  calculatePerpMaintenanceMargin,
  calculatePerpPositionEquity,
  calculatePerpUnrealizedPnl,
} from "@unimarket/core";
import type { MarketRegistry } from "@unimarket/markets";
import { and, eq } from "drizzle-orm";

import { db } from "./db/client.js";
import { accounts, orderExecutionParams, orders, perpPositionState, positions, trades } from "./db/schema.js";
import { eventBus } from "./events.js";
import { getTakerFeeRate } from "./fees.js";
import { makeId, nowIso } from "./utils.js";

const DEFAULT_INTERVAL_MS = 5_000;

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

    let quotePrice = 0;
    try {
      const quote = await adapter.getQuote(row.symbol);
      quotePrice = quote.price;
    } catch {
      skipped += 1;
      continue;
    }

    const positionView = {
      quantity: row.quantity,
      avgCost: row.avgCost,
      margin: state.margin,
      maintenanceMarginRatio: state.maintenanceMarginRatio,
    };
    const maintenance = calculatePerpMaintenanceMargin(positionView, quotePrice);
    const positionEquity = calculatePerpPositionEquity(positionView, quotePrice);

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

        const latestPositionView = {
          quantity: latestPosition.quantity,
          avgCost: latestPosition.avgCost,
          margin: latestState.margin,
          maintenanceMarginRatio: latestState.maintenanceMarginRatio,
        };
        const latestMaintenance = calculatePerpMaintenanceMargin(latestPositionView, quotePrice);
        const latestEquity = calculatePerpPositionEquity(latestPositionView, quotePrice);
        if (latestEquity > latestMaintenance) {
          return null;
        }

        const closeSide: "buy" | "sell" = latestPosition.quantity > 0 ? "sell" : "buy";
        const closeQuantity = Math.abs(latestPosition.quantity);
        if (closeQuantity <= 0) {
          return null;
        }

        const orderId = makeId("ord");
        const filledAt = nowIso();
        const takerFeeRate = getTakerFeeRate(latestPosition.market);
        const fee = Number((Math.abs(closeQuantity * quotePrice) * takerFeeRate).toFixed(6));
        const payout = Math.max(0, latestEquity);
        const nextBalance = Number(Math.max(0, account.balance + payout - fee).toFixed(6));
        const unrealized = calculatePerpUnrealizedPnl(latestPositionView, quotePrice);
        const reasoning = `Auto-liquidation: maintenance margin breached (equity=${latestEquity}, maintenance=${latestMaintenance}, unrealizedPnl=${unrealized}, fee=${fee})`;

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
            filledPrice: quotePrice,
            reasoning,
            cancelReasoning: null,
            cancelledAt: null,
            filledAt,
            createdAt: filledAt,
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
            id: makeId("trd"),
            orderId,
            accountId: latestPosition.accountId,
            market: latestPosition.market,
            symbol: latestPosition.symbol,
            side: closeSide,
            quantity: closeQuantity,
            price: quotePrice,
            fee,
            createdAt: filledAt,
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
          userId: account.userId,
          accountId: latestPosition.accountId,
          orderId,
          market: latestPosition.market,
          symbol: latestPosition.symbol,
          side: closeSide,
          quantity: closeQuantity,
          price: quotePrice,
          filledAt,
        };
      });

      if (!outcome) {
        skipped += 1;
        continue;
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
          executionPrice: outcome.price,
          filledAt: outcome.filledAt,
          limitPrice: null,
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
  const intervalMs = Number(process.env.LIQUIDATION_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  let running = false;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const result = await liquidateUnsafePerpPositions(registry);
      if (result.liquidated > 0) {
        console.log(`[liquidator] liquidated ${result.liquidated} positions`);
      }
    } catch (error) {
      console.error("[liquidator] error:", error);
    } finally {
      running = false;
    }
  }, intervalMs);

  console.log(`[liquidator] started (interval: ${intervalMs}ms)`);
  return () => {
    clearInterval(timer);
    console.log("[liquidator] stopped");
  };
};
