import type { TimelineEventRecord } from "@unimarket/core";
import type { MarketRegistry } from "@unimarket/markets";
import { desc, eq } from "drizzle-orm";

import { db } from "./db/client.js";
import { fundingPayments, journal, liquidations, orders } from "./db/schema.js";
import { deserializeTags } from "./platform/helpers.js";
import { resolveSymbolsWithCache } from "./symbol-metadata.js";

const deserializeStringArray = (raw: string): string[] => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
};

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
        tags: deserializeTags(row.tags),
        symbolName: null,
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
        cancelledReduceOnlyOrderIds: deserializeStringArray(row.cancelledReduceOnlyOrderIds),
        symbolName: null,
      },
      reasoning: row.reasoning,
      createdAt: row.createdAt,
    })),
  ]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(offset, offset + limit);

  const polymarketSymbols = new Set<string>();
  for (const event of merged) {
    if (event.data.market === "polymarket" && event.data.symbol) {
      polymarketSymbols.add(event.data.symbol);
    }
  }

  const symbolResolution = await resolveSymbolsWithCache(registry, "polymarket", polymarketSymbols);
  for (const event of merged) {
    if (!event.data.symbol) continue;
    const name = symbolResolution.names.get(event.data.symbol);
    const outcome = symbolResolution.outcomes.get(event.data.symbol);
    event.data.symbolName = name ? (outcome ? `${name} — ${outcome}` : name) : null;
  }

  return merged;
};
