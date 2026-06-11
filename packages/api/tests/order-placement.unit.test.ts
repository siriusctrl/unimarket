import { afterEach, describe, expect, it, vi } from "vitest";

type AccountRow = { id: string; userId: string; balance: number };
type PositionRow = { id: string; accountId: string; market: string; symbol: string; quantity: number; avgCost: number };
type PerpStateRow = {
  positionId: string;
  accountId: string;
  market: string;
  symbol: string;
  leverage: number;
  margin: number;
  maintenanceMarginRatio: number;
  liquidationPrice: number | null;
  updatedAt: string;
};

type LoadOptions = {
  latestAccount?: AccountRow | null;
  existingPosition?: PositionRow | null;
  existingPerpState?: PerpStateRow | null;
  loadedFilledOrder?: Record<string, unknown> | null;
  persistedParams?: { leverage?: number; reduceOnly?: boolean; takerFeeRate?: number } | null;
  quoteBySymbol?: Record<string, { price: number; bid?: number; ask?: number }>;
  executeFillResult?: { nextBalance: number; nextPosition: { quantity: number; avgCost: number } | null; feePaid: number };
  executePerpFillResult?: {
    nextBalance: number;
    nextPosition: { quantity: number; avgCost: number; leverage: number; margin: number; maintenanceMarginRatio: number } | null;
    feePaid: number;
  };
  takerFeeRate?: number;
};

const loadModule = async (options: LoadOptions = {}) => {
  vi.resetModules();

  const tables = {
    accounts: { __name: "accounts" },
    positions: { __name: "positions" },
    perpPositionState: { __name: "perpPositionState" },
    orderExecutionParams: { __name: "orderExecutionParams" },
    orders: { __name: "orders" },
    predictions: { __name: "predictions" },
    trades: { __name: "trades" },
  };

  const inserted: Array<{ table: string; row: unknown }> = [];
  const updated: Array<{ table: string; row: unknown }> = [];
  const deleted: string[] = [];
  const eventEmit = vi.fn();
  const executeFill = vi.fn().mockReturnValue(
    options.executeFillResult ?? {
      nextBalance: 90,
      nextPosition: { quantity: 1, avgCost: 101 },
      feePaid: 1,
    },
  );
  const executePerpFill = vi.fn().mockReturnValue(
    options.executePerpFillResult ?? {
      nextBalance: 80,
      nextPosition: { quantity: 2, avgCost: 102, leverage: 5, margin: 20, maintenanceMarginRatio: 0.05 },
      feePaid: 2,
    },
  );

  const queryResult = (table: unknown) => {
    if (table === tables.orderExecutionParams) return options.persistedParams ?? null;
    if (table === tables.orders) return options.loadedFilledOrder ? [options.loadedFilledOrder] : [];
    return [];
  };

  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: () => ({
            all: async () => {
              if (table === tables.accounts) return options.latestAccount ? [options.latestAccount] : [];
              if (table === tables.positions) return options.existingPosition ? [options.existingPosition] : [];
              if (table === tables.orders) return options.loadedFilledOrder ? [options.loadedFilledOrder] : [];
              return [];
            },
          }),
          get: async () => {
            if (table === tables.perpPositionState) return options.existingPerpState ?? null;
            return null;
          },
          all: async () => [],
        }),
      }),
    }),
    insert: (table: { __name: string }) => ({
      values: (row: unknown) => ({
        onConflictDoNothing: () => ({
          run: async () => {
            inserted.push({ table: table.__name, row });
            return { rowsAffected: 1 };
          },
        }),
        onConflictDoUpdate: () => ({
          run: async () => {
            inserted.push({ table: table.__name, row });
            return { rowsAffected: 1 };
          },
        }),
        run: async () => {
          inserted.push({ table: table.__name, row });
          return { rowsAffected: 1 };
        },
      }),
    }),
    update: (table: { __name: string }) => ({
      set: (row: unknown) => ({
        where: () => ({
          run: async () => {
            updated.push({ table: table.__name, row });
            return { rowsAffected: 1 };
          },
        }),
      }),
    }),
    delete: (table: { __name: string }) => ({
      where: () => ({
        run: async () => {
          deleted.push(table.__name);
          return { rowsAffected: 1 };
        },
      }),
    }),
  };

  vi.doMock("../src/db/client.js", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            get: async () => queryResult(table),
            limit: () => ({ all: async () => queryResult(table) }),
            all: async () => queryResult(table),
          }),
          limit: () => ({ all: async () => queryResult(table) }),
          all: async () => queryResult(table),
        }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    },
  }));
  vi.doMock("../src/db/schema.js", () => ({
    accounts: tables.accounts,
    positions: tables.positions,
    perpPositionState: tables.perpPositionState,
    orderExecutionParams: tables.orderExecutionParams,
    orders: tables.orders,
    predictions: tables.predictions,
    trades: tables.trades,
  }));
  vi.doMock("../src/platform/events.js", () => ({ eventBus: { emit: eventEmit } }));
  vi.doMock("../src/fees.js", () => ({ getTakerFeeRate: vi.fn(() => options.takerFeeRate ?? 0.01) }));
  vi.doMock("../src/platform/helpers.js", () => ({ getFirst: async <T>(query: Promise<T[]>) => (await query)[0] }));
  vi.doMock("../src/utils.js", () => ({
    makeId: ((prefix: string) => `${prefix}_1`) as (prefix: string) => string,
    nowIso: () => "2026-03-07T00:00:00.000Z",
  }));
  vi.doMock("@unimarket/core", () => ({
    executeFill,
    executePerpFill,
    calculatePerpLiquidationPrice: vi.fn(() => 88.8),
  }));

  const mod = await import("../src/services/order-placement.js");
  return { ...mod, executeFill, executePerpFill, inserted, updated, deleted, eventEmit };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createOrderPlacementService", () => {
  it("rejects missing markets and invalid non-perp leverage settings", async () => {
    const { createOrderPlacementService } = await loadModule();
    const missingRegistry = { get: vi.fn(() => undefined) };
    const missingService = createOrderPlacementService(missingRegistry as never);

    await expect(
      missingService.placeOrderForAccount({
        account: { id: "acct_1", userId: "usr_1", balance: 100 },
        order: {
          market: "missing",
          reference: "BTC",
          side: "buy",
          type: "market",
          quantity: 1,
          reasoning: "test",
        },
      }),
    ).resolves.toMatchObject({ kind: "error", status: 404, code: "MARKET_NOT_FOUND" });

    const spotAdapter = {
      capabilities: ["quote"],
      getQuote: vi.fn().mockResolvedValue({ price: 10 }),
      getTradingConstraints: vi.fn().mockResolvedValue({ minQuantity: 1, quantityStep: 1, supportsFractional: false, maxLeverage: null }),
    };
    const spotRegistry = { get: vi.fn(() => spotAdapter) };
    const spotService = createOrderPlacementService(spotRegistry as never);

    await expect(
      spotService.placeOrderForAccount({
        account: { id: "acct_1", userId: "usr_1", balance: 100 },
        order: { market: "spot", reference: "YES", side: "buy", type: "market", quantity: 1, leverage: 2, reasoning: "test" },
      }),
    ).resolves.toMatchObject({ kind: "error", code: "INVALID_INPUT", message: expect.stringContaining("leverage") });

    await expect(
      spotService.placeOrderForAccount({
        account: { id: "acct_1", userId: "usr_1", balance: 100 },
        order: { market: "spot", reference: "YES", side: "buy", type: "market", quantity: 1, reduceOnly: true, reasoning: "test" },
      }),
    ).resolves.toMatchObject({ kind: "error", code: "INVALID_INPUT", message: expect.stringContaining("reduceOnly") });
  });

  it("enforces normalized trading constraints before placing orders", async () => {
    const { createOrderPlacementService } = await loadModule();
    const perpAdapter = {
      capabilities: ["quote", "funding"],
      normalizeReference: vi.fn().mockResolvedValue("BTC"),
      getQuote: vi.fn().mockResolvedValue({ price: 100, ask: 101, bid: 99 }),
      getTradingConstraints: vi.fn().mockResolvedValue({ minQuantity: 2, quantityStep: 0.5, supportsFractional: false, maxLeverage: 3 }),
    };
    const service = createOrderPlacementService({ get: vi.fn(() => perpAdapter) } as never);
    const account = { id: "acct_1", userId: "usr_1", balance: 100 };

    await expect(
      service.placeOrderForAccount({
        account,
        order: { market: "hyperliquid", reference: "btc-perp", side: "buy", type: "market", quantity: 1, reasoning: "too small" },
      }),
    ).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("greater than or equal") });

    await expect(
      service.placeOrderForAccount({
        account,
        order: { market: "hyperliquid", reference: "btc-perp", side: "buy", type: "market", quantity: 2.25, reasoning: "bad step" },
      }),
    ).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("align with step") });

    await expect(
      service.placeOrderForAccount({
        account,
        order: { market: "hyperliquid", reference: "btc-perp", side: "buy", type: "market", quantity: 2, leverage: 4, reasoning: "too much leverage" },
      }),
    ).resolves.toMatchObject({ kind: "error", message: expect.stringContaining("maxLeverage") });
  });

  it("stores non-crossing or unquotable limit orders as pending with execution params", async () => {
    const { createOrderPlacementService, inserted } = await loadModule();
    const adapter = {
      capabilities: ["quote", "funding"],
      normalizeReference: vi.fn().mockResolvedValue("BTC"),
      getQuote: vi.fn().mockRejectedValue(new Error("quote unavailable")),
      getTradingConstraints: vi.fn().mockResolvedValue({ minQuantity: 1, quantityStep: 1, supportsFractional: false, maxLeverage: 5 }),
    };
    const service = createOrderPlacementService({ get: vi.fn(() => adapter) } as never);

    const result = await service.placeOrderForAccount({
      account: { id: "acct_1", userId: "usr_1", balance: 100 },
      order: {
        market: "hyperliquid",
        reference: "BTC",
        side: "buy",
        type: "limit",
        quantity: 1,
        limitPrice: 99,
        leverage: 3,
        reduceOnly: true,
        reasoning: "resting order",
      },
    });

    expect(result).toMatchObject({ kind: "pending", order: { status: "pending", symbol: "BTC", limitPrice: 99 } });
    expect(inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "orders", row: expect.objectContaining({ status: "pending", symbol: "BTC" }) }),
        expect.objectContaining({
          table: "orderExecutionParams",
          row: expect.objectContaining({ leverage: 3, reduceOnly: true, takerFeeRate: 0.01 }),
        }),
      ]),
    );
  });

  it("fills spot market buys at ask and sells at bid, persisting trades and events", async () => {
    const buyLoadedOrder = { id: "ord_1", status: "filled", side: "buy", symbol: "YES" };
    const latestAccount = { id: "acct_1", userId: "usr_1", balance: 100 };
    const buyModule = await loadModule({ latestAccount, loadedFilledOrder: buyLoadedOrder });
    const adapter = {
      capabilities: ["quote"],
      normalizeReference: vi.fn().mockResolvedValue("YES"),
      getQuote: vi.fn().mockResolvedValue({ price: 10, ask: 11, bid: 9 }),
      getTradingConstraints: vi.fn().mockResolvedValue({ minQuantity: 1, quantityStep: 1, supportsFractional: false, maxLeverage: null }),
    };
    const buyService = buyModule.createOrderPlacementService({ get: vi.fn(() => adapter) } as never);
    await expect(
      buyService.placeOrderForAccount({
        account: latestAccount,
        order: { market: "spot", reference: "YES", side: "buy", type: "market", quantity: 1, reasoning: "buy" },
      }),
    ).resolves.toMatchObject({ kind: "filled", order: { status: "filled", symbol: "YES" } });
    expect(buyModule.executeFill).toHaveBeenCalledWith(expect.objectContaining({ side: "buy", price: 11 }));
    expect(buyModule.inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "trades", row: expect.objectContaining({ side: "buy", price: 11 }) }),
      ]),
    );
    expect(buyModule.eventEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "order.filled",
        accountId: "acct_1",
        data: expect.objectContaining({ side: "buy", executionPrice: 11 }),
      }),
    );

    const sellLoadedOrder = { id: "ord_1", status: "filled", side: "sell", symbol: "YES" };
    const sellModule = await loadModule({ latestAccount, loadedFilledOrder: sellLoadedOrder });
    const sellService = sellModule.createOrderPlacementService({ get: vi.fn(() => adapter) } as never);
    await expect(
      sellService.placeOrderForAccount({
        account: latestAccount,
        order: { market: "spot", reference: "YES", side: "sell", type: "market", quantity: 1, reasoning: "sell" },
      }),
    ).resolves.toMatchObject({ kind: "filled", order: { status: "filled", symbol: "YES" } });
    expect(sellModule.executeFill).toHaveBeenCalledWith(expect.objectContaining({ side: "sell", price: 9 }));
    expect(sellModule.inserted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "trades", row: expect.objectContaining({ side: "sell", price: 9 }) }),
      ]),
    );
  });

  it("reuses stored execution params when filling pending perp orders and skips invalid pending orders", async () => {
    const { createOrderPlacementService, executePerpFill } = await loadModule({
      latestAccount: { id: "acct_1", userId: "usr_1", balance: 100 },
      persistedParams: { leverage: 7, reduceOnly: true, takerFeeRate: 0.02 },
      loadedFilledOrder: { id: "ord_1", status: "filled", symbol: "BTC" },
      executePerpFillResult: {
        nextBalance: 80,
        nextPosition: { quantity: 2, avgCost: 100, leverage: 7, margin: 15, maintenanceMarginRatio: 0.05 },
        feePaid: 4,
      },
    });
    const service = createOrderPlacementService({
      get: vi.fn(() => ({ capabilities: ["funding", "quote"] })),
    } as never);

    await expect(
      service.fillPendingOrder({
        pendingOrder: {
          id: "ord_1",
          accountId: "acct_1",
          market: "hyperliquid",
          symbol: "BTC",
          side: "buy",
          type: "limit",
          quantity: 2,
          limitPrice: 100,
          status: "pending",
          reasoning: "resting",
        } as never,
        executionPrice: 100,
      }),
    ).resolves.toMatchObject({ kind: "filled" });
    expect(executePerpFill).toHaveBeenCalledWith(expect.objectContaining({ leverage: 7, reduceOnly: true, takerFeeRate: 0.02 }));

    await expect(
      service.fillPendingOrder({
        pendingOrder: {
          id: "ord_2",
          accountId: "acct_1",
          market: "hyperliquid",
          symbol: "BTC",
          side: "buy",
          type: "market",
          quantity: 1,
          limitPrice: null,
          status: "pending",
          reasoning: "bad",
        } as never,
        executionPrice: 100,
      }),
    ).resolves.toEqual({ kind: "skipped", reason: "ORDER_NOT_PENDING" });
  });
});
