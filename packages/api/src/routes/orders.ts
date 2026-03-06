import {
  cancelOrderSchema,
  listOrdersQuerySchema,
  placeOrderSchema,
} from "@unimarket/core";
import type { MarketRegistry } from "@unimarket/markets";
import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { Hono } from "hono";

import type { AppVariables } from "../platform/auth.js";
import { db } from "../db/client.js";
import { accounts, orders } from "../db/schema.js";
import { jsonError } from "../platform/errors.js";
import { getFirst, getUserAccount, parseJson, parseQuery, withErrorHandling } from "../platform/helpers.js";
import { checkIdempotency, storeIdempotencyResponse, type IdempotencyStoreCandidate } from "../platform/idempotency.js";
import { cancelPendingOrder } from "../services/order-cancellation.js";
import { createOrderPlacementService } from "../services/order-placement.js";

export const createOrderRoutes = (registry: MarketRegistry) => {
  const router = new Hono<{ Variables: AppVariables }>();
  const { placeOrderForAccount } = createOrderPlacementService(registry);

  const maybeStoreResponse = async (
    idempotency: IdempotencyStoreCandidate | null,
    response: Response,
  ): Promise<void> => {
    if (!idempotency || response.status >= 500) {
      return;
    }

    try {
      const payload = await response.clone().json();
      await storeIdempotencyResponse(idempotency, response.status, payload);
    } catch {
      // Ignore non-JSON response payloads for idempotent replay cache.
    }
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
      if (parsed.data.accountId && parsed.data.accountId !== account.id) {
        return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
      }

      const idempotencyResult = await checkIdempotency(c, userId, parsed.data);
      if (idempotencyResult.kind === "invalid" || idempotencyResult.kind === "replay") {
        return idempotencyResult.response;
      }
      const idempotencyCandidate = idempotencyResult.kind === "store" ? idempotencyResult.candidate : null;
      const placement = await placeOrderForAccount({ account, order: parsed.data });
      if (placement.kind === "error") {
        return jsonError(c, placement.status, placement.code, placement.message);
      }

      const response = c.json(placement.order, 201);
      await maybeStoreResponse(idempotencyCandidate, response);
      return response;
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
        if (parsed.data.accountId && parsed.data.accountId !== account.id) {
          return c.json({ orders: [] });
        }
        predicates.push(eq(orders.accountId, account.id));
      } else if (parsed.data.accountId) {
        predicates.push(eq(orders.accountId, parsed.data.accountId));
      }

      if (parsed.data.view === "open") {
        predicates.push(eq(orders.status, "pending"));
      } else if (parsed.data.view === "history") {
        predicates.push(inArray(orders.status, ["filled", "cancelled", "rejected"]));
      }

      if (parsed.data.status) predicates.push(eq(orders.status, parsed.data.status));
      if (parsed.data.market) predicates.push(eq(orders.market, parsed.data.market));
      if (parsed.data.symbol) {
        let symbolFilter = parsed.data.symbol;
        if (parsed.data.market) {
          const marketAdapter = registry.get(parsed.data.market);
          if (marketAdapter?.normalizeSymbol) {
            try {
              symbolFilter = await marketAdapter.normalizeSymbol(parsed.data.symbol);
            } catch {
              return c.json({ orders: [] });
            }
          }
        }
        predicates.push(eq(orders.symbol, symbolFilter));
      }

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

  router.delete(
    "/:id",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, cancelOrderSchema);
      if (!parsed.success) return parsed.response;

      const orderId = c.req.param("id");
      const userId = c.get("userId");

      const idempotencyResult = await checkIdempotency(c, userId, parsed.data);
      if (idempotencyResult.kind === "invalid" || idempotencyResult.kind === "replay") {
        return idempotencyResult.response;
      }
      const idempotencyCandidate = idempotencyResult.kind === "store" ? idempotencyResult.candidate : null;

      const order = await getFirst(db.select().from(orders).where(eq(orders.id, orderId)).limit(1).all());
      if (!order) return jsonError(c, 404, "ORDER_NOT_FOUND", "Order not found");
      const orderAccount = await getFirst(db.select().from(accounts).where(eq(accounts.id, order.accountId)).limit(1).all());

      if (userId !== "admin") {
        const account = await getUserAccount(userId);
        if (!account || account.id !== order.accountId) {
          return jsonError(c, 404, "ORDER_NOT_FOUND", "Order not found");
        }
      }

      if (order.status !== "pending") {
        return jsonError(c, 400, "INVALID_ORDER", "Only pending orders can be cancelled");
      }

      const cancellation = await cancelPendingOrder({
        order,
        reasoning: parsed.data.reasoning,
        userId: orderAccount?.userId ?? (userId === "admin" ? "admin" : userId),
      });

      if (cancellation.kind !== "cancelled") {
        const latest = await getFirst(db.select().from(orders).where(eq(orders.id, orderId)).limit(1).all());
        if (!latest) return jsonError(c, 404, "ORDER_NOT_FOUND", "Order not found");
        const payload = { id: orderId, status: latest.status };
        if (idempotencyCandidate) {
          await storeIdempotencyResponse(idempotencyCandidate, 200, payload);
        }
        return c.json(payload);
      }

      const payload = { id: orderId, status: "cancelled" as const };
      if (idempotencyCandidate) {
        await storeIdempotencyResponse(idempotencyCandidate, 200, payload);
      }
      return c.json(payload);
    }),
  );

  return router;
};
