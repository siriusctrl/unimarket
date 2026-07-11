import { afterEach, describe, expect, it, vi } from "vitest";

type OrderRow = {
  id: string;
  accountId: string;
  market: string;
  symbol: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  quantity: number;
  limitPrice: number | null;
  status: string;
  createdAt: string;
};

type AccountRow = { id: string; userId: string };
type Quote = { price: number; bid?: number; ask?: number };
type FillResult = { kind: "filled"; order: { id: string } } | { kind: "skipped"; reason: string };

type LoadOptions = {
  pendingOrders?: OrderRow[];
  accountRows?: AccountRow[];
  quoteBySymbolKey?: Record<string, Quote>;
  quoteErrorsBySymbolKey?: Record<string, Error & { code?: string }>;
  fillPendingOrderResults?: Array<FillResult | Error>;
  cancelResult?: { kind: "cancelled" } | { kind: "skipped"; reason: string };
  missingMarkets?: string[];
};

const loadModule = async (options: LoadOptions = {}) => {
  vi.resetModules();

  const tables = {
    orders: { __name: "orders" },
    accounts: { __name: "accounts", id: "accounts.id", userId: "accounts.userId" },
  };

  const fillQueue = [...(options.fillPendingOrderResults ?? [])];
  const fillPendingOrder = vi.fn(async () => {
    const next = fillQueue.shift();
    if (next instanceof Error) throw next;
    return next ?? { kind: "filled", order: { id: "ord_filled" } };
  });
  const cancelPendingOrder = vi.fn(async () => options.cancelResult ?? { kind: "cancelled" });
  const stop = vi.fn();
  const startPeriodicWorker = vi.fn(({ onResult }: { onResult: (result: { filled: number; cancelled: number }) => void }) => {
    onResult({ filled: 0, cancelled: 0 });
    onResult({ filled: 2, cancelled: 1 });
    return stop;
  });
  const logInfo = vi.spyOn(console, "log").mockImplementation(() => {});
  const logWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

  const makeQuery = (table: { __name: string }) => ({
    where: () => ({
      all: async () => {
        if (table === tables.orders) return options.pendingOrders ?? [];
        if (table === tables.accounts) return options.accountRows ?? [];
        return [];
      },
      orderBy: () => ({
        all: async () => {
          if (table === tables.orders) return options.pendingOrders ?? [];
          return [];
        },
      }),
    }),
    orderBy: () => ({
      all: async () => {
        if (table === tables.orders) return options.pendingOrders ?? [];
        return [];
      },
    }),
  });

  vi.doMock("../src/db/client.js", () => ({
    db: {
      select: () => ({
        from: (table: { __name: string }) => makeQuery(table),
      }),
    },
  }));
  vi.doMock("../src/db/schema.js", () => ({ orders: tables.orders, accounts: tables.accounts }));
  vi.doMock("../src/services/order-placement.js", () => ({ createOrderPlacementService: () => ({ fillPendingOrder }) }));
  vi.doMock("../src/services/order-cancellation.js", () => ({ cancelPendingOrder }));
  vi.doMock("../src/workers/periodic-worker.js", () => ({ startPeriodicWorker }));
  vi.doMock("../src/utils.js", () => ({ nowIso: () => "2026-03-07T00:00:00.000Z" }));

  const mod = await import("../src/workers/reconciler.js");
  const registry = {
    get: vi.fn((market: string) => {
      if (options.missingMarkets?.includes(market)) return undefined;
      return {
        getQuote: vi.fn(async (symbol: string) => {
          const key = `${market}:${symbol}`;
          const error = options.quoteErrorsBySymbolKey?.[key];
          if (error) throw error;
          const quote = options.quoteBySymbolKey?.[key];
          if (!quote) throw new Error(`missing quote for ${key}`);
          return quote;
        }),
      };
    }),
  };

  return { ...mod, registry, fillPendingOrder, cancelPendingOrder, startPeriodicWorker, stop, logInfo, logWarn };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconciler", () => {
  it("auto-cancels expired symbols and skips non-limit or non-crossing orders without double-processing", async () => {
    const mod = await loadModule({
      pendingOrders: [
        {
          id: "ord_expired",
          accountId: "acct_1",
          market: "perp",
          symbol: "EXPIRED",
          side: "buy",
          type: "limit",
          quantity: 1,
          limitPrice: 100,
          status: "pending",
          createdAt: "2026-03-07T00:00:00.000Z",
        },
        {
          id: "ord_market",
          accountId: "acct_2",
          market: "spot",
          symbol: "YES",
          side: "buy",
          type: "market",
          quantity: 1,
          limitPrice: null,
          status: "pending",
          createdAt: "2026-03-07T00:01:00.000Z",
        },
        {
          id: "ord_resting",
          accountId: "acct_2",
          market: "spot",
          symbol: "REST",
          side: "sell",
          type: "limit",
          quantity: 1,
          limitPrice: 15,
          status: "pending",
          createdAt: "2026-03-07T00:02:00.000Z",
        },
      ],
      accountRows: [{ id: "acct_1", userId: "usr_1" }],
      quoteBySymbolKey: { "spot:REST": { price: 10, bid: 10, ask: 11 } },
      quoteErrorsBySymbolKey: {
        "perp:EXPIRED": Object.assign(new Error("expired upstream (404)"), { code: "SYMBOL_NOT_FOUND" }),
      },
    });

    await expect(mod.reconcilePendingOrders(mod.registry as never)).resolves.toEqual({
      processed: 3,
      filled: 0,
      cancelled: 1,
      skipped: 2,
      filledOrderIds: [],
      cancelledOrderIds: ["ord_expired"],
    });
    expect(mod.cancelPendingOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        order: expect.objectContaining({ id: "ord_expired" }),
        reasoning: "Auto-cancelled: symbol no longer available",
        cancelledAt: "2026-03-07T00:00:00.000Z",
        userId: "usr_1",
      }),
    );
    expect(mod.fillPendingOrder).not.toHaveBeenCalled();
    expect(mod.logWarn).toHaveBeenCalledWith("[reconciler] auto-cancelled 1 orders for expired contract perp:EXPIRED");
  });

  it("fills crossing orders and counts downstream fill failures as skips", async () => {
    const mod = await loadModule({
      pendingOrders: [
        {
          id: "ord_fill",
          accountId: "acct_1",
          market: "spot",
          symbol: "YES",
          side: "buy",
          type: "limit",
          quantity: 1,
          limitPrice: 12,
          status: "pending",
          createdAt: "2026-03-07T00:00:00.000Z",
        },
        {
          id: "ord_fail",
          accountId: "acct_1",
          market: "spot",
          symbol: "NO",
          side: "sell",
          type: "limit",
          quantity: 1,
          limitPrice: 15,
          status: "pending",
          createdAt: "2026-03-07T00:01:00.000Z",
        },
      ],
      quoteBySymbolKey: {
        "spot:YES": { price: 10, ask: 10, bid: 9 },
        "spot:NO": { price: 20, ask: 21, bid: 20 },
      },
      fillPendingOrderResults: [{ kind: "filled", order: { id: "ord_fill" } }, new Error("db race")],
    });

    await expect(mod.reconcilePendingOrders(mod.registry as never)).resolves.toEqual({
      processed: 2,
      filled: 1,
      cancelled: 0,
      skipped: 1,
      filledOrderIds: ["ord_fill"],
      cancelledOrderIds: [],
    });
    expect(mod.fillPendingOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ pendingOrder: expect.objectContaining({ id: "ord_fill" }), executionPrice: 10, filledAt: "2026-03-07T00:00:00.000Z" }),
    );
    expect(mod.fillPendingOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pendingOrder: expect.objectContaining({ id: "ord_fail" }), executionPrice: 20, filledAt: "2026-03-07T00:00:00.000Z" }),
    );
  });

  it("wires the periodic worker and logs only when fills or cancellations occurred", async () => {
    const mod = await loadModule({});

    expect(mod.startReconciler(mod.registry as never)).toBe(mod.stop);
    expect(mod.startPeriodicWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "reconciler",
        defaultIntervalMs: 1_000,
        envVar: "RECONCILE_INTERVAL_MS",
        run: expect.any(Function),
        onResult: expect.any(Function),
      }),
    );
    expect(mod.logInfo).toHaveBeenCalledTimes(2);
    expect(mod.logInfo).toHaveBeenCalledWith("[reconciler] filled 2 pending orders");
    expect(mod.logInfo).toHaveBeenCalledWith("[reconciler] auto-cancelled 1 pending orders");

    const run = mod.startPeriodicWorker.mock.calls[0]?.[0].run as (() => Promise<unknown>) | undefined;
    await expect(run?.()).resolves.toEqual({
      processed: 0,
      filled: 0,
      cancelled: 0,
      skipped: 0,
      filledOrderIds: [],
      cancelledOrderIds: [],
    });
  });
});
