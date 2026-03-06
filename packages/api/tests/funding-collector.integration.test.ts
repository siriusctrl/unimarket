import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MarketRegistry, type MarketAdapter } from "@unimarket/markets";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type DbModule = Awaited<typeof import("../src/db/client.js")>;
type SchemaModule = Awaited<typeof import("../src/db/schema.js")>;
type FundingCollectorModule = Awaited<typeof import("../src/workers/funding-collector.js")>;
type EventsModule = Awaited<typeof import("../src/platform/events.js")>;

const dbFilePath = join(tmpdir(), `unimarket-funding-test-${randomUUID()}.sqlite`);
process.env.DB_URL = `file:${dbFilePath}`;

let db: DbModule["db"];
let sqlite: DbModule["sqlite"];
let tables: SchemaModule;
let applyFundingPayments: FundingCollectorModule["applyFundingPayments"];
let eventBus: EventsModule["eventBus"];

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
      avgCost: params.avgCost ?? 100,
    })
    .run();
};

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

const buildFundingAdapter = (options: {
  marketId: string;
  getFundingRate: (symbol: string) => Promise<{ symbol: string; rate: number; nextFundingAt: string; timestamp: string }>;
  getQuote?: (symbol: string) => Promise<{ symbol: string; price: number; bid?: number; ask?: number; timestamp: string }>;
}): MarketAdapter => ({
  marketId: options.marketId,
  displayName: options.marketId,
  description: `${options.marketId} adapter`,
  symbolFormat: "mock",
  priceRange: null,
  capabilities: ["quote", "funding"],
  search: async () => [],
  getQuote: options.getQuote ?? (async (symbol) => ({ symbol, price: 100, bid: 99, ask: 101, timestamp: new Date().toISOString() })),
  getFundingRate: options.getFundingRate,
});

beforeAll(async () => {
  const [dbModule, schemaModule, fundingCollectorModule, eventsModule] = await Promise.all([
    import("../src/db/client.js"),
    import("../src/db/schema.js"),
    import("../src/workers/funding-collector.js"),
    import("../src/platform/events.js"),
  ]);
  await dbModule.migrate();
  db = dbModule.db;
  sqlite = dbModule.sqlite;
  tables = schemaModule;
  applyFundingPayments = fundingCollectorModule.applyFundingPayments;
  eventBus = eventsModule.eventBus;
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await rm(dbFilePath, { force: true });
  await rm(`${dbFilePath}-wal`, { force: true });
  await rm(`${dbFilePath}-shm`, { force: true });
});

describe("funding collector integration", () => {
  it("applies funding once per funding window and skips duplicate windows", async () => {
    await insertUserAndAccount({ userId: "uf1", accountId: "af1", balance: 1000 });
    await insertPosition({ id: "pf1", accountId: "af1", market: "funding-ok", symbol: "BTC", quantity: 2 });

    const registry = new MarketRegistry();
    registry.register(
      buildFundingAdapter({
        marketId: "funding-ok",
        getFundingRate: async (symbol) => ({
          symbol,
          rate: 0.01,
          nextFundingAt: "2026-03-01T01:00:00.000Z",
          timestamp: "2026-03-01T00:30:00.000Z",
        }),
      }),
    );

    const events: EventsModule["EmittedTradingEvent"][] = [];
    const unsubscribe = eventBus.subscribe("uf1", (event) => events.push(event));

    const first = await applyFundingPayments(registry);
    const second = await applyFundingPayments(registry);

    unsubscribe();

    expect(first).toEqual({ applied: 1, skipped: 0 });
    expect(second).toEqual({ applied: 0, skipped: 1 });

    const account = await db.select().from(tables.accounts).where(eq(tables.accounts.id, "af1")).get();
    expect(account?.balance).toBeCloseTo(998, 6);

    const fundingRows = await db.select().from(tables.fundingPayments).where(eq(tables.fundingPayments.accountId, "af1")).all();
    expect(fundingRows).toHaveLength(1);
    expect(fundingRows[0]?.payment).toBeCloseTo(-2, 6);

    const fundingEvents = events.filter((event) => event.type === "funding.applied");
    expect(fundingEvents).toHaveLength(1);
    expect(fundingEvents[0]).toMatchObject({
      type: "funding.applied",
      userId: "uf1",
      accountId: "af1",
      data: {
        market: "funding-ok",
        symbol: "BTC",
        payment: -2,
      },
    });
  });

  it("applies funding again when the funding window changes", async () => {
    await insertUserAndAccount({ userId: "uf2", accountId: "af2", balance: 1000 });
    await insertPosition({ id: "pf2", accountId: "af2", market: "funding-ok", symbol: "BTC", quantity: 1 });

    let call = 0;
    const windows = ["2026-03-01T01:00:00.000Z", "2026-03-01T02:00:00.000Z"];

    const registry = new MarketRegistry();
    registry.register(
      buildFundingAdapter({
        marketId: "funding-ok",
        getFundingRate: async (symbol) => {
          const nextFundingAt = windows[Math.min(call, windows.length - 1)]!;
          call += 1;
          return {
            symbol,
            rate: 0.01,
            nextFundingAt,
            timestamp: "2026-03-01T00:30:00.000Z",
          };
        },
      }),
    );

    const first = await applyFundingPayments(registry);
    const second = await applyFundingPayments(registry);

    expect(first).toEqual({ applied: 1, skipped: 0 });
    expect(second).toEqual({ applied: 1, skipped: 0 });

    const account = await db.select().from(tables.accounts).where(eq(tables.accounts.id, "af2")).get();
    expect(account?.balance).toBeCloseTo(998, 6);

    const fundingRows = await db.select().from(tables.fundingPayments).where(eq(tables.fundingPayments.accountId, "af2")).all();
    expect(fundingRows).toHaveLength(2);
  });
});
