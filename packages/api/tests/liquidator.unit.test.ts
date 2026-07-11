import { afterEach, describe, expect, it, vi } from "vitest";

type PositionRow = { id: string; accountId: string; market: string; symbol: string; quantity: number; avgCost: number };
type StateRow = { positionId: string; accountId: string; market: string; symbol: string; leverage: number; margin: number; maintenanceMarginRatio: number; liquidationPrice: number | null };
type AccountRow = { id: string; userId: string; balance: number };
type PendingOrder = { id: string; accountId: string; market: string; symbol: string; status: string; side: string; quantity: number };

const loadModule = async (options: {
  rows?: PositionRow[];
  stateByPositionId?: Record<string, StateRow | null>;
  latestPosition?: PositionRow | null;
  latestState?: StateRow | null;
  account?: AccountRow | null;
  pendingOrders?: PendingOrder[];
  executionParams?: Array<{ orderId: string; reduceOnly: boolean }>;
  cancelResults?: Record<string, { id: string; accountId: string; market: string; symbol: string; side: string; quantity: number; reasoning: string; cancelledAt: string } | null>;
  getQuote?: (symbol: string) => Promise<{ price: number; bid?: number; ask?: number }>;
  makeIds?: string[];
}) => {
  vi.resetModules();
  const tables = {
    positions: { __name: "positions", id: "positions.id" },
    perpPositionState: { __name: "perpPositionState", positionId: "perpPositionState.positionId" },
    accounts: { __name: "accounts", id: "accounts.id" },
    orders: { __name: "orders", id: "orders.id", accountId: "orders.accountId", market: "orders.market", symbol: "orders.symbol", status: "orders.status" },
    orderExecutionParams: { __name: "orderExecutionParams", orderId: "orderExecutionParams.orderId" },
    trades: { __name: "trades" },
    liquidations: { __name: "liquidations" },
  };

  const inserted: Array<{ table: string; row: unknown }> = [];
  const updated: Array<{ table: string; row: unknown }> = [];
  const deleted: string[] = [];
  const eventEmit = vi.fn();
  const emitOrderCancelled = vi.fn();
  const cancelPendingOrderInTx = vi.fn(async (_tx, { order }: { order: PendingOrder }) => options.cancelResults?.[order.id] ?? null);
  const startPeriodicWorker = vi.fn((_config) => () => undefined);
  const logError = vi.spyOn(console, "error").mockImplementation(() => {});
  const logInfo = vi.spyOn(console, "log").mockImplementation(() => {});
  const idQueue = [...(options.makeIds ?? ["ord_1", "liq_1", "trd_1"])]
  const stateReadQueue = (options.rows ?? []).map((row) => options.stateByPositionId?.[row.id] ?? null);
  let outerStateReadIndex = 0;
  let txStateReadIndex = 0;
  const getQuote = vi.fn(options.getQuote ?? (async () => ({ price: 100, bid: 99, ask: 101 })));

  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          get: async () => {
            if (table === tables.positions) {
              if (Object.prototype.hasOwnProperty.call(options, "latestPosition")) return options.latestPosition ?? null;
              return options.rows?.[0] ?? null;
            }
            if (table === tables.perpPositionState) {
              if (Object.prototype.hasOwnProperty.call(options, "latestState")) return options.latestState ?? null;
              return stateReadQueue[txStateReadIndex++] ?? null;
            }
            if (table === tables.accounts) return options.account ?? null;
            return null;
          },
          all: async () => {
            if (table === tables.orders) return options.pendingOrders ?? [];
            if (table === tables.orderExecutionParams) return options.executionParams ?? [];
            return [];
          },
        }),
        all: async () => {
          if (table === tables.positions) return options.rows ?? [];
          return [];
        },
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
          all: async () => {
            if (table === tables.positions) return options.rows ?? [];
            return [];
          },
          where: () => ({
            get: async () => {
              if (table === tables.perpPositionState) {
                return stateReadQueue[outerStateReadIndex++] ?? null;
              }
              return null;
            },
          }),
        }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    },
  }));
  vi.doMock("../src/db/schema.js", () => tables);
  vi.doMock("../src/platform/events.js", () => ({ eventBus: { emit: eventEmit } }));
  vi.doMock("../src/fees.js", () => ({ getTakerFeeRate: vi.fn(() => 0.01) }));
  vi.doMock("../src/services/order-cancellation.js", () => ({ cancelPendingOrderInTx, emitOrderCancelled }));
  vi.doMock("../src/utils.js", () => ({
    makeId: (prefix: string) => idQueue.shift() ?? `${prefix}_x`,
    nowIso: () => "2026-03-07T00:00:00.000Z",
  }));
  vi.doMock("../src/workers/periodic-worker.js", () => ({ startPeriodicWorker }));

  const mod = await import("../src/workers/liquidator.js");
  const registry = { get: vi.fn(() => ({ getFundingRate: vi.fn(), getQuote })) };
  return { ...mod, registry, inserted, updated, deleted, eventEmit, emitOrderCancelled, cancelPendingOrderInTx, startPeriodicWorker, getQuote, logError, logInfo };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("liquidateUnsafePerpPositions", () => {
  it("skips positions without perp adapters, state, quotes, or breached maintenance", async () => {
    const rows: PositionRow[] = [
      { id: "p1", accountId: "acct", market: "perp", symbol: "ETH", quantity: 1, avgCost: 100 },
      { id: "p2", accountId: "acct", market: "perp", symbol: "SOL", quantity: 1, avgCost: 100 },
      { id: "p3", accountId: "acct", market: "perp", symbol: "BTC", quantity: 1, avgCost: 100 },
      { id: "p4", accountId: "acct", market: "spot", symbol: "YES", quantity: 1, avgCost: 100 },
    ];
    const mod = await loadModule({
      rows,
      stateByPositionId: {
        p1: { positionId: "p1", accountId: "acct", market: "perp", symbol: "ETH", leverage: 5, margin: 100, maintenanceMarginRatio: 0.05, liquidationPrice: null },
        p2: { positionId: "p2", accountId: "acct", market: "perp", symbol: "SOL", leverage: 5, margin: 5, maintenanceMarginRatio: 0.05, liquidationPrice: null },
        p3: null,
      },
    });

    mod.registry.get = vi.fn((market: string) => {
      if (market === "perp") return { getFundingRate: vi.fn(), getQuote: mod.getQuote };
      return undefined;
    });
    mod.getQuote.mockImplementation(async (symbol: string) => {
      if (symbol === "ETH") return { price: 100, bid: 99, ask: 101 };
      throw new Error("quote fail");
    });

    await expect(mod.liquidateUnsafePerpPositions(mod.registry as never)).resolves.toEqual({ checked: 2, liquidated: 0, skipped: 3 });
    expect(mod.getQuote).toHaveBeenCalledTimes(2);
    expect(mod.getQuote).toHaveBeenCalledWith("ETH");
    expect(mod.getQuote).toHaveBeenCalledWith("SOL");
    expect(mod.cancelPendingOrderInTx).not.toHaveBeenCalled();
    expect(mod.eventEmit).not.toHaveBeenCalled();
  });

  it("liquidates unsafe positions, auto-cancels reduceOnly orders, and emits audit events", async () => {
    const row = { id: "p1", accountId: "acct_1", market: "perp", symbol: "BTC", quantity: 2, avgCost: 100 };
    const state = { positionId: "p1", accountId: "acct_1", market: "perp", symbol: "BTC", leverage: 5, margin: 5, maintenanceMarginRatio: 0.1, liquidationPrice: null };
    const mod = await loadModule({
      rows: [row],
      stateByPositionId: { p1: state },
      latestPosition: row,
      latestState: state,
      account: { id: "acct_1", userId: "usr_1", balance: 10 },
      pendingOrders: [
        { id: "ro_1", accountId: "acct_1", market: "perp", symbol: "BTC", status: "pending", side: "sell", quantity: 1 },
        { id: "plain_1", accountId: "acct_1", market: "perp", symbol: "BTC", status: "pending", side: "sell", quantity: 1 },
      ],
      executionParams: [
        { orderId: "ro_1", reduceOnly: true },
        { orderId: "plain_1", reduceOnly: false },
      ],
      cancelResults: {
        ro_1: {
          id: "ro_1",
          accountId: "acct_1",
          market: "perp",
          symbol: "BTC",
          side: "sell",
          quantity: 1,
          reasoning: "Auto-cancelled: linked position was liquidated",
          cancelledAt: "2026-03-07T00:00:00.000Z",
        },
      },
      getQuote: async () => ({ price: 40, bid: 39, ask: 41 }),
    });

    await expect(mod.liquidateUnsafePerpPositions(mod.registry as never)).resolves.toEqual({ checked: 1, liquidated: 1, skipped: 0 });
    expect(mod.cancelPendingOrderInTx).toHaveBeenCalledTimes(1);
    expect(mod.emitOrderCancelled).toHaveBeenCalledWith(expect.objectContaining({ userId: "usr_1", order: expect.objectContaining({ id: "ro_1" }) }));
    expect(mod.eventEmit).toHaveBeenCalledWith(expect.objectContaining({ type: "order.filled" }));
    expect(mod.eventEmit).toHaveBeenCalledWith(expect.objectContaining({ type: "position.liquidated" }));
    expect(mod.updated).toEqual(expect.arrayContaining([expect.objectContaining({ table: "accounts" })]));
    expect(mod.deleted).toEqual(expect.arrayContaining(["perpPositionState", "positions"]));
  });

  it("skips liquidation when the latest position disappeared, recovered, or lost its account", async () => {
    const row = { id: "p1", accountId: "acct_1", market: "perp", symbol: "BTC", quantity: 2, avgCost: 100 };
    const unsafeState = { positionId: "p1", accountId: "acct_1", market: "perp", symbol: "BTC", leverage: 5, margin: 5, maintenanceMarginRatio: 0.1, liquidationPrice: null };

    const disappeared = await loadModule({ rows: [row], stateByPositionId: { p1: unsafeState }, latestPosition: null, getQuote: async () => ({ price: 40, bid: 39, ask: 41 }) });
    await expect(disappeared.liquidateUnsafePerpPositions(disappeared.registry as never)).resolves.toEqual({ checked: 1, liquidated: 0, skipped: 1 });

    const recovered = await loadModule({
      rows: [row],
      stateByPositionId: { p1: unsafeState },
      latestPosition: row,
      latestState: { ...unsafeState, margin: 100 },
      account: { id: "acct_1", userId: "usr_1", balance: 10 },
      getQuote: async () => ({ price: 100, bid: 99, ask: 101 }),
    });
    await expect(recovered.liquidateUnsafePerpPositions(recovered.registry as never)).resolves.toEqual({ checked: 1, liquidated: 0, skipped: 1 });

    const missingAccount = await loadModule({ rows: [row], stateByPositionId: { p1: unsafeState }, latestPosition: row, latestState: unsafeState, account: null, getQuote: async () => ({ price: 40, bid: 39, ask: 41 }) });
    await expect(missingAccount.liquidateUnsafePerpPositions(missingAccount.registry as never)).resolves.toEqual({ checked: 1, liquidated: 0, skipped: 1 });
  });

  it("logs and skips transaction failures without emitting partial events", async () => {
    const row = { id: "p1", accountId: "acct_1", market: "perp", symbol: "BTC", quantity: 2, avgCost: 100 };
    vi.resetModules();
    const tables = {
      positions: { __name: "positions", id: "positions.id" },
      perpPositionState: { __name: "perpPositionState", positionId: "perpPositionState.positionId" },
      accounts: { __name: "accounts", id: "accounts.id" },
      orders: { __name: "orders", id: "orders.id", accountId: "orders.accountId", market: "orders.market", symbol: "orders.symbol", status: "orders.status" },
      orderExecutionParams: { __name: "orderExecutionParams", orderId: "orderExecutionParams.orderId" },
      trades: { __name: "trades" },
      liquidations: { __name: "liquidations" },
    };
    const eventEmit = vi.fn();
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("../src/db/client.js", () => ({
      db: {
        select: () => ({ from: (table: unknown) => ({ all: async () => (table === tables.positions ? [row] : []), where: () => ({ get: async () => ({ positionId: "p1", accountId: "acct_1", market: "perp", symbol: "BTC", leverage: 5, margin: 5, maintenanceMarginRatio: 0.1, liquidationPrice: null }) }) }) }),
        transaction: async () => { throw new Error("db blew up"); },
      },
    }));
    vi.doMock("../src/db/schema.js", () => tables);
    vi.doMock("../src/platform/events.js", () => ({ eventBus: { emit: eventEmit } }));
    vi.doMock("../src/fees.js", () => ({ getTakerFeeRate: vi.fn(() => 0.01) }));
    vi.doMock("../src/services/order-cancellation.js", () => ({ cancelPendingOrderInTx: vi.fn(), emitOrderCancelled: vi.fn() }));
    vi.doMock("../src/utils.js", () => ({ makeId: (prefix: string) => `${prefix}_1`, nowIso: () => "2026-03-07T00:00:00.000Z" }));
    vi.doMock("../src/workers/periodic-worker.js", () => ({ startPeriodicWorker: vi.fn((_config) => () => undefined) }));

    const mod = await import("../src/workers/liquidator.js");
    const registry = { get: vi.fn(() => ({ getFundingRate: vi.fn(), getQuote: vi.fn(async () => ({ price: 40, bid: 39, ask: 41 })) })) };

    await expect(mod.liquidateUnsafePerpPositions(registry as never)).resolves.toEqual({ checked: 1, liquidated: 0, skipped: 1 });
    expect(logError).toHaveBeenCalled();
    expect(eventEmit).not.toHaveBeenCalled();
  });
});

describe("startLiquidator", () => {
  it("wires the periodic worker and logs only when liquidations occurred", async () => {
    const mod = await loadModule({ rows: [] });
    const stop = mod.startLiquidator(mod.registry as never);
    expect(mod.startPeriodicWorker).toHaveBeenCalledWith(expect.objectContaining({
      name: "liquidator",
      envVar: "LIQUIDATION_INTERVAL_MS",
      defaultIntervalMs: 5_000,
    }));

    const config = mod.startPeriodicWorker.mock.calls[0]?.[0];
    config?.onResult?.({ checked: 3, liquidated: 1, skipped: 2 });
    config?.onResult?.({ checked: 3, liquidated: 0, skipped: 3 });
    expect(mod.logInfo).toHaveBeenCalledWith("[liquidator] liquidated 1 positions");
    expect(stop).toBeTypeOf("function");
  });
});
