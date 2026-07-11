import type { TimelineEventRecord } from "@unimarket/core";
import type { MarketRegistry } from "@unimarket/markets";
import { desc, eq } from "drizzle-orm";

import { db } from "./db/client.js";
import { fundingPayments, journal, liquidations, orders } from "./db/schema.js";
import { parseStoredStringArray } from "./platform/helpers.js";
import { formatResolvedSymbolLabel, resolveSymbolsByMarketWithCache } from "./symbol-metadata.js";

export const buildTimelineEvents = async ({
  registry,
  userId,
  accountId,
  limit,
  offset,
}: {
  registry: MarketRegistry;
  userId: string;
  accountId?: string | null;
  limit: number;
  offset: number;
}): Promise<TimelineEventRecord[]> => {
  const [orderRows, fundingRows, liquidationRows, journalRows] = await Promise.all([
    accountId
      ? db.select().from(orders).where(eq(orders.accountId, accountId)).orderBy(desc(orders.createdAt)).all()
      : Promise.resolve([]),
    accountId
      ? db
        .select()
        .from(fundingPayments)
        .where(eq(fundingPayments.accountId, accountId))
        .orderBy(desc(fundingPayments.createdAt))
        .all()
      : Promise.resolve([]),
    accountId
      ? db
        .select()
        .from(liquidations)
        .where(eq(liquidations.accountId, accountId))
        .orderBy(desc(liquidations.createdAt))
        .all()
      : Promise.resolve([]),
    db.select().from(journal).where(eq(journal.userId, userId)).orderBy(desc(journal.createdAt)).all(),
  ]);

  const liquidationOrderIds = new Set(liquidationRows.map((row) => row.orderId));

  const merged: TimelineEventRecord[] = [
    ...orderRows
      .filter((row) => !(row.status === "filled" && liquidationOrderIds.has(row.id)))
      .map((row) => ({
        type: row.status === "cancelled" ? ("order.cancelled" as const) : ("order" as const),
        data: {
          id: row.id,
          symbol: row.symbol,
          market: row.market,
          side: row.side,
          quantity: row.quantity,
          status: row.status,
          filledPrice: row.filledPrice,
          filledAt: row.filledAt,
          cancelledAt: row.cancelledAt,
          symbolName: null,
        },
        reasoning: row.status === "cancelled" ? row.cancelReasoning : row.reasoning,
        createdAt:
          row.status === "cancelled"
            ? (row.cancelledAt ?? row.createdAt)
            : row.status === "filled"
              ? (row.filledAt ?? row.createdAt)
              : row.createdAt,
      })),
    ...journalRows.map((row) => ({
      type: "journal" as const,
      data: {
        id: row.id,
        content: row.content,
        tags: parseStoredStringArray(row.tags, "journal tags"),
      },
      reasoning: null,
      createdAt: row.createdAt,
    })),
    ...fundingRows.map((row) => ({
      type: "funding.applied" as const,
      data: {
        id: row.id,
        market: row.market,
        symbol: row.symbol,
        quantity: row.quantity,
        fundingRate: row.fundingRate,
        payment: row.payment,
        appliedAt: row.createdAt,
        symbolName: null,
      },
      reasoning: `Funding applied from ${row.market}:${row.symbol} at rate ${row.fundingRate}`,
      createdAt: row.createdAt,
    })),
    ...liquidationRows.map((row) => ({
      type: "position.liquidated" as const,
      data: {
        id: row.id,
        market: row.market,
        symbol: row.symbol,
        side: row.side,
        quantity: row.quantity,
        triggerPrice: row.triggerPrice,
        executionPrice: row.executionPrice,
        triggerPositionEquity: row.triggerPositionEquity,
        maintenanceMargin: row.maintenanceMargin,
        grossPayout: row.grossPayout,
        feeCharged: row.feeCharged,
        netPayout: row.netPayout,
        liquidatedAt: row.createdAt,
        cancelledReduceOnlyOrderIds: parseStoredStringArray(
          row.cancelledReduceOnlyOrderIds,
          "liquidation cancelled order IDs",
        ),
        symbolName: null,
      },
      reasoning: row.reasoning,
      createdAt: row.createdAt,
    })),
  ]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(offset, offset + limit);

  const symbolsByMarket = new Map<string, Set<string>>();
  for (const event of merged) {
    if (event.type === "journal") continue;

    const symbols = symbolsByMarket.get(event.data.market);
    if (symbols) {
      symbols.add(event.data.symbol);
    } else {
      symbolsByMarket.set(event.data.market, new Set([event.data.symbol]));
    }
  }

  const symbolResolutionByMarket = await resolveSymbolsByMarketWithCache(registry, symbolsByMarket);
  for (const event of merged) {
    if (event.type === "journal") continue;
    event.data.symbolName = formatResolvedSymbolLabel(
      symbolResolutionByMarket.get(event.data.market),
      event.data.symbol,
    );
  }

  return merged;
};
