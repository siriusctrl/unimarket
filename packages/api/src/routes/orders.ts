import {
  cancelOrderSchema,
  executeFill,
  listOrdersQuerySchema,
  placeOrderSchema,
  reconcileOrdersSchema,
} from "@unimarket/core";
import type { MarketRegistry } from "@unimarket/markets";
import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";

import type { AppVariables } from "../auth.js";
import { db } from "../db/client.js";
import { accounts, orders, positions, trades } from "../db/schema.js";
import { jsonError } from "../errors.js";
import { getFirst, getUserAccount, parseJson, parseQuery, withErrorHandling } from "../helpers.js";
import { makeId, nowIso } from "../utils.js";
import { reconcilePendingOrders } from "../reconciler.js";

export const createOrderRoutes = (registry: MarketRegistry) => {
  const router = new Hono<{ Variables: AppVariables }>();

  const persistFilledOrder = async (
    orderId: string,
    accountId: string,
    market: string,
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    executionPrice: number,
    reasoning: string,
    limitPrice: number | null,
    createdAt: string,
    c: Context<{ Variables: AppVariables }>,
  ): Promise<Response> => {
    const account = await getFirst(db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1).all());
    if (!account) return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");

    const existingPosition = await getFirst(
      db
        .select()
        .from(positions)
        .where(and(eq(positions.accountId, accountId), eq(positions.market, market), eq(positions.symbol, symbol)))
        .limit(1)
        .all(),
    );

    const fillResult = executeFill({
      balance: account.balance,
      position: existingPosition ? { quantity: existingPosition.quantity, avgCost: existingPosition.avgCost } : null,
      side,
      quantity,
      price: executionPrice,
      allowShort: false,
    });

    await db.update(accounts).set({ balance: fillResult.nextBalance }).where(eq(accounts.id, accountId)).run();

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
          accountId,
          market,
          symbol,
          quantity: fillResult.nextPosition.quantity,
          avgCost: fillResult.nextPosition.avgCost,
        })
        .run();
    }

    await db
      .insert(trades)
      .values({
        id: makeId("trd"),
        orderId,
        accountId,
        market,
        symbol,
        side,
        quantity,
        price: executionPrice,
        createdAt,
      })
      .run();

    await db
      .insert(orders)
      .values({
        id: orderId,
        accountId,
        market,
        symbol,
        side,
        type: limitPrice !== null ? "limit" : "market",
        quantity,
        limitPrice,
        status: "filled",
        filledPrice: executionPrice,
        reasoning,
        cancelReasoning: null,
        filledAt: createdAt,
        createdAt,
      })
      .run();

    const filled = await getFirst(db.select().from(orders).where(eq(orders.id, orderId)).limit(1).all());
    return c.json(filled, 201);
  };

  router.post(
    "/",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, placeOrderSchema);
      if (!parsed.success) return parsed.response;

      const userId = c.get("userId");
      if (!userId || userId === "admin") {
        return jsonError(c, 400, "INVALID_USER", "Invalid user for order placement");
      }

      const account = await getUserAccount(userId);
      if (!account) return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");

      const adapter = registry.get(parsed.data.market);
      if (!adapter) return jsonError(c, 404, "MARKET_NOT_FOUND", `Market not found: ${parsed.data.market}`);

      const createdAt = nowIso();
      const orderId = makeId("ord");

      const quoteSidePrice = (price: { price: number; bid?: number; ask?: number }): number => {
        return parsed.data.side === "buy" ? (price.ask ?? price.price) : (price.bid ?? price.price);
      };

      if (parsed.data.type === "limit") {
        let executionPrice: number | null = null;

        try {
          const quote = await adapter.getQuote(parsed.data.symbol);
          const candidatePrice = quoteSidePrice(quote);
          const limitPrice = parsed.data.limitPrice as number;
          const shouldFillNow =
            parsed.data.side === "buy" ? candidatePrice <= limitPrice : candidatePrice >= limitPrice;
          if (shouldFillNow) executionPrice = candidatePrice;
        } catch {
          executionPrice = null;
        }

        if (executionPrice === null) {
          const baseOrder = {
            id: orderId,
            accountId: account.id,
            market: parsed.data.market,
            symbol: parsed.data.symbol,
            side: parsed.data.side,
            type: "limit" as const,
            quantity: parsed.data.quantity,
            limitPrice: parsed.data.limitPrice ?? null,
            status: "pending" as const,
            filledPrice: null,
            reasoning: parsed.data.reasoning,
            cancelReasoning: null,
            filledAt: null,
            createdAt,
          };
          await db.insert(orders).values(baseOrder).run();
          return c.json(baseOrder, 201);
        }

        return persistFilledOrder(
          orderId, account.id, parsed.data.market, parsed.data.symbol,
          parsed.data.side, parsed.data.quantity, executionPrice,
          parsed.data.reasoning, parsed.data.limitPrice ?? null, createdAt, c,
        );
      }

      // Market order
      const quote = await adapter.getQuote(parsed.data.symbol);
      const executionPrice = quoteSidePrice(quote);
      return persistFilledOrder(
        orderId, account.id, parsed.data.market, parsed.data.symbol,
        parsed.data.side, parsed.data.quantity, executionPrice,
        parsed.data.reasoning, null, createdAt, c,
      );
    }),
  );

  router.get(
    "/",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, listOrdersQuerySchema);
      if (!parsed.success) return parsed.response;

      const userId = c.get("userId");
      const predicates: SQL[] = [];

      if (userId !== "admin") {
        const account = await getUserAccount(userId);
        if (!account) return c.json({ orders: [] });
        predicates.push(eq(orders.accountId, account.id));
      }

      if (parsed.data.view === "open") {
        predicates.push(eq(orders.status, "pending"));
      } else if (parsed.data.view === "history") {
        predicates.push(inArray(orders.status, ["filled", "cancelled", "rejected"]));
      }

      if (parsed.data.status) predicates.push(eq(orders.status, parsed.data.status));
      if (parsed.data.market) predicates.push(eq(orders.market, parsed.data.market));
      if (parsed.data.symbol) predicates.push(eq(orders.symbol, parsed.data.symbol));

      const whereClause = predicates.length > 0 ? and(...predicates) : undefined;

      const rows = await db
        .select()
        .from(orders)
        .where(whereClause)
        .orderBy(desc(orders.createdAt))
        .limit(parsed.data.limit)
        .offset(parsed.data.offset)
        .all();

      return c.json({ orders: rows });
    }),
  );

  router.get(
    "/:id",
    withErrorHandling(async (c) => {
      const orderId = c.req.param("id");
      const userId = c.get("userId");

      const order = await getFirst(db.select().from(orders).where(eq(orders.id, orderId)).limit(1).all());
      if (!order) return jsonError(c, 404, "ORDER_NOT_FOUND", "Order not found");

      if (userId !== "admin") {
        const account = await getUserAccount(userId);
        if (!account || account.id !== order.accountId) {
          return jsonError(c, 404, "ORDER_NOT_FOUND", "Order not found");
        }
      }

      return c.json(order);
    }),
  );

  router.post(
    "/reconcile",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, reconcileOrdersSchema);
      if (!parsed.success) return parsed.response;

      const userId = c.get("userId");

      if (userId === "admin") {
        const result = await reconcilePendingOrders(registry);
        return c.json({ ...result });
      }

      const account = await getUserAccount(userId);
      if (!account) return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");

      const result = await reconcilePendingOrders(registry, [account.id]);
      return c.json({ ...result });
    }),
  );

  router.delete(
    "/:id",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, cancelOrderSchema);
      if (!parsed.success) return parsed.response;

      const orderId = c.req.param("id");
      const userId = c.get("userId");

      const order = await getFirst(db.select().from(orders).where(eq(orders.id, orderId)).limit(1).all());
      if (!order) return jsonError(c, 404, "ORDER_NOT_FOUND", "Order not found");

      if (userId !== "admin") {
        const account = await getUserAccount(userId);
        if (!account || account.id !== order.accountId) {
          return jsonError(c, 404, "ORDER_NOT_FOUND", "Order not found");
        }
      }

      if (order.status !== "pending") {
        return jsonError(c, 400, "INVALID_ORDER", "Only pending orders can be cancelled");
      }

      await db
        .update(orders)
        .set({ status: "cancelled", cancelReasoning: parsed.data.reasoning })
        .where(eq(orders.id, orderId))
        .run();

      return c.json({ id: orderId, status: "cancelled" });
    }),
  );

  return router;
};
