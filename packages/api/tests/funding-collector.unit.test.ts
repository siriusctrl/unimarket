import { afterEach, describe, expect, it, vi } from "vitest";

type PositionRow = {
  id: string;
  accountId: string;
  market: string;
  symbol: string;
  quantity: number;
};

type AccountRow = {
  id: string;
  userId: string;
  balance: number;
};

const loadModule = async (options?: {
  positions?: PositionRow[];
  latestPosition?: PositionRow | null;
  account?: AccountRow | null;
  insertedFundingRowsAffected?: number;
  accountUpdatedRowsAffected?: number;
  transactionError?: Error;
  nowIso?: string;
}) => {
  vi.resetModules();

  const schemaTables = {
    positions: { id: "positions.id" },
    accounts: { id: "accounts.id" },
    fundingPayments: { id: "fundingPayments.id" },
  };
  const insertedRows: unknown[] = [];
  const updatedRows: unknown[] = [];
  const emit = vi.fn();
  const startPeriodicWorker = vi.fn((_config) => () => undefined);

  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          get: async () => {
            if (table === schemaTables.positions) {
              if (options && "latestPosition" in options) {
                return options.latestPosition ?? null;
              }
              return options?.positions?.[0] ?? null;
            }
            if (table === schemaTables.accounts) {
              return options?.account ?? null;
            }
            return null;
          },
        }),
      }),
    }),
    insert: () => ({
      values: (row: unknown) => ({
        onConflictDoNothing: () => ({
          run: async () => {
            insertedRows.push(row);
            return { rowsAffected: options?.insertedFundingRowsAffected ?? 1 };
          },
        }),
      }),
    }),
    update: () => ({
      set: (row: unknown) => ({
        where: () => ({
          run: async () => {
            updatedRows.push(row);
            return { rowsAffected: options?.accountUpdatedRowsAffected ?? 1 };
          },
        }),
      }),
    }),
  };

  vi.doMock("../src/db/client.js", () => ({
    db: {
      select: () => ({
        from: (table: unknown) => ({
          all: async () => (table === schemaTables.positions ? (options?.positions ?? []) : []),
        }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        if (options?.transactionError) throw options.transactionError;
        return fn(tx);
      },
    },
  }));
  vi.doMock("../src/db/schema.js", () => schemaTables);
  vi.doMock("../src/platform/events.js", () => ({ eventBus: { emit } }));
  vi.doMock("../src/workers/periodic-worker.js", () => ({ startPeriodicWorker }));
  vi.doMock("../src/utils.js", () => ({ nowIso: () => options?.nowIso ?? "2026-03-07T00:00:00.000Z" }));

  const mod = await import("../src/workers/funding-collector.js");
  return { ...mod, emit, insertedRows, updatedRows, startPeriodicWorker };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("applyFundingPayments", () => {
  it("skips positions when adapters or upstream funding inputs are unavailable", async () => {
    const positions: PositionRow[] = [
      { id: "p0", accountId: "acct", market: "missing", symbol: "BTC", quantity: 1 },
      { id: "p1", accountId: "acct", market: "no-funding", symbol: "BTC", quantity: 1 },
      { id: "p2", accountId: "acct", market: "rate-error", symbol: "BTC", quantity: 1 },
      { id: "p3", accountId: "acct", market: "zero-rate", symbol: "BTC", quantity: 1 },
      { id: "p4", accountId: "acct", market: "quote-error", symbol: "BTC", quantity: 1 },
      { id: "p5", accountId: "acct", market: "zero-payment", symbol: "BTC", quantity: 0.000001 },
    ];
    const { applyFundingPayments, emit } = await loadModule({ positions });

    const registry = {
      get: vi.fn((market: string) => {
        if (market === "missing") return undefined;
        if (market === "no-funding") {
          return { capabilities: ["quote"], getQuote: vi.fn() };
        }
        if (market === "rate-error") {
          return {
            capabilities: ["funding", "quote"],
            getFundingRate: vi.fn().mockRejectedValue(new Error("rate down")),
            getQuote: vi.fn().mockResolvedValue({ price: 100 }),
          };
        }
        if (market === "zero-rate") {
          return {
            capabilities: ["funding", "quote"],
            getFundingRate: vi.fn().mockResolvedValue({ rate: 0, nextFundingAt: "2026-03-07T01:00:00.000Z" }),
            getQuote: vi.fn().mockResolvedValue({ price: 100 }),
          };
        }
        if (market === "quote-error") {
          return {
            capabilities: ["funding", "quote"],
            getFundingRate: vi.fn().mockResolvedValue({ rate: 0.01, nextFundingAt: "2026-03-07T01:00:00.000Z" }),
            getQuote: vi.fn().mockRejectedValue(new Error("quote down")),
          };
        }
        return {
          capabilities: ["funding", "quote"],
          getFundingRate: vi.fn().mockResolvedValue({ rate: 0.0000001, nextFundingAt: "2026-03-07T01:00:00.000Z" }),
          getQuote: vi.fn().mockResolvedValue({ price: 1 }),
        };
      }),
    };

    await expect(applyFundingPayments(registry as never)).resolves.toEqual({ applied: 0, skipped: 6 });
    expect(emit).not.toHaveBeenCalled();
  });

  it("applies funding, updates balances, and emits audit events", async () => {
    const positions: PositionRow[] = [{ id: "pos_1", accountId: "acct_1", market: "hyperliquid", symbol: "BTC", quantity: 2 }];
    const { applyFundingPayments, emit, insertedRows, updatedRows } = await loadModule({
      positions,
      account: { id: "acct_1", userId: "usr_1", balance: 50 },
      nowIso: "2026-03-07T02:00:00.000Z",
    });

    const registry = {
      get: vi.fn(() => ({
        capabilities: ["funding", "quote"],
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.01, nextFundingAt: "2026-03-07T03:00:00.000Z" }),
        getQuote: vi.fn().mockResolvedValue({ price: 100 }),
      })),
    };

    await expect(applyFundingPayments(registry as never)).resolves.toEqual({ applied: 1, skipped: 0 });
    expect(updatedRows).toEqual([{ balance: 48 }]);
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({
      id: "fnd_acct_1_hyperliquid_BTC_2026_03_07T03_00_00_000Z",
      payment: -2,
      fundingRate: 0.01,
      quantity: 2,
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "funding.applied",
        userId: "usr_1",
        accountId: "acct_1",
        data: expect.objectContaining({ payment: -2, fundingRate: 0.01, appliedAt: "2026-03-07T02:00:00.000Z" }),
      }),
    );
  });

  it("skips duplicate funding windows, missing rows, and failed account updates", async () => {
    const positions: PositionRow[] = [{ id: "pos_1", accountId: "acct_1", market: "hyperliquid", symbol: "BTC", quantity: 2 }];

    const duplicate = await loadModule({
      positions,
      account: { id: "acct_1", userId: "usr_1", balance: 50 },
      insertedFundingRowsAffected: 0,
    });
    const registry = {
      get: vi.fn(() => ({
        capabilities: ["funding", "quote"],
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.01, nextFundingAt: "2026-03-07T03:00:00.000Z" }),
        getQuote: vi.fn().mockResolvedValue({ price: 100 }),
      })),
    };
    await expect(duplicate.applyFundingPayments(registry as never)).resolves.toEqual({ applied: 0, skipped: 1 });
    expect(duplicate.emit).not.toHaveBeenCalled();

    const noPosition = await loadModule({ positions, latestPosition: null, account: { id: "acct_1", userId: "usr_1", balance: 50 } });
    await expect(noPosition.applyFundingPayments(registry as never)).resolves.toEqual({ applied: 0, skipped: 1 });

    const noAccount = await loadModule({ positions, account: null });
    await expect(noAccount.applyFundingPayments(registry as never)).resolves.toEqual({ applied: 0, skipped: 1 });

    const failedUpdate = await loadModule({
      positions,
      account: { id: "acct_1", userId: "usr_1", balance: 50 },
      accountUpdatedRowsAffected: 0,
    });
    await expect(failedUpdate.applyFundingPayments(registry as never)).resolves.toEqual({ applied: 0, skipped: 1 });
    expect(failedUpdate.emit).not.toHaveBeenCalled();
  });

  it("skips transaction-level failures instead of emitting partial results", async () => {
    const positions: PositionRow[] = [{ id: "pos_1", accountId: "acct_1", market: "hyperliquid", symbol: "BTC", quantity: 2 }];
    const { applyFundingPayments, emit } = await loadModule({
      positions,
      transactionError: new Error("db unavailable"),
    });

    const registry = {
      get: vi.fn(() => ({
        capabilities: ["funding", "quote"],
        getFundingRate: vi.fn().mockResolvedValue({ rate: 0.01, nextFundingAt: "2026-03-07T03:00:00.000Z" }),
        getQuote: vi.fn().mockResolvedValue({ price: 100 }),
      })),
    };

    await expect(applyFundingPayments(registry as never)).resolves.toEqual({ applied: 0, skipped: 1 });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("startFundingCollector", () => {
  it("wires the periodic worker and logs only applied funding batches", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { startFundingCollector, startPeriodicWorker } = await loadModule();
    const registry = { get: vi.fn() };

    const stop = startFundingCollector(registry as never);
    expect(startPeriodicWorker).toHaveBeenCalledTimes(1);

    const config = startPeriodicWorker.mock.calls[0]?.[0];
    expect(config).toMatchObject({
      name: "funding",
      envVar: "FUNDING_INTERVAL_MS",
      defaultIntervalMs: 3_600_000,
    });
    config?.onResult?.({ applied: 1, skipped: 2 });
    config?.onResult?.({ applied: 0, skipped: 3 });

    expect(logSpy).toHaveBeenCalledWith("[funding] applied 1 funding payments");
    expect(stop).toBeTypeOf("function");
  });
});
