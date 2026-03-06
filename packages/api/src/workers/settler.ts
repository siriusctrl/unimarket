import { type MarketRegistry } from "@unimarket/markets";
import { eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { accounts, positions, trades } from "../db/schema.js";
import { eventBus } from "../platform/events.js";
import { startPeriodicWorker } from "./periodic-worker.js";
import { makeId, nowIso } from "../utils.js";

const DEFAULT_INTERVAL_MS = 60_000; // 1 minute

export const settlePendingPositions = async (registry: MarketRegistry): Promise<{ settled: number; skipped: number }> => {
  const allPositions = await db.select().from(positions).all();

  let settled = 0;
  let skipped = 0;

  for (const pos of allPositions) {
    const adapter = registry.get(pos.market);
    if (!adapter) {
      skipped += 1;
      continue;
    }

    if (!adapter.capabilities.includes("resolve") || typeof adapter.resolve !== "function") {
      skipped += 1;
      continue;
    }

    let resolution;
    try {
      resolution = await adapter.resolve(pos.symbol);
    } catch {
      skipped += 1;
      continue;
    }

    if (!resolution || !resolution.resolved || resolution.settlementPrice === null || resolution.settlementPrice === undefined) {
      skipped += 1;
      continue;
    }

    const settlementPrice = resolution.settlementPrice;

    try {
      const didSettle = await db.transaction(async (tx) => {
        const latestPosition = await tx.select().from(positions).where(eq(positions.id, pos.id)).get();
        if (!latestPosition) return null;

        const account = await tx.select().from(accounts).where(eq(accounts.id, latestPosition.accountId)).get();
        if (!account) return null;

        const proceeds = Number((latestPosition.quantity * settlementPrice).toFixed(6));
        const nextBalance = Number((account.balance + proceeds).toFixed(6));

        const accountUpdated = await tx.update(accounts).set({ balance: nextBalance }).where(eq(accounts.id, account.id)).run();
        if (accountUpdated.rowsAffected === 0) {
          throw new Error("Account update failed during settlement");
        }

        const now = nowIso();
        const settlementOrderId = makeId("stl");
        await tx
          .insert(trades)
          .values({
            id: makeId("trd"),
            orderId: settlementOrderId,
            accountId: latestPosition.accountId,
            market: latestPosition.market,
            symbol: latestPosition.symbol,
            side: "sell",
            quantity: latestPosition.quantity,
            price: settlementPrice,
            createdAt: now,
          })
          .run();

        const deletedPosition = await tx.delete(positions).where(eq(positions.id, latestPosition.id)).run();
        if (deletedPosition.rowsAffected === 0) {
          throw new Error("Position delete failed during settlement");
        }

        return {
          userId: account.userId,
          accountId: latestPosition.accountId,
          orderId: settlementOrderId,
          market: latestPosition.market,
          symbol: latestPosition.symbol,
          quantity: latestPosition.quantity,
          settlementPrice,
          proceeds,
          settledAt: now,
        };
      });

      if (didSettle) {
        eventBus.emit({
          type: "position.settled",
          userId: didSettle.userId,
          accountId: didSettle.accountId,
          orderId: didSettle.orderId,
          data: {
            market: didSettle.market,
            symbol: didSettle.symbol,
            quantity: didSettle.quantity,
            settlementPrice: didSettle.settlementPrice,
            proceeds: didSettle.proceeds,
            settledAt: didSettle.settledAt,
          },
        });
        settled += 1;
      } else {
        skipped += 1;
      }
    } catch {
      skipped += 1;
    }
  }

  return { settled, skipped };
};

export const startSettler = (registry: MarketRegistry): (() => void) => {
  return startPeriodicWorker({
    name: "settler",
    defaultIntervalMs: DEFAULT_INTERVAL_MS,
    envVar: "SETTLE_INTERVAL_MS",
    run: () => settlePendingPositions(registry),
    onResult: (result) => {
      if (result.settled > 0) {
        console.log(`[settler] settled ${result.settled} positions`);
      }
    },
  });
};
