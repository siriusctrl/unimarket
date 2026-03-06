import {
  calculatePerpLiquidationPrice,
  executeFill,
  executePerpFill,
  type PlaceOrderInput,
} from "@unimarket/core";
import type { MarketAdapter, MarketRegistry, TradingConstraints } from "@unimarket/markets";
import { and, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { accounts, orderExecutionParams, orders, perpPositionState, positions, trades } from "../db/schema.js";
import { eventBus } from "../platform/events.js";
import { getTakerFeeRate } from "../fees.js";
import { getFirst } from "../platform/helpers.js";
import { makeId, nowIso } from "../utils.js";

const DEFAULT_TRADING_CONSTRAINTS: TradingConstraints = {
  minQuantity: 1,
  quantityStep: 1,
  supportsFractional: false,
  maxLeverage: null,
};

type AccountRow = typeof accounts.$inferSelect;
type OrderRow = typeof orders.$inferSelect;

type FillExecutionOptions = {
  leverage: number;
  reduceOnly: boolean;
  takerFeeRate: number;
};

type FillableOrder = {
  market: string;
  symbol: string;
  side: PlaceOrderInput["side"];
  quantity: number;
  reasoning: string;
};

type OrderPlacementError = {
  kind: "error";
  status: 400 | 404;
  code: "ACCOUNT_NOT_FOUND" | "MARKET_NOT_FOUND" | "INVALID_INPUT";
  message: string;
};

type OrderPlacementSuccess = {
  kind: "filled" | "pending";
  order: OrderRow;
};

export type OrderPlacementResult = OrderPlacementError | OrderPlacementSuccess;

export type PlaceOrderForAccountParams = {
  account: AccountRow;
  order: PlaceOrderInput;
  orderId?: string;
  createdAt?: string;
};

type FillPendingOrderParams = {
  pendingOrder: OrderRow;
  executionPrice: number;
  filledAt?: string;
};

type FillPendingOrderResult =
  | { kind: "filled"; order: OrderRow }
  | { kind: "skipped"; reason: "ACCOUNT_NOT_FOUND" | "ORDER_NOT_PENDING" };

type NewFillSource = {
  kind: "new";
  type: OrderRow["type"];
  limitPrice: number | null;
  executionOptions: FillExecutionOptions;
};

type PendingFillSource = {
  kind: "pending";
  type: "limit";
  limitPrice: number;
};

type PersistFilledOrderParams = {
  accountId: string;
  orderId: string;
  order: FillableOrder;
  executionPrice: number;
  createdAt: string;
  source: NewFillSource | PendingFillSource;
};

type PersistFilledOrderResult =
  | { kind: "filled"; order: OrderRow }
  | { kind: "account_not_found" }
  | { kind: "order_not_pending" };

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

const quoteSidePrice = (
  side: PlaceOrderInput["side"],
  price: { price: number; bid?: number; ask?: number },
): number => {
  return side === "buy" ? (price.ask ?? price.price) : (price.bid ?? price.price);
};

export const createOrderPlacementService = (registry: MarketRegistry) => {
  const defaultMaintenanceMarginRatio = Number(process.env.MAINTENANCE_MARGIN_RATIO) || 0.05;

  const isPerpMarket = (marketId: string): boolean => {
    const adapter = registry.get(marketId);
    return Boolean(adapter?.capabilities.includes("funding"));
  };

  const loadExecutionOptions = async (
    source: PersistFilledOrderParams["source"],
    orderId: string,
    market: string,
  ): Promise<FillExecutionOptions> => {
    if (source.kind === "new") {
      return source.executionOptions;
    }

    const persistedParams = await db
      .select()
      .from(orderExecutionParams)
      .where(eq(orderExecutionParams.orderId, orderId))
      .get();

    return {
      leverage: persistedParams?.leverage ?? 1,
      reduceOnly: persistedParams?.reduceOnly ?? false,
      takerFeeRate: persistedParams?.takerFeeRate ?? getTakerFeeRate(market),
    };
  };

  const persistFilledOrder = async ({
    accountId,
    orderId,
    order,
    executionPrice,
    createdAt,
    source,
  }: PersistFilledOrderParams): Promise<PersistFilledOrderResult> => {
    const isPerp = isPerpMarket(order.market);
    const executionOptions = await loadExecutionOptions(source, orderId, order.market);

    const persistenceResult = await db.transaction(async (tx) => {
      const latestAccount = await getFirst(tx.select().from(accounts).where(eq(accounts.id, accountId)).limit(1).all());
      if (!latestAccount) return { kind: "account_not_found" as const };

      const existingPosition = await getFirst(
        tx
          .select()
          .from(positions)
          .where(and(eq(positions.accountId, accountId), eq(positions.market, order.market), eq(positions.symbol, order.symbol)))
          .limit(1)
          .all(),
      );
      const existingPerpState = existingPosition && isPerp
        ? await tx.select().from(perpPositionState).where(eq(perpPositionState.positionId, existingPosition.id)).get()
        : null;

      const spotFillResult = isPerp
        ? null
        : executeFill({
            balance: latestAccount.balance,
            position: existingPosition ? { quantity: existingPosition.quantity, avgCost: existingPosition.avgCost } : null,
            side: order.side,
            quantity: order.quantity,
            price: executionPrice,
            allowShort: false,
            takerFeeRate: executionOptions.takerFeeRate,
          });
      const perpFillResult = isPerp
        ? executePerpFill({
            balance: latestAccount.balance,
            position: existingPosition
              ? {
                  quantity: existingPosition.quantity,
                  avgCost: existingPosition.avgCost,
                  margin:
                    existingPerpState?.margin ??
                    Number(
                      (
                        Math.abs(existingPosition.quantity * existingPosition.avgCost) /
                        Math.max(existingPerpState?.leverage ?? executionOptions.leverage, 1)
                      ).toFixed(6),
                    ),
                  leverage: existingPerpState?.leverage ?? executionOptions.leverage,
                  maintenanceMarginRatio: existingPerpState?.maintenanceMarginRatio ?? defaultMaintenanceMarginRatio,
                }
              : null,
            side: order.side,
            quantity: order.quantity,
            price: executionPrice,
            leverage: executionOptions.leverage,
            maintenanceMarginRatio: existingPerpState?.maintenanceMarginRatio ?? defaultMaintenanceMarginRatio,
            reduceOnly: executionOptions.reduceOnly,
            takerFeeRate: executionOptions.takerFeeRate,
          })
        : null;
      const fillResult = isPerp ? perpFillResult : spotFillResult;
      if (!fillResult) {
        throw new Error("Order fill result not generated");
      }

      if (source.kind === "new") {
        await tx
          .insert(orders)
          .values({
            id: orderId,
            accountId,
            market: order.market,
            symbol: order.symbol,
            side: order.side,
            type: source.type,
            quantity: order.quantity,
            limitPrice: source.limitPrice,
            status: "filled",
            filledPrice: executionPrice,
            reasoning: order.reasoning,
            cancelReasoning: null,
            cancelledAt: null,
            filledAt: createdAt,
            createdAt,
          })
          .run();

        await tx
          .insert(orderExecutionParams)
          .values({
            orderId,
            leverage: executionOptions.leverage,
            reduceOnly: executionOptions.reduceOnly,
            takerFeeRate: executionOptions.takerFeeRate,
          })
          .onConflictDoNothing()
          .run();
      } else {
        const claimedOrder = await tx
          .update(orders)
          .set({ status: "filled", filledPrice: executionPrice, filledAt: createdAt, cancelReasoning: null, cancelledAt: null })
          .where(and(eq(orders.id, orderId), eq(orders.status, "pending")))
          .run();
        if (claimedOrder.rowsAffected === 0) {
          return { kind: "order_not_pending" as const };
        }
      }

      await tx.update(accounts).set({ balance: fillResult.nextBalance }).where(eq(accounts.id, accountId)).run();

      if (!fillResult.nextPosition) {
        if (existingPosition) {
          await tx.delete(positions).where(eq(positions.id, existingPosition.id)).run();
          if (isPerp) {
            await tx.delete(perpPositionState).where(eq(perpPositionState.positionId, existingPosition.id)).run();
          }
        }
      } else if (existingPosition) {
        await tx
          .update(positions)
          .set({ quantity: fillResult.nextPosition.quantity, avgCost: fillResult.nextPosition.avgCost })
          .where(eq(positions.id, existingPosition.id))
          .run();

        if (isPerp) {
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
              market: order.market,
              symbol: order.symbol,
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
            market: order.market,
            symbol: order.symbol,
            quantity: fillResult.nextPosition.quantity,
            avgCost: fillResult.nextPosition.avgCost,
          })
          .run();

        if (isPerp) {
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
              market: order.market,
              symbol: order.symbol,
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
          market: order.market,
          symbol: order.symbol,
          side: order.side,
          quantity: order.quantity,
          price: executionPrice,
          fee: fillResult.feePaid,
          createdAt,
        })
        .run();

      return {
        kind: "filled" as const,
        userId: latestAccount.userId,
        accountId: latestAccount.id,
      };
    });

    if (persistenceResult.kind === "account_not_found") {
      return { kind: "account_not_found" };
    }
    if (persistenceResult.kind === "order_not_pending") {
      return { kind: "order_not_pending" };
    }

    const filled = await getFirst(db.select().from(orders).where(eq(orders.id, orderId)).limit(1).all());
    if (!filled) {
      throw new Error(`Filled order ${orderId} could not be loaded after persistence`);
    }

    eventBus.emit({
      type: "order.filled",
      userId: persistenceResult.userId,
      accountId: persistenceResult.accountId,
      orderId,
      data: {
        market: order.market,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        executionPrice,
        filledAt: createdAt,
        limitPrice: source.limitPrice,
      },
    });

    return { kind: "filled", order: filled };
  };

  const persistNewFilledOrder = async (params: Omit<PersistFilledOrderParams, "source"> & { source: NewFillSource }): Promise<OrderPlacementResult> => {
    const persisted = await persistFilledOrder(params);
    if (persisted.kind === "account_not_found") {
      return { kind: "error", status: 404, code: "ACCOUNT_NOT_FOUND", message: "Account not found" };
    }
    if (persisted.kind === "order_not_pending") {
      throw new Error(`Unexpected order state while persisting new order ${params.orderId}`);
    }
    return persisted;
  };

  const placeOrderForAccount = async ({
    account,
    order,
    orderId = makeId("ord"),
    createdAt = nowIso(),
  }: PlaceOrderForAccountParams): Promise<OrderPlacementResult> => {
    const adapter = registry.get(order.market);
    if (!adapter) {
      return { kind: "error", status: 404, code: "MARKET_NOT_FOUND", message: `Market not found: ${order.market}` };
    }

    const perpMarket = isPerpMarket(order.market);
    const requestedLeverage = order.leverage ?? 1;
    const reduceOnly = order.reduceOnly ?? false;
    const takerFeeRate = getTakerFeeRate(order.market);

    if (!perpMarket && requestedLeverage !== 1) {
      return { kind: "error", status: 400, code: "INVALID_INPUT", message: "leverage is only supported for perpetual markets" };
    }
    if (!perpMarket && reduceOnly) {
      return { kind: "error", status: 400, code: "INVALID_INPUT", message: "reduceOnly is only supported for perpetual markets" };
    }

    const normalizedSymbol =
      typeof adapter.normalizeSymbol === "function"
        ? await adapter.normalizeSymbol(order.symbol)
        : order.symbol;
    const tradingConstraints = await resolveTradingConstraints(adapter, normalizedSymbol);

    if (order.quantity < tradingConstraints.minQuantity) {
      return {
        kind: "error",
        status: 400,
        code: "INVALID_INPUT",
        message: `quantity must be greater than or equal to ${tradingConstraints.minQuantity}`,
      };
    }
    if (!isStepAligned(order.quantity, tradingConstraints.quantityStep)) {
      return {
        kind: "error",
        status: 400,
        code: "INVALID_INPUT",
        message: `quantity must align with step ${tradingConstraints.quantityStep}`,
      };
    }
    if (!tradingConstraints.supportsFractional && !Number.isInteger(order.quantity)) {
      return { kind: "error", status: 400, code: "INVALID_INPUT", message: "quantity must be an integer for this market" };
    }
    const maxLeverage = tradingConstraints.maxLeverage ?? null;
    if (perpMarket && maxLeverage !== null && requestedLeverage > maxLeverage) {
      return {
        kind: "error",
        status: 400,
        code: "INVALID_INPUT",
        message: `leverage exceeds maxLeverage=${maxLeverage} for ${normalizedSymbol}`,
      };
    }

    if (order.type === "limit") {
      let executionPrice: number | null = null;
      try {
        const quote = await adapter.getQuote(normalizedSymbol);
        const candidatePrice = quoteSidePrice(order.side, quote);
        const limitPrice = order.limitPrice as number;
        const shouldFillNow = order.side === "buy" ? candidatePrice <= limitPrice : candidatePrice >= limitPrice;
        if (shouldFillNow) executionPrice = candidatePrice;
      } catch {
        executionPrice = null;
      }

      if (executionPrice === null) {
        const baseOrder: OrderRow = {
          id: orderId,
          accountId: account.id,
          market: order.market,
          symbol: normalizedSymbol,
          side: order.side,
          type: "limit",
          quantity: order.quantity,
          limitPrice: order.limitPrice ?? null,
          status: "pending",
          filledPrice: null,
          reasoning: order.reasoning,
          cancelReasoning: null,
          cancelledAt: null,
          filledAt: null,
          createdAt,
        };
        await db.transaction(async (tx) => {
          await tx.insert(orders).values(baseOrder).run();
          await tx
            .insert(orderExecutionParams)
            .values({
              orderId,
              leverage: requestedLeverage,
              reduceOnly,
              takerFeeRate,
            })
            .onConflictDoNothing()
            .run();
        });
        return { kind: "pending", order: baseOrder };
      }

      return persistNewFilledOrder({
        accountId: account.id,
        orderId,
        order: {
          market: order.market,
          symbol: normalizedSymbol,
          side: order.side,
          quantity: order.quantity,
          reasoning: order.reasoning,
        },
        executionPrice,
        createdAt,
        source: {
          kind: "new",
          type: "limit",
          limitPrice: order.limitPrice ?? null,
          executionOptions: {
            leverage: requestedLeverage,
            reduceOnly,
            takerFeeRate,
          },
        },
      });
    }

    const quote = await adapter.getQuote(normalizedSymbol);
    const executionPrice = quoteSidePrice(order.side, quote);
    return persistNewFilledOrder({
      accountId: account.id,
      orderId,
      order: {
        market: order.market,
        symbol: normalizedSymbol,
        side: order.side,
        quantity: order.quantity,
        reasoning: order.reasoning,
      },
      executionPrice,
      createdAt,
      source: {
        kind: "new",
        type: "market",
        limitPrice: null,
        executionOptions: {
          leverage: requestedLeverage,
          reduceOnly,
          takerFeeRate,
        },
      },
    });
  };

  const fillPendingOrder = async ({
    pendingOrder,
    executionPrice,
    filledAt = nowIso(),
  }: FillPendingOrderParams): Promise<FillPendingOrderResult> => {
    if (pendingOrder.type !== "limit" || pendingOrder.limitPrice === null) {
      return { kind: "skipped", reason: "ORDER_NOT_PENDING" };
    }

    const persisted = await persistFilledOrder({
      accountId: pendingOrder.accountId,
      orderId: pendingOrder.id,
      order: {
        market: pendingOrder.market,
        symbol: pendingOrder.symbol,
        side: pendingOrder.side as PlaceOrderInput["side"],
        quantity: pendingOrder.quantity,
        reasoning: pendingOrder.reasoning,
      },
      executionPrice,
      createdAt: filledAt,
      source: {
        kind: "pending",
        type: "limit",
        limitPrice: pendingOrder.limitPrice,
      },
    });

    if (persisted.kind === "account_not_found") {
      return { kind: "skipped", reason: "ACCOUNT_NOT_FOUND" };
    }
    if (persisted.kind === "order_not_pending") {
      return { kind: "skipped", reason: "ORDER_NOT_PENDING" };
    }
    return persisted;
  };

  return {
    placeOrderForAccount,
    fillPendingOrder,
  };
};
