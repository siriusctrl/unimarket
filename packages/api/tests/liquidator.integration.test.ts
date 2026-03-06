import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MarketRegistry, type MarketAdapter } from "@unimarket/markets";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type DbModule = Awaited<typeof import("../src/db/client.js")>;
type SchemaModule = Awaited<typeof import("../src/db/schema.js")>;
type LiquidatorModule = Awaited<typeof import("../src/workers/liquidator.js")>;

const dbFilePath = join(tmpdir(), `unimarket-liquidator-test-${randomUUID()}.sqlite`);
process.env.DB_URL = `file:${dbFilePath}`;

let db: DbModule["db"];
let sqlite: DbModule["sqlite"];
let tables: SchemaModule;
let liquidateUnsafePerpPositions: LiquidatorModule["liquidateUnsafePerpPositions"];
let startLiquidator: LiquidatorModule["startLiquidator"];

const buildFundingAdapter = (quotePrice: number): MarketAdapter => ({
  marketId: "hyperliquid",
  displayName: "Hyperliquid",
  description: "mock funding market",
  symbolFormat: "ticker",
  priceRange: null,
  capabilities: ["quote", "funding", "search"],
  search: async () => [],
  getQuote: async (symbol) => ({
    symbol,
    price: quotePrice,
    bid: quotePrice - 1,
    ask: quotePrice + 1,
    timestamp: new Date().toISOString(),
  }),
  getFundingRate: async (symbol) => ({
    symbol,
    rate: 0.0001,
    nextFundingAt: new Date(Date.now() + 60_000).toISOString(),
    timestamp: new Date().toISOString(),
  }),
});

const resetDatabase = async (): Promise<void> => {
  await sqlite.execute("DELETE FROM trades");
  await sqlite.execute("DELETE FROM liquidations");
  await sqlite.execute("DELETE FROM order_execution_params");
  await sqlite.execute("DELETE FROM perp_position_state");
  await sqlite.execute("DELETE FROM orders");
  await sqlite.execute("DELETE FROM positions");
  await sqlite.execute("DELETE FROM funding_payments");
  await sqlite.execute("DELETE FROM journal");
  await sqlite.execute("DELETE FROM symbol_metadata_cache");
  await sqlite.execute("DELETE FROM api_keys");
  await sqlite.execute("DELETE FROM accounts");
  await sqlite.execute("DELETE FROM users");
};

beforeAll(async () => {
  const [dbModule, schemaModule, liquidatorModule] = await Promise.all([
    import("../src/db/client.js"),
    import("../src/db/schema.js"),
    import("../src/workers/liquidator.js"),
  ]);
  await dbModule.migrate();
  db = dbModule.db;
  sqlite = dbModule.sqlite;
  tables = schemaModule;
  liquidateUnsafePerpPositions = liquidatorModule.liquidateUnsafePerpPositions;
  startLiquidator = liquidatorModule.startLiquidator;
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  delete process.env.LIQUIDATION_INTERVAL_MS;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(dbFilePath, { force: true });
  await rm(`${dbFilePath}-wal`, { force: true });
  await rm(`${dbFilePath}-shm`, { force: true });
});

describe("liquidator integration", () => {
  it("liquidates unsafe perp positions and writes audit orders/trades", async () => {
    const now = new Date().toISOString();
    await db.insert(tables.users).values({ id: "u_liq", name: "liquidation-user", createdAt: now }).run();
    await db
      .insert(tables.accounts)
      .values({
        id: "a_liq",
        userId: "u_liq",
        balance: 980,
        name: "default",
        reasoning: "seed",
        createdAt: now,
      })
      .run();
    await db
      .insert(tables.positions)
      .values({
        id: "p_liq",
        accountId: "a_liq",
        market: "hyperliquid",
        symbol: "BTC",
        quantity: 2,
        avgCost: 100,
      })
      .run();
    await db
      .insert(tables.perpPositionState)
      .values({
        positionId: "p_liq",
        accountId: "a_liq",
        market: "hyperliquid",
        symbol: "BTC",
        leverage: 10,
        margin: 20,
        maintenanceMarginRatio: 0.05,
        liquidationPrice: 94.736842,
        updatedAt: now,
      })
      .run();

    const registry = new MarketRegistry();
    registry.register(buildFundingAdapter(94.5));

    const result = await liquidateUnsafePerpPositions(registry);
    expect(result).toEqual({ checked: 1, liquidated: 1, skipped: 0 });

    const position = await db.select().from(tables.positions).where(eq(tables.positions.id, "p_liq")).get();
    expect(position).toBeUndefined();
    const state = await db.select().from(tables.perpPositionState).where(eq(tables.perpPositionState.positionId, "p_liq")).get();
    expect(state).toBeUndefined();

    const account = await db.select().from(tables.accounts).where(eq(tables.accounts.id, "a_liq")).get();
    expect(account?.balance).toBeCloseTo(987, 6);

    const orderRows = await db.select().from(tables.orders).where(eq(tables.orders.accountId, "a_liq")).all();
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]?.status).toBe("filled");
    expect(orderRows[0]?.reasoning).toContain("Auto-liquidation");
    expect(orderRows[0]?.filledPrice).toBe(93.5);

    const tradeRows = await db.select().from(tables.trades).where(eq(tables.trades.accountId, "a_liq")).all();
    expect(tradeRows).toHaveLength(1);
    expect(tradeRows[0]?.side).toBe("sell");
    expect(tradeRows[0]?.quantity).toBe(2);
    expect(tradeRows[0]?.price).toBe(93.5);

    const liquidationRows = await db.select().from(tables.liquidations).where(eq(tables.liquidations.accountId, "a_liq")).all();
    expect(liquidationRows).toHaveLength(1);
    expect(liquidationRows[0]).toMatchObject({
      triggerPrice: 94.5,
      executionPrice: 93.5,
      triggerPositionEquity: 9,
      maintenanceMargin: 9.45,
      grossPayout: 7,
      feeCharged: 0,
      netPayout: 7,
    });
  });

  it("keeps safe perp positions untouched", async () => {
    const now = new Date().toISOString();
    await db.insert(tables.users).values({ id: "u_safe", name: "safe-user", createdAt: now }).run();
    await db
      .insert(tables.accounts)
      .values({
        id: "a_safe",
        userId: "u_safe",
        balance: 980,
        name: "default",
        reasoning: "seed",
        createdAt: now,
      })
      .run();
    await db
      .insert(tables.positions)
      .values({
        id: "p_safe",
        accountId: "a_safe",
        market: "hyperliquid",
        symbol: "BTC",
        quantity: 2,
        avgCost: 100,
      })
      .run();
    await db
      .insert(tables.perpPositionState)
      .values({
        positionId: "p_safe",
        accountId: "a_safe",
        market: "hyperliquid",
        symbol: "BTC",
        leverage: 10,
        margin: 20,
        maintenanceMarginRatio: 0.05,
        liquidationPrice: 94.736842,
        updatedAt: now,
      })
      .run();

    const registry = new MarketRegistry();
    registry.register(buildFundingAdapter(110));

    const result = await liquidateUnsafePerpPositions(registry);
    expect(result).toEqual({ checked: 1, liquidated: 0, skipped: 0 });

    const position = await db.select().from(tables.positions).where(eq(tables.positions.id, "p_safe")).get();
    expect(position).toBeTruthy();
  });

  it("auto-cancels pending reduceOnly orders on the liquidated symbol", async () => {
    const now = new Date().toISOString();
    await db.insert(tables.users).values({ id: "u_reduce", name: "reduce-only-user", createdAt: now }).run();
    await db
      .insert(tables.accounts)
      .values({
        id: "a_reduce",
        userId: "u_reduce",
        balance: 980,
        name: "default",
        reasoning: "seed",
        createdAt: now,
      })
      .run();
    await db
      .insert(tables.positions)
      .values({
        id: "p_reduce",
        accountId: "a_reduce",
        market: "hyperliquid",
        symbol: "BTC",
        quantity: 2,
        avgCost: 100,
      })
      .run();
    await db
      .insert(tables.perpPositionState)
      .values({
        positionId: "p_reduce",
        accountId: "a_reduce",
        market: "hyperliquid",
        symbol: "BTC",
        leverage: 10,
        margin: 20,
        maintenanceMarginRatio: 0.05,
        liquidationPrice: 94.736842,
        updatedAt: now,
      })
      .run();
    await db
      .insert(tables.orders)
      .values([
        {
          id: "ord_reduce_only",
          accountId: "a_reduce",
          market: "hyperliquid",
          symbol: "BTC",
          side: "sell",
          type: "limit",
          quantity: 1,
          limitPrice: 105,
          status: "pending",
          filledPrice: null,
          reasoning: "take profit reduce-only",
          cancelReasoning: null,
          cancelledAt: null,
          filledAt: null,
          createdAt: now,
        },
        {
          id: "ord_reentry",
          accountId: "a_reduce",
          market: "hyperliquid",
          symbol: "BTC",
          side: "buy",
          type: "limit",
          quantity: 1,
          limitPrice: 90,
          status: "pending",
          filledPrice: null,
          reasoning: "re-enter if flushed lower",
          cancelReasoning: null,
          cancelledAt: null,
          filledAt: null,
          createdAt: now,
        },
      ])
      .run();
    await db
      .insert(tables.orderExecutionParams)
      .values([
        { orderId: "ord_reduce_only", leverage: 10, reduceOnly: true, takerFeeRate: 0 },
        { orderId: "ord_reentry", leverage: 10, reduceOnly: false, takerFeeRate: 0 },
      ])
      .run();

    const registry = new MarketRegistry();
    registry.register(buildFundingAdapter(94.5));

    const result = await liquidateUnsafePerpPositions(registry);
    expect(result).toEqual({ checked: 1, liquidated: 1, skipped: 0 });

    const cancelledOrder = await db.select().from(tables.orders).where(eq(tables.orders.id, "ord_reduce_only")).get();
    expect(cancelledOrder).toMatchObject({
      status: "cancelled",
      cancelReasoning: "Auto-cancelled: linked position was liquidated",
    });

    const reentryOrder = await db.select().from(tables.orders).where(eq(tables.orders.id, "ord_reentry")).get();
    expect(reentryOrder?.status).toBe("pending");

    const liquidationRow = await db.select().from(tables.liquidations).where(eq(tables.liquidations.accountId, "a_reduce")).get();
    expect(liquidationRow?.cancelledReduceOnlyOrderIds).toBe(JSON.stringify(["ord_reduce_only"]));
  });

  it("startLiquidator honors interval and can be stopped", async () => {
    vi.useFakeTimers();
    process.env.LIQUIDATION_INTERVAL_MS = "10";

    const registry = new MarketRegistry();
    registry.register(buildFundingAdapter(110));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const stop = startLiquidator(registry);
    await vi.advanceTimersByTimeAsync(30);
    stop();

    expect(logSpy).toHaveBeenCalledWith("[liquidator] started (interval: 10ms)");
    expect(logSpy).toHaveBeenCalledWith("[liquidator] stopped");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
