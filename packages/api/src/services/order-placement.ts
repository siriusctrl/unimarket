import {
  calculatePerpLiquidationPrice,
  executeFill,
  executePerpFill,
  type PlaceOrderInput,
} from "@unimarket/core";
import { getExecutionPrice, MarketAdapterError, type MarketRegistry } from "@unimarket/markets";
import { and, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { accounts, orderExecutionParams, orders, perpPositionState, positions, predictions, trades } from "../db/schema.js";
import { eventBus } from "../platform/events.js";
import { getTakerFeeRate } from "../fees.js";
import { getFirst } from "../platform/helpers.js";
import { makeId, nowIso } from "../utils.js";

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
  prediction?: PlaceOrderInput["prediction"];
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

const isStepAligned = (quantity: number, step: number): boolean => {
  const units = quantity / step;
  const rounded = Math.round(units);
  const epsilon = Math.max(1e-9, Math.abs(step) * 1e-9);
  return Math.abs(units - rounded) <= epsilon;
};

type PredictionTx = {
  insert: typeof db.insert;
};

const persistOrderPrediction = async (
  tx: PredictionTx,
  {
    orderId,
    account,
    order,
    entryPrice,
    submittedAt,
  }: {
    orderId: string;
    account: AccountRow;
    order: FillableOrder;
    entryPrice: number | null;
    submittedAt: string;
  },
): Promise<void> => {
  if (!order.prediction) return;

  await tx
    .insert(predictions)
    .values({
      id: makeId("prd"),
      orderId,
      accountId: account.id,
      userId: account.userId,
      market: order.market,
      symbol: order.symbol,
      side: order.side,
      outcome: order.prediction.outcome,
      probability: order.prediction.probability,
      conviction: order.prediction.conviction ?? null,
      thesis: order.prediction.thesis ?? null,
      entryPrice,
      submittedAt,
    })
    .onConflictDoNothing()
    .run();
};

export const createOrderPlacementService = (registry: MarketRegistry) => {
  const defaultMaintenanceMarginRatio = Number(process.env.MAINTENANCE_MARGIN_RATIO) || 0.05;

  const isPerpMarket = (marketId: string): boolean => {
    const adapter = registry.get(marketId);
    return Boolean(adapter?.getFundingRate);
  };

  const loadExecutionOptions = async (
    source: PersistFilledOrderParams["source"],
    orderId: string,
  ): Promise<FillExecutionOptions> => {
    if (source.kind === "new") {
      return source.executionOptions;
    }

    const persistedParams = await db
      .select()
      .from(orderExecutionParams)
      .where(eq(orderExecutionParams.orderId, orderId))
      .get();

    if (!persistedParams) {
      throw new Error(`Execution parameters missing for pending order ${orderId}`);
    }

    return persistedParams;
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
    const executionOptions = await loadExecutionOptions(source, orderId);

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

      let perpFillResult: ReturnType<typeof executePerpFill> | null = null;
      const fillResult = (() => {
        if (!isPerp) {
          return executeFill({
            balance: latestAccount.balance,
            position: existingPosition ? { quantity: existingPosition.quantity, avgCost: existingPosition.avgCost } : null,
            side: order.side,
            quantity: order.quantity,
            price: executionPrice,
            allowShort: false,
            takerFeeRate: executionOptions.takerFeeRate,
          });
        }

        if (existingPosition && !existingPerpState) {
          throw new Error(`Perpetual position state missing for position ${existingPosition.id}`);
        }

        const currentPerpPosition = existingPosition && existingPerpState
          ? {
              quantity: existingPosition.quantity,
              avgCost: existingPosition.avgCost,
              margin: existingPerpState.margin,
              leverage: existingPerpState.leverage,
              maintenanceMarginRatio: existingPerpState.maintenanceMarginRatio,
            }
          : null;

        perpFillResult = executePerpFill({
          balance: latestAccount.balance,
          position: currentPerpPosition,
          side: order.side,
          quantity: order.quantity,
          price: executionPrice,
          leverage: executionOptions.leverage,
          maintenanceMarginRatio: existingPerpState?.maintenanceMarginRatio ?? defaultMaintenanceMarginRatio,
          reduceOnly: executionOptions.reduceOnly,
          takerFeeRate: executionOptions.takerFeeRate,
        });
        return perpFillResult;
      })();

      const requirePerpPosition = () => {
        if (!perpFillResult?.nextPosition) {
          throw new Error(`Perpetual fill did not produce position state for order ${orderId}`);
        }
        return perpFillResult.nextPosition;
      };

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

        await persistOrderPrediction(tx, {
          orderId,
          account: latestAccount,
          order,
          entryPrice: executionPrice,
          submittedAt: createdAt,
        });
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
          const perpNextPosition = requirePerpPosition();
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
          const perpNextPosition = requirePerpPosition();
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

    const normalizedSymbol = await adapter.normalizeReference(order.reference);
    const tradingConstraints = await adapter.getTradingConstraints(normalizedSymbol);

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
    const maxLeverage = tradingConstraints.maxLeverage;
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
      let observedPrice: number | null = null;
      try {
        const quote = await adapter.getQuote(normalizedSymbol);
        const candidatePrice = getExecutionPrice(quote, order.side);
        observedPrice = candidatePrice;
        const limitPrice = order.limitPrice as number;
        const shouldFillNow = order.side === "buy" ? candidatePrice <= limitPrice : candidatePrice >= limitPrice;
        if (shouldFillNow) executionPrice = candidatePrice;
      } catch (error) {
        if (
          !(error instanceof MarketAdapterError) ||
          (error.code !== "UPSTREAM_ERROR" && error.code !== "UPSTREAM_TIMEOUT")
        ) {
          throw error;
        }
        executionPrice = null;
        observedPrice = null;
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
          await persistOrderPrediction(tx, {
            orderId,
            account,
            order: {
              market: order.market,
              symbol: normalizedSymbol,
              side: order.side,
              quantity: order.quantity,
              reasoning: order.reasoning,
              prediction: order.prediction,
            },
            entryPrice: observedPrice,
            submittedAt: createdAt,
          });
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
          prediction: order.prediction,
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
    const executionPrice = getExecutionPrice(quote, order.side);
    return persistNewFilledOrder({
      accountId: account.id,
      orderId,
      order: {
        market: order.market,
        symbol: normalizedSymbol,
        side: order.side,
        quantity: order.quantity,
        reasoning: order.reasoning,
        prediction: order.prediction,
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
