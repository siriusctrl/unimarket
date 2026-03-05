import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MarketRegistry, type MarketAdapter } from "@unimarket/markets";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type DbModule = Awaited<typeof import("../src/db/client.js")>;
type SchemaModule = Awaited<typeof import("../src/db/schema.js")>;
type LiquidatorModule = Awaited<typeof import("../src/liquidator.js")>;

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
    import("../src/liquidator.js"),
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
    expect(account?.balance).toBeCloseTo(989, 6);

    const orderRows = await db.select().from(tables.orders).where(eq(tables.orders.accountId, "a_liq")).all();
    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]?.status).toBe("filled");
    expect(orderRows[0]?.reasoning).toContain("Auto-liquidation");

    const tradeRows = await db.select().from(tables.trades).where(eq(tables.trades.accountId, "a_liq")).all();
    expect(tradeRows).toHaveLength(1);
    expect(tradeRows[0]?.side).toBe("sell");
    expect(tradeRows[0]?.quantity).toBe(2);
    expect(tradeRows[0]?.price).toBe(94.5);
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
