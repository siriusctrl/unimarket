import { and, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { orders } from "../db/schema.js";
import { eventBus } from "../platform/events.js";
import { nowIso } from "../utils.js";

type OrderRow = typeof orders.$inferSelect;
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CancelledOrderRecord = {
  id: string;
  accountId: string;
  market: string;
  symbol: string;
  side: string;
  quantity: number;
  reasoning: string;
  cancelledAt: string;
};

type CancelPendingOrderParams = {
  order: OrderRow;
  reasoning: string;
  cancelledAt?: string;
  userId?: string;
};

type CancelPendingOrderResult =
  | { kind: "cancelled"; order: CancelledOrderRecord }
  | { kind: "skipped"; reason: "ORDER_NOT_PENDING" };

export const cancelPendingOrderInTx = async (
  tx: DbTransaction,
  { order, reasoning, cancelledAt }: { order: OrderRow; reasoning: string; cancelledAt: string },
): Promise<CancelledOrderRecord | null> => {
  const updated = await tx
    .update(orders)
    .set({
      status: "cancelled",
      cancelReasoning: reasoning,
      cancelledAt,
    })
    .where(and(eq(orders.id, order.id), eq(orders.status, "pending")))
    .run();

  if (updated.rowsAffected === 0) {
    return null;
  }

  return {
    id: order.id,
    accountId: order.accountId,
    market: order.market,
    symbol: order.symbol,
    side: order.side,
    quantity: order.quantity,
    reasoning,
    cancelledAt,
  };
};

export const emitOrderCancelled = ({
  userId,
  order,
}: {
  userId: string;
  order: CancelledOrderRecord;
}): void => {
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
      reasoning: order.reasoning,
      cancelledAt: order.cancelledAt,
    },
  });
};

export const cancelPendingOrder = async ({
  order,
  reasoning,
  cancelledAt = nowIso(),
  userId,
}: CancelPendingOrderParams): Promise<CancelPendingOrderResult> => {
  const cancelled = await db.transaction(async (tx) => cancelPendingOrderInTx(tx, { order, reasoning, cancelledAt }));
  if (!cancelled) {
    return { kind: "skipped", reason: "ORDER_NOT_PENDING" };
  }

  if (userId) {
    emitOrderCancelled({ userId, order: cancelled });
  }

  return { kind: "cancelled", order: cancelled };
};
