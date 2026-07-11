import { afterEach, describe, expect, it, vi } from "vitest";

type AccountRow = { id: string; userId: string; balance: number };
type PositionRow = { id: string; accountId: string; market: string; symbol: string; quantity: number; avgCost: number };
type OrderRow = { id: string; accountId: string; status: string; createdAt: string };
type PerpStateRow = {
  positionId: string;
  accountId: string;
  market: string;
  symbol: string;
  leverage: number;
  margin: number;
  maintenanceMarginRatio: number;
  liquidationPrice: number | null;
};

type LoadOptions = {
  positionRows?: PositionRow[];
  openOrders?: OrderRow[];
  recentOrders?: OrderRow[];
  perpStateRows?: PerpStateRow[];
  fundingRows?: Array<{ accountId: string; market: string; symbol: string; total: number }>;
  resolvedSymbolsByMarket?: Record<string, { names?: Record<string, string>; outcomes?: Record<string, string> }>;
};

const loadModule = async (options: LoadOptions = {}) => {
  vi.resetModules();

  const tables = {
    positions: { __name: "positions" },
    orders: { __name: "orders" },
    perpPositionState: { __name: "perpPositionState" },
    fundingPayments: { __name: "fundingPayments" },
  };

  const makeQuery = (table: { __name: string }) => ({
    where: () => ({
      orderBy: () => ({
        all: async () => {
          if (table === tables.orders) return options.openOrders ?? [];
          return [];
        },
        limit: () => ({ all: async () => options.recentOrders ?? [] }),
      }),
      groupBy: () => ({ all: async () => options.fundingRows ?? [] }),
      all: async () => {
        if (table === tables.positions) return options.positionRows ?? [];
        if (table === tables.perpPositionState) return options.perpStateRows ?? [];
        if (table === tables.fundingPayments) return options.fundingRows ?? [];
        return [];
      },
      limit: () => ({ all: async () => options.recentOrders ?? [] }),
    }),
    orderBy: () => ({ limit: () => ({ all: async () => options.recentOrders ?? [] }) }),
    all: async () => {
      if (table === tables.positions) return options.positionRows ?? [];
      if (table === tables.perpPositionState) return options.perpStateRows ?? [];
      if (table === tables.fundingPayments) return options.fundingRows ?? [];
      return [];
    },
  });

  vi.doMock("../src/db/client.js", () => ({
    db: {
      select: () => ({
        from: (table: { __name: string }) => makeQuery(table),
      }),
    },
  }));
  vi.doMock("../src/db/schema.js", () => ({
    accounts: { id: "accounts.id" },
    positions: tables.positions,
    orders: tables.orders,
    perpPositionState: tables.perpPositionState,
    fundingPayments: tables.fundingPayments,
  }));
  vi.doMock("../src/symbol-metadata.js", () => ({
    resolveSymbolsByMarketWithCache: vi.fn(async () => new Map(
      Object.entries(options.resolvedSymbolsByMarket ?? {}).map(([market, resolution]) => [
        market,
        {
          names: new Map(Object.entries(resolution.names ?? {})),
          outcomes: new Map(Object.entries(resolution.outcomes ?? {})),
        },
      ]),
    )),
    formatResolvedSymbolLabel: (
      resolution: { names: Map<string, string>; outcomes: Map<string, string> } | null | undefined,
      symbol: string,
    ) => {
      if (!resolution) return null;
      const name = resolution.names.get(symbol);
      const outcome = resolution.outcomes.get(symbol);
      return name ? (outcome ? `${name} — ${outcome}` : name) : null;
    },
  }));

  const mod = await import("../src/services/portfolio-read.js");
  return mod;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("portfolio-read", () => {
  it("computes spot and perp position metrics, funding totals, and recent orders", async () => {
    const { buildAccountPortfolioModel } = await loadModule({
      positionRows: [
        { id: "pos_spot", accountId: "acct_1", market: "polymarket", symbol: "YES", quantity: 3, avgCost: 10 },
        { id: "pos_perp", accountId: "acct_1", market: "hyperliquid", symbol: "BTC", quantity: 2, avgCost: 100 },
      ],
      openOrders: [{ id: "ord_open", accountId: "acct_1", status: "pending", createdAt: "2026-03-07T00:00:00.000Z" }],
      recentOrders: [{ id: "ord_recent", accountId: "acct_1", status: "filled", createdAt: "2026-03-07T01:00:00.000Z" }],
      perpStateRows: [
        {
          positionId: "pos_perp",
          accountId: "acct_1",
          market: "hyperliquid",
          symbol: "BTC",
          leverage: 5,
          margin: 20,
          maintenanceMarginRatio: 0.1,
          liquidationPrice: 80,
        },
      ],
      fundingRows: [
        { accountId: "acct_1", market: "hyperliquid", symbol: "BTC", total: -1.2345678 },
        { accountId: "acct_1", market: "polymarket", symbol: "YES", total: 2.5 },
      ],
    });

    const registry = {
      get: vi.fn((market: string) => {
        if (market === "polymarket") {
          return {
            getQuote: vi.fn().mockResolvedValue({ price: 12, timestamp: "2026-03-07T02:00:00.000Z" }),
          };
        }
        if (market === "hyperliquid") {
          return {
            getFundingRate: vi.fn(),
            getQuote: vi.fn().mockResolvedValue({ price: 90, timestamp: "2026-03-07T02:00:00.000Z" }),
          };
        }
        return undefined;
      }),
    };

    const result = await buildAccountPortfolioModel({
      account: { id: "acct_1", userId: "usr_1", balance: 50 },
      registry: registry as never,
      includeRecentOrders: true,
    });

    expect(result.openOrders).toEqual([{ id: "ord_open", accountId: "acct_1", status: "pending", createdAt: "2026-03-07T00:00:00.000Z" }]);
    expect(result.recentOrders).toEqual([{ id: "ord_recent", accountId: "acct_1", status: "filled", createdAt: "2026-03-07T01:00:00.000Z" }]);
    expect(result.totalValue).toBe(86);
    expect(result.totalPnl).toBe(-14);
    expect(result.totalFunding).toBe(1.265432);
    expect(result.valuation).toEqual({
      status: "complete",
      issueCount: 0,
      issues: [],
      pricedPositions: 2,
      unpricedPositions: 0,
      knownMarketValue: 36,
      knownUnrealizedPnl: -14,
    });
    expect(result.positions).toEqual([
      expect.objectContaining({
        market: "polymarket",
        symbol: "YES",
        currentPrice: 12,
        unrealizedPnl: 6,
        marketValue: 36,
        accumulatedFunding: 2.5,
        notional: null,
        positionEquity: null,
        leverage: null,
        margin: null,
        maintenanceMargin: null,
        liquidationPrice: null,
      }),
      expect.objectContaining({
        market: "hyperliquid",
        symbol: "BTC",
        currentPrice: 90,
        unrealizedPnl: -20,
        marketValue: 0,
        accumulatedFunding: -1.234568,
        notional: 180,
        positionEquity: 0,
        leverage: 5,
        margin: 20,
        maintenanceMargin: 18,
        liquidationPrice: 80,
      }),
    ]);
  });

  it("supports strict failures and explicit partial valuation for missing adapters and quote failures", async () => {
    const options: LoadOptions = {
      positionRows: [
        { id: "pos_missing", accountId: "acct_1", market: "missing", symbol: "ABC", quantity: 1, avgCost: 10 },
        { id: "pos_quote", accountId: "acct_1", market: "quoted", symbol: "XYZ", quantity: 2, avgCost: 5 },
      ],
    };

    const strict = await loadModule(options);
    const tolerant = await loadModule(options);
    const registry = {
      get: vi.fn((market: string) => {
        if (market === "quoted") {
          return {
            getQuote: vi.fn().mockRejectedValue(new Error("quote unavailable")),
          };
        }
        return undefined;
      }),
    };

    await expect(
      strict.buildAccountPortfolioModel({
        account: { id: "acct_1", userId: "usr_1", balance: 20 },
        registry: registry as never,
        valuationMode: "strict",
      }),
    ).rejects.toThrow("Market adapter not found for missing");

    await expect(
      tolerant.buildAccountPortfolioModel({
        account: { id: "acct_1", userId: "usr_1", balance: 20 },
        registry: registry as never,
        valuationMode: "partial",
      }),
    ).resolves.toMatchObject({
      totalValue: null,
      totalPnl: null,
      valuation: {
        status: "partial",
        issueCount: 2,
        pricedPositions: 0,
        unpricedPositions: 2,
        knownMarketValue: 0,
        knownUnrealizedPnl: 0,
      },
      positions: [
        expect.objectContaining({ market: "missing", symbol: "ABC", currentPrice: null, marketValue: null, unrealizedPnl: null }),
        expect.objectContaining({ market: "quoted", symbol: "XYZ", currentPrice: null, marketValue: null, unrealizedPnl: null }),
      ],
    });
  });

  it("presents portfolio positions and orders with resolved symbol metadata", async () => {
    const { presentAccountPortfolioModel } = await loadModule({
      resolvedSymbolsByMarket: {
        polymarket: {
          names: { "111": "Will rates fall?" },
          outcomes: { "111": "No" },
        },
      },
    });

    const result = await presentAccountPortfolioModel({
      portfolio: {
        accountId: "acct_1",
        balance: 100,
        positions: [
          {
            accountId: "acct_1",
            market: "polymarket",
            symbol: "111",
            quantity: 2,
            avgCost: 0.52,
            currentPrice: 0.55,
            quoteTimestamp: "2026-03-07T00:00:00.000Z",
            unrealizedPnl: 0.06,
            marketValue: 1.1,
            accumulatedFunding: 0,
            notional: null,
            positionEquity: null,
            leverage: null,
            margin: null,
            maintenanceMargin: null,
            liquidationPrice: null,
          },
        ],
        openOrders: [
          {
            id: "ord_1",
            accountId: "acct_1",
            market: "polymarket",
            symbol: "111",
            side: "buy",
            type: "limit",
            quantity: 1,
            limitPrice: 0.5,
            status: "pending",
            filledPrice: null,
            reasoning: "test",
            cancelReasoning: null,
            cancelledAt: null,
            filledAt: null,
            createdAt: "2026-03-07T00:00:00.000Z",
          },
        ],
        recentOrders: [],
        totalValue: 101.1,
        totalPnl: 0.06,
        totalFunding: 0,
        valuation: {
          status: "complete",
          issueCount: 0,
          issues: [],
          pricedPositions: 1,
          unpricedPositions: 0,
          knownMarketValue: 1.1,
          knownUnrealizedPnl: 0.06,
        },
      },
      registry: { get: vi.fn() } as never,
    });

    expect(result.positions[0]).toMatchObject({
      symbolName: "Will rates fall? — No",
      side: "No",
    });
    expect(result.openOrders[0]).toMatchObject({
      symbolName: "Will rates fall? — No",
      outcome: "No",
    });
  });

  it("groups multi-account portfolios and returns an empty map when no accounts exist", async () => {
    const { buildAccountPortfolioModelsByAccount } = await loadModule({
      positionRows: [
        { id: "pos_1", accountId: "acct_1", market: "spot", symbol: "YES", quantity: 1, avgCost: 10 },
        { id: "pos_2", accountId: "acct_2", market: "perp", symbol: "BTC", quantity: -2, avgCost: 100 },
      ],
      perpStateRows: [
        {
          positionId: "pos_2",
          accountId: "acct_2",
          market: "perp",
          symbol: "BTC",
          leverage: 4,
          margin: 30,
          maintenanceMarginRatio: 0.05,
          liquidationPrice: 130,
        },
      ],
      fundingRows: [{ accountId: "acct_2", market: "perp", symbol: "BTC", total: 3.25 }],
    });

    await expect(
      buildAccountPortfolioModelsByAccount({ accounts: [], registry: { get: vi.fn() } as never }),
    ).resolves.toEqual(new Map());

    const registry = {
      get: vi.fn((market: string) => {
        if (market === "spot") return { getQuote: vi.fn().mockResolvedValue({ price: 14 }) };
        if (market === "perp") return { getFundingRate: vi.fn(), getQuote: vi.fn().mockResolvedValue({ price: 80 }) };
        return undefined;
      }),
    };

    const result = await buildAccountPortfolioModelsByAccount({
      accounts: [
        { id: "acct_1", userId: "usr_1", balance: 5 },
        { id: "acct_2", userId: "usr_2", balance: 40 },
      ],
      registry: registry as never,
    });

    expect(result.get("acct_1")).toMatchObject({
      accountId: "acct_1",
      totalValue: 19,
      totalPnl: 4,
      totalFunding: 0,
      valuation: {
        status: "complete",
        issueCount: 0,
        pricedPositions: 1,
        unpricedPositions: 0,
        knownMarketValue: 14,
        knownUnrealizedPnl: 4,
      },
      positions: [expect.objectContaining({ symbol: "YES", marketValue: 14, unrealizedPnl: 4 })],
    });
    expect(result.get("acct_2")).toMatchObject({
      accountId: "acct_2",
      totalValue: 110,
      totalPnl: 40,
      totalFunding: 3.25,
      valuation: {
        status: "complete",
        issueCount: 0,
        pricedPositions: 1,
        unpricedPositions: 0,
        knownMarketValue: 70,
        knownUnrealizedPnl: 40,
      },
      positions: [
        expect.objectContaining({
          symbol: "BTC",
          marketValue: 70,
          unrealizedPnl: 40,
          notional: 160,
          positionEquity: 70,
          maintenanceMargin: 8,
          accumulatedFunding: 3.25,
        }),
      ],
    });
  });
});
