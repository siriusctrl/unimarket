import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MarketRegistry, type MarketAdapter } from "@unimarket/markets";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type DbModule = Awaited<typeof import("../src/db/client.js")>;
type SchemaModule = Awaited<typeof import("../src/db/schema.js")>;
type SettlerModule = Awaited<typeof import("../src/settler.js")>;
type EventsModule = Awaited<typeof import("../src/events.js")>;

const dbFilePath = join(tmpdir(), `unimarket-settler-test-${randomUUID()}.sqlite`);
process.env.DB_URL = `file:${dbFilePath}`;

let db: DbModule["db"];
let sqlite: DbModule["sqlite"];
let tables: SchemaModule;
let settlePendingPositions: SettlerModule["settlePendingPositions"];
let startSettler: SettlerModule["startSettler"];
let eventBus: EventsModule["eventBus"];

const noopSearch = async () => [];
const noopQuote = async (symbol: string) => ({ symbol, price: 0.5, bid: 0.49, ask: 0.51, timestamp: new Date().toISOString() });

const buildAdapter = (options: {
  marketId: string;
  capabilities: ReadonlyArray<"search" | "quote" | "orderbook" | "resolve">;
  resolve?: (symbol: string) => Promise<{ symbol: string; resolved: boolean; outcome: string | null; settlementPrice: number | null; timestamp: string } | null>;
}): MarketAdapter => ({
  marketId: options.marketId,
  displayName: options.marketId,
  description: `${options.marketId} adapter`,
  symbolFormat: "mock",
  priceRange: [0, 1],
  capabilities: options.capabilities,
  search: noopSearch,
  getQuote: noopQuote,
  resolve: options.resolve,
});

const insertUserAndAccount = async (params: { userId: string; accountId: string; balance: number }) => {
  const now = new Date().toISOString();
  await db.insert(tables.users).values({ id: params.userId, name: params.userId, createdAt: now }).run();
  await db
    .insert(tables.accounts)
    .values({
      id: params.accountId,
      userId: params.userId,
      balance: params.balance,
      name: "default",
      reasoning: "test account",
      createdAt: now,
    })
    .run();
};

const insertPosition = async (params: {
  id: string;
  accountId: string;
  market: string;
  symbol: string;
  quantity: number;
  avgCost?: number;
}) => {
  await db
    .insert(tables.positions)
    .values({
      id: params.id,
      accountId: params.accountId,
      market: params.market,
      symbol: params.symbol,
      quantity: params.quantity,
      avgCost: params.avgCost ?? 0.4,
    })
    .run();
};

const resetDatabase = async (): Promise<void> => {
  await sqlite.execute("DELETE FROM trades");
  await sqlite.execute("DELETE FROM order_execution_params");
  await sqlite.execute("DELETE FROM perp_position_state");
  await sqlite.execute("DELETE FROM orders");
  await sqlite.execute("DELETE FROM positions");
  await sqlite.execute("DELETE FROM journal");
  await sqlite.execute("DELETE FROM symbol_metadata_cache");
  await sqlite.execute("DELETE FROM api_keys");
  await sqlite.execute("DELETE FROM accounts");
  await sqlite.execute("DELETE FROM users");
};

beforeAll(async () => {
  const [dbModule, schemaModule, settlerModule, eventsModule] = await Promise.all([
    import("../src/db/client.js"),
    import("../src/db/schema.js"),
    import("../src/settler.js"),
    import("../src/events.js"),
  ]);
  await dbModule.migrate();
  db = dbModule.db;
  sqlite = dbModule.sqlite;
  tables = schemaModule;
  settlePendingPositions = settlerModule.settlePendingPositions;
  startSettler = settlerModule.startSettler;
  eventBus = eventsModule.eventBus;
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  delete process.env.SETTLE_INTERVAL_MS;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(dbFilePath, { force: true });
  await rm(`${dbFilePath}-wal`, { force: true });
  await rm(`${dbFilePath}-shm`, { force: true });
});

describe("settler integration", () => {
  it("settles resolved positions, records trades, updates balance, and emits events", async () => {
    await insertUserAndAccount({ userId: "u1", accountId: "a1", balance: 100 });
    await insertPosition({ id: "p1", accountId: "a1", market: "resolve-ok", symbol: "YES", quantity: 10 });

    const registry = new MarketRegistry();
    registry.register(
      buildAdapter({
        marketId: "resolve-ok",
        capabilities: ["quote", "resolve"],
        resolve: async (symbol) => ({
          symbol,
          resolved: true,
          outcome: "yes",
          settlementPrice: 0.8,
          timestamp: new Date().toISOString(),
        }),
      }),
    );

    const events: EventsModule["EmittedTradingEvent"][] = [];
    const unsubscribe = eventBus.subscribe("u1", (event) => events.push(event));

    const result = await settlePendingPositions(registry);

    unsubscribe();

    expect(result).toEqual({ settled: 1, skipped: 0 });

    const account = await db.select().from(tables.accounts).where(eq(tables.accounts.id, "a1")).get();
    expect(account?.balance).toBeCloseTo(108, 6);

    const openPositions = await db.select().from(tables.positions).where(eq(tables.positions.accountId, "a1")).all();
    expect(openPositions).toHaveLength(0);

    const trades = await db.select().from(tables.trades).where(eq(tables.trades.accountId, "a1")).all();
    expect(trades).toHaveLength(1);
    expect(trades[0]?.side).toBe("sell");
    expect(trades[0]?.quantity).toBe(10);
    expect(trades[0]?.price).toBeCloseTo(0.8, 6);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "position.settled",
      userId: "u1",
      accountId: "a1",
      data: {
        market: "resolve-ok",
        symbol: "YES",
        quantity: 10,
        settlementPrice: 0.8,
        proceeds: 8,
      },
    });
  });

  it("skips positions when adapter is missing, lacks resolve, throws, unresolved, missing price, or account is absent", async () => {
    await insertUserAndAccount({ userId: "u2", accountId: "a2", balance: 50 });
    await insertPosition({ id: "pmissing", accountId: "a2", market: "missing", symbol: "M1", quantity: 1 });
    await insertPosition({ id: "pnocap", accountId: "a2", market: "no-resolve", symbol: "M2", quantity: 1 });
    await insertPosition({ id: "pthrow", accountId: "a2", market: "resolve-throws", symbol: "M3", quantity: 1 });
    await insertPosition({ id: "punresolved", accountId: "a2", market: "resolve-unresolved", symbol: "M4", quantity: 1 });
    await insertPosition({ id: "pnullprice", accountId: "a2", market: "resolve-null", symbol: "M5", quantity: 1 });
    await insertPosition({ id: "pnoaccount", accountId: "missing-account", market: "resolve-ok", symbol: "M6", quantity: 1 });

    const registry = new MarketRegistry();
    registry.register(buildAdapter({ marketId: "no-resolve", capabilities: ["quote"] }));
    registry.register(
      buildAdapter({
        marketId: "resolve-throws",
        capabilities: ["resolve"],
        resolve: async () => {
          throw new Error("boom");
        },
      }),
    );
    registry.register(
      buildAdapter({
        marketId: "resolve-unresolved",
        capabilities: ["resolve"],
        resolve: async (symbol) => ({
          symbol,
          resolved: false,
          outcome: null,
          settlementPrice: null,
          timestamp: new Date().toISOString(),
        }),
      }),
    );
    registry.register(
      buildAdapter({
        marketId: "resolve-null",
        capabilities: ["resolve"],
        resolve: async (symbol) => ({
          symbol,
          resolved: true,
          outcome: "yes",
          settlementPrice: null,
          timestamp: new Date().toISOString(),
        }),
      }),
    );
    registry.register(
      buildAdapter({
        marketId: "resolve-ok",
        capabilities: ["resolve"],
        resolve: async (symbol) => ({
          symbol,
          resolved: true,
          outcome: "yes",
          settlementPrice: 0.7,
          timestamp: new Date().toISOString(),
        }),
      }),
    );

    const result = await settlePendingPositions(registry);
    expect(result).toEqual({ settled: 0, skipped: 6 });

    const trades = await db.select().from(tables.trades).all();
    expect(trades).toHaveLength(0);
  });

  it("startSettler honors interval and can be stopped", async () => {
    vi.useFakeTimers();
    process.env.SETTLE_INTERVAL_MS = "10";

    await insertUserAndAccount({ userId: "u3", accountId: "a3", balance: 10 });
    await insertPosition({ id: "p7", accountId: "a3", market: "resolve-ok", symbol: "M7", quantity: 2 });

    const registry = new MarketRegistry();
    registry.register(
      buildAdapter({
        marketId: "resolve-ok",
        capabilities: ["resolve"],
        resolve: async (symbol) => ({
          symbol,
          resolved: true,
          outcome: "yes",
          settlementPrice: 0.5,
          timestamp: new Date().toISOString(),
        }),
      }),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const stop = startSettler(registry);
    await vi.advanceTimersByTimeAsync(30);
    stop();

    expect(logSpy).toHaveBeenCalledWith("[settler] started (interval: 10ms)");
    expect(logSpy).toHaveBeenCalledWith("[settler] settled 1 positions");
    expect(logSpy).toHaveBeenCalledWith("[settler] stopped");
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
