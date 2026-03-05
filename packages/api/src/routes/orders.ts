import {
  cancelOrderSchema,
  calculatePerpLiquidationPrice,
  executeFill,
  executePerpFill,
  listOrdersQuerySchema,
  placeOrderSchema,
  reconcileOrdersSchema,
} from "@unimarket/core";
import type { MarketAdapter, MarketRegistry, TradingConstraints } from "@unimarket/markets";
import { and, asc, desc, eq, inArray, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";

import type { AppVariables } from "../auth.js";
import { db } from "../db/client.js";
import { accounts, orderExecutionParams, orders, perpPositionState, positions, trades } from "../db/schema.js";
import { jsonError } from "../errors.js";
import { eventBus } from "../events.js";
import { getTakerFeeRate } from "../fees.js";
import { getFirst, getUserAccount, parseJson, parseQuery, withErrorHandling } from "../helpers.js";
import { checkIdempotency, storeIdempotencyResponse, type IdempotencyStoreCandidate } from "../idempotency.js";
import { makeId, nowIso } from "../utils.js";
import { reconcilePendingOrders } from "../reconciler.js";

const DEFAULT_TRADING_CONSTRAINTS: TradingConstraints = {
  minQuantity: 1,
  quantityStep: 1,
  supportsFractional: false,
  maxLeverage: null,
};

const normalizeTradingConstraints = (constraints: TradingConstraints | null | undefined): TradingConstraints => {
  if (!constraints) return DEFAULT_TRADING_CONSTRAINTS;
  const minQuantity = Number.isFinite(constraints.minQuantity) && constraints.minQuantity > 0
    ? constraints.minQuantity
    : DEFAULT_TRADING_CONSTRAINTS.minQuantity;
  const quantityStep = Number.isFinite(constraints.quantityStep) && constraints.quantityStep > 0
    ? constraints.quantityStep
    : DEFAULT_TRADING_CONSTRAINTS.quantityStep;
  const maxLeverage = constraints.maxLeverage ?? null;
  return {
    minQuantity,
    quantityStep,
    supportsFractional: Boolean(constraints.supportsFractional),
    maxLeverage: typeof maxLeverage === "number" && Number.isFinite(maxLeverage) && maxLeverage > 0 ? maxLeverage : null,
  };
};

const isStepAligned = (quantity: number, step: number): boolean => {
  const units = quantity / step;
  const rounded = Math.round(units);
  const epsilon = Math.max(1e-9, Math.abs(step) * 1e-9);
  return Math.abs(units - rounded) <= epsilon;
};

const resolveTradingConstraints = async (adapter: MarketAdapter, symbol: string): Promise<TradingConstraints> => {
  if (typeof adapter.getTradingConstraints !== "function") {
    return DEFAULT_TRADING_CONSTRAINTS;
  }
  const constraints = await adapter.getTradingConstraints(symbol);
  return normalizeTradingConstraints(constraints);
};

export const createOrderRoutes = (registry: MarketRegistry) => {
  const router = new Hono<{ Variables: AppVariables }>();
  const defaultMaintenanceMarginRatio = Number(process.env.MAINTENANCE_MARGIN_RATIO) || 0.05;

  const isPerpMarket = (marketId: string): boolean => {
    const adapter = registry.get(marketId);
    return Boolean(adapter?.capabilities.includes("funding"));
  };

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
    executionOptions: { isPerp: boolean; leverage: number; reduceOnly: boolean; takerFeeRate: number },
    c: Context<{ Variables: AppVariables }>,
  ): Promise<Response> => {
    const persistenceResult = await db.transaction(async (tx) => {
      const existingOrder = await getFirst(tx.select().from(orders).where(eq(orders.id, orderId)).limit(1).all());
      if (existingOrder && existingOrder.status !== "pending") {
        return { kind: "skipped" as const, order: existingOrder };
      }

      const account = await getFirst(tx.select().from(accounts).where(eq(accounts.id, accountId)).limit(1).all());
      if (!account) return { kind: "account_not_found" as const };

      const existingPosition = await getFirst(
        tx
          .select()
          .from(positions)
          .where(and(eq(positions.accountId, accountId), eq(positions.market, market), eq(positions.symbol, symbol)))
          .limit(1)
          .all(),
      );
      const existingPerpState = existingPosition && executionOptions.isPerp
        ? await tx.select().from(perpPositionState).where(eq(perpPositionState.positionId, existingPosition.id)).get()
        : null;

      let leverage = executionOptions.leverage;
      let reduceOnly = executionOptions.reduceOnly;
      let takerFeeRate = executionOptions.takerFeeRate;
      if (existingOrder) {
        const persistedParams = await tx
          .select()
          .from(orderExecutionParams)
          .where(eq(orderExecutionParams.orderId, existingOrder.id))
          .get();
        if (persistedParams) {
          leverage = persistedParams.leverage;
          reduceOnly = persistedParams.reduceOnly;
          takerFeeRate = persistedParams.takerFeeRate;
        }
      }

      const spotFillResult = executionOptions.isPerp
        ? null
        : executeFill({
          balance: account.balance,
          position: existingPosition ? { quantity: existingPosition.quantity, avgCost: existingPosition.avgCost } : null,
          side,
          quantity,
          price: executionPrice,
          allowShort: false,
          takerFeeRate,
        });
      const perpFillResult = executionOptions.isPerp
        ? executePerpFill({
          balance: account.balance,
          position: existingPosition
            ? {
              quantity: existingPosition.quantity,
              avgCost: existingPosition.avgCost,
              margin:
                existingPerpState?.margin ??
                Number(
                  (Math.abs(existingPosition.quantity * existingPosition.avgCost) / Math.max(existingPerpState?.leverage ?? leverage, 1)).toFixed(6),
                ),
              leverage: existingPerpState?.leverage ?? leverage,
              maintenanceMarginRatio: existingPerpState?.maintenanceMarginRatio ?? defaultMaintenanceMarginRatio,
            }
            : null,
          side,
          quantity,
          price: executionPrice,
          leverage,
          maintenanceMarginRatio: existingPerpState?.maintenanceMarginRatio ?? defaultMaintenanceMarginRatio,
          reduceOnly,
          takerFeeRate,
        })
        : null;
      const fillResult = executionOptions.isPerp ? perpFillResult : spotFillResult;
      if (!fillResult) {
        throw new Error("Order fill result not generated");
      }

      if (existingOrder) {
        const claimedOrder = await tx
          .update(orders)
          .set({
            status: "filled",
            filledPrice: executionPrice,
            filledAt: createdAt,
            cancelReasoning: null,
            cancelledAt: null,
          })
          .where(and(eq(orders.id, orderId), eq(orders.status, "pending")))
          .run();

        if (claimedOrder.rowsAffected === 0) {
          const latest = await getFirst(tx.select().from(orders).where(eq(orders.id, orderId)).limit(1).all());
          return { kind: "skipped" as const, order: latest ?? existingOrder };
        }

        const paramExists = await tx
          .select()
          .from(orderExecutionParams)
          .where(eq(orderExecutionParams.orderId, orderId))
          .get();
        if (!paramExists) {
          await tx
            .insert(orderExecutionParams)
            .values({
              orderId,
              leverage,
              reduceOnly,
              takerFeeRate,
            })
            .onConflictDoNothing()
            .run();
        }
      } else {
        const insertedOrder = await tx
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
            cancelledAt: null,
            filledAt: createdAt,
            createdAt,
          })
          .onConflictDoNothing()
          .run();

        if (insertedOrder.rowsAffected === 0) {
          const latest = await getFirst(tx.select().from(orders).where(eq(orders.id, orderId)).limit(1).all());
          return { kind: "skipped" as const, order: latest };
        }

        await tx
          .insert(orderExecutionParams)
          .values({
            orderId,
            leverage,
            reduceOnly,
            takerFeeRate,
          })
          .onConflictDoNothing()
          .run();
      }

      const updatedAccount = await tx.update(accounts).set({ balance: fillResult.nextBalance }).where(eq(accounts.id, accountId)).run();
      if (updatedAccount.rowsAffected === 0) {
        throw new Error("Account update failed during order fill");
      }

      if (!fillResult.nextPosition) {
        if (existingPosition) {
          const deletedPosition = await tx.delete(positions).where(eq(positions.id, existingPosition.id)).run();
          if (deletedPosition.rowsAffected === 0) {
            throw new Error("Position delete failed during order fill");
          }

          if (executionOptions.isPerp) {
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
          throw new Error("Position update failed during order fill");
        }

        if (executionOptions.isPerp) {
          const perpNextPosition = perpFillResult?.nextPosition;
          if (!perpNextPosition) {
            throw new Error("Perp position state missing for filled order");
          }
          const liquidationPrice = calculatePerpLiquidationPrice(perpNextPosition);
          await tx
            .insert(perpPositionState)
            .values({
              positionId: existingPosition.id,
              accountId,
              market,
              symbol,
              leverage: perpNextPosition.leverage,
              margin: perpNextPosition.margin,
              maintenanceMarginRatio: perpNextPosition.maintenanceMarginRatio,
              liquidationPrice,
              updatedAt: createdAt,
            })
            .onConflictDoUpdate({
              target: perpPositionState.positionId,
              set: {
                leverage: perpNextPosition.leverage,
                margin: perpNextPosition.margin,
                maintenanceMarginRatio: perpNextPosition.maintenanceMarginRatio,
                liquidationPrice,
                updatedAt: createdAt,
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
            accountId,
            market,
            symbol,
            quantity: fillResult.nextPosition.quantity,
            avgCost: fillResult.nextPosition.avgCost,
          })
          .run();

        if (executionOptions.isPerp) {
          const perpNextPosition = perpFillResult?.nextPosition;
          if (!perpNextPosition) {
            throw new Error("Perp position state missing for filled order");
          }
          const liquidationPrice = calculatePerpLiquidationPrice(perpNextPosition);
          await tx
            .insert(perpPositionState)
            .values({
              positionId: newPositionId,
              accountId,
              market,
              symbol,
              leverage: perpNextPosition.leverage,
              margin: perpNextPosition.margin,
              maintenanceMarginRatio: perpNextPosition.maintenanceMarginRatio,
              liquidationPrice,
              updatedAt: createdAt,
            })
            .run();
        }
      }

      await tx
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
          fee: fillResult.feePaid,
          createdAt,
        })
        .run();

      return { kind: "filled" as const, userId: account.userId };
    });

    if (persistenceResult.kind === "account_not_found") {
      return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
    }
    if (persistenceResult.kind === "skipped") {
      if (persistenceResult.order) return c.json(persistenceResult.order);
      const latest = await getFirst(db.select().from(orders).where(eq(orders.id, orderId)).limit(1).all());
      if (latest) return c.json(latest);
      return jsonError(c, 409, "INVALID_ORDER", "Order was already processed");
    }

    eventBus.emit({
      type: "order.filled",
      userId: persistenceResult.userId,
      accountId,
      orderId,
      data: {
        market,
        symbol,
        side,
        quantity,
        executionPrice,
        filledAt: createdAt,
        limitPrice,
      },
    });

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
      if (parsed.data.accountId && parsed.data.accountId !== account.id) {
        return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
      }

      const idempotencyResult = await checkIdempotency(c, userId, parsed.data);
      if (idempotencyResult.kind === "invalid" || idempotencyResult.kind === "replay") {
        return idempotencyResult.response;
      }
      const idempotencyCandidate = idempotencyResult.kind === "store" ? idempotencyResult.candidate : null;

      const adapter = registry.get(parsed.data.market);
      if (!adapter) return jsonError(c, 404, "MARKET_NOT_FOUND", `Market not found: ${parsed.data.market}`);
      const perpMarket = isPerpMarket(parsed.data.market);
      const requestedLeverage = parsed.data.leverage ?? 1;
      const reduceOnly = parsed.data.reduceOnly ?? false;
      const takerFeeRate = getTakerFeeRate(parsed.data.market);
      if (!perpMarket && requestedLeverage !== 1) {
        return jsonError(c, 400, "INVALID_INPUT", "leverage is only supported for perpetual markets");
      }
      if (!perpMarket && reduceOnly) {
        return jsonError(c, 400, "INVALID_INPUT", "reduceOnly is only supported for perpetual markets");
      }

      const normalizedSymbol =
        typeof adapter.normalizeSymbol === "function"
          ? await adapter.normalizeSymbol(parsed.data.symbol)
          : parsed.data.symbol;
      const tradingConstraints = await resolveTradingConstraints(adapter, normalizedSymbol);
      if (parsed.data.quantity < tradingConstraints.minQuantity) {
        return jsonError(
          c,
          400,
          "INVALID_INPUT",
          `quantity must be greater than or equal to ${tradingConstraints.minQuantity}`,
        );
      }
      if (!isStepAligned(parsed.data.quantity, tradingConstraints.quantityStep)) {
        return jsonError(
          c,
          400,
          "INVALID_INPUT",
          `quantity must align with step ${tradingConstraints.quantityStep}`,
        );
      }
      if (!tradingConstraints.supportsFractional && !Number.isInteger(parsed.data.quantity)) {
        return jsonError(c, 400, "INVALID_INPUT", "quantity must be an integer for this market");
      }
      const maxLeverage = tradingConstraints.maxLeverage ?? null;
      if (
        perpMarket &&
        maxLeverage !== null &&
        requestedLeverage > maxLeverage
      ) {
        return jsonError(
          c,
          400,
          "INVALID_INPUT",
          `leverage exceeds maxLeverage=${maxLeverage} for ${normalizedSymbol}`,
        );
      }

      const createdAt = nowIso();
      const orderId = makeId("ord");

      const quoteSidePrice = (price: { price: number; bid?: number; ask?: number }): number => {
        return parsed.data.side === "buy" ? (price.ask ?? price.price) : (price.bid ?? price.price);
      };

      if (parsed.data.type === "limit") {
        let executionPrice: number | null = null;

        try {
          const quote = await adapter.getQuote(normalizedSymbol);
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
            symbol: normalizedSymbol,
            side: parsed.data.side,
            type: "limit" as const,
            quantity: parsed.data.quantity,
            limitPrice: parsed.data.limitPrice ?? null,
            status: "pending" as const,
            filledPrice: null,
            reasoning: parsed.data.reasoning,
            cancelReasoning: null,
            cancelledAt: null,
            filledAt: null,
            createdAt,
          };
          await db.insert(orders).values(baseOrder).run();
          await db
            .insert(orderExecutionParams)
            .values({
              orderId,
              leverage: requestedLeverage,
              reduceOnly,
              takerFeeRate,
            })
            .onConflictDoNothing()
            .run();
          if (idempotencyCandidate) {
            await storeIdempotencyResponse(idempotencyCandidate, 201, baseOrder);
          }
          return c.json(baseOrder, 201);
        }

        const response = await persistFilledOrder(
          orderId, account.id, parsed.data.market, normalizedSymbol,
          parsed.data.side, parsed.data.quantity, executionPrice,
          parsed.data.reasoning, parsed.data.limitPrice ?? null, createdAt,
          { isPerp: perpMarket, leverage: requestedLeverage, reduceOnly, takerFeeRate },
          c,
        );
        await maybeStoreResponse(idempotencyCandidate, response);
        return response;
      }

      // Market order
      const quote = await adapter.getQuote(normalizedSymbol);
      const executionPrice = quoteSidePrice(quote);
      const response = await persistFilledOrder(
        orderId, account.id, parsed.data.market, normalizedSymbol,
        parsed.data.side, parsed.data.quantity, executionPrice,
        parsed.data.reasoning, null, createdAt,
        { isPerp: perpMarket, leverage: requestedLeverage, reduceOnly, takerFeeRate },
        c,
      );
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

      const cancelledAt = nowIso();
      const updated = await db
        .update(orders)
        .set({ status: "cancelled", cancelReasoning: parsed.data.reasoning, cancelledAt })
        .where(and(eq(orders.id, orderId), eq(orders.status, "pending")))
        .run();

      if (updated.rowsAffected === 0) {
        const latest = await getFirst(db.select().from(orders).where(eq(orders.id, orderId)).limit(1).all());
        if (!latest) return jsonError(c, 404, "ORDER_NOT_FOUND", "Order not found");
        const payload = { id: orderId, status: latest.status };
        if (idempotencyCandidate) {
          await storeIdempotencyResponse(idempotencyCandidate, 200, payload);
        }
        return c.json(payload);
      }

      eventBus.emit({
        type: "order.cancelled",
        userId: orderAccount?.userId ?? (userId === "admin" ? "admin" : userId),
        accountId: order.accountId,
        orderId,
        data: {
          market: order.market,
          symbol: order.symbol,
          side: order.side,
          quantity: order.quantity,
          reasoning: parsed.data.reasoning,
          cancelledAt,
        },
      });

      const payload = { id: orderId, status: "cancelled" as const };
      if (idempotencyCandidate) {
        await storeIdempotencyResponse(idempotencyCandidate, 200, payload);
      }
      return c.json(payload);
    }),
  );

  return router;
};
