import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INITIAL_BALANCE } from "@unimarket/core";
import { MarketAdapterError, MarketRegistry, type MarketAdapter } from "@unimarket/markets";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { API_VERSION } from "../src/version.js";

type AppLike = {
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

type RegisterPayload = {
  userId: string;
  apiKey: string;
  account: {
    id: string;
    balance: number;
    createdAt: string;
  };
};

type DbModule = Awaited<typeof import("../src/db/client.js")>;
type SchemaModule = Awaited<typeof import("../src/db/schema.js")>;

const dbFilePath = join(tmpdir(), `unimarket-test-${randomUUID()}.sqlite`);
process.env.DB_URL = `file:${dbFilePath}`;
process.env.ADMIN_API_KEY = "admin_test_key";

let app: AppLike;
let db: DbModule["db"];
let sqlite: DbModule["sqlite"];
let tables: SchemaModule;
let registry: MarketRegistry;
let reconcilePendingOrders: (typeof import("../src/workers/reconciler.js"))["reconcilePendingOrders"];
let recordEquitySnapshots: (typeof import("../src/workers/equity-snapshotter.js"))["recordEquitySnapshots"];

const quoteBySymbol: Record<string, { price: number; bid: number; ask: number }> = {
  "0x-market-fill": { price: 0.52, bid: 0.51, ask: 0.52 },
  "0x-pending": { price: 0.66, bid: 0.65, ask: 0.66 },
  "0x-reconcile-a": { price: 0.71, bid: 0.7, ask: 0.71 },
  "0x-reconcile-b": { price: 0.72, bid: 0.71, ask: 0.72 },
};

const polymarketAdapter: MarketAdapter = {
  marketId: "polymarket",
  displayName: "Polymarket",
  description: "mock polymarket adapter",
  symbolFormat: "mock",
  priceRange: [0.01, 0.99],
  capabilities: ["search", "quote", "orderbook", "resolve"],
  search: async (query) => {
    const lowered = query.toLowerCase();
    return [
      { symbol: "0x-market-fill", name: "Market Fill Contract", metadata: { category: "test" } },
      { symbol: "0x-pending", name: "Pending Contract", metadata: { category: "test" } },
      { symbol: "0x-reconcile-a", name: "Reconcile Contract A", metadata: { category: "test" } },
      { symbol: "0x-reconcile-b", name: "Reconcile Contract B", metadata: { category: "test" } },
    ].filter((item) => item.symbol.includes(lowered) || item.name.toLowerCase().includes(lowered));
  },
  normalizeSymbol: async (symbol) => (symbol === "alias-fill" ? "0x-market-fill" : symbol),
  getQuote: async (symbol) => {
    const quote = quoteBySymbol[symbol] ?? { price: 0.6, bid: 0.59, ask: 0.6 };
    return { symbol, ...quote, timestamp: new Date().toISOString() };
  },
  getOrderbook: async (symbol) => ({
    symbol,
    bids: [{ price: 0.49, size: 120 }],
    asks: [{ price: 0.51, size: 130 }],
    timestamp: new Date().toISOString(),
  }),
  resolve: async (symbol) => ({
    symbol,
    resolved: false,
    outcome: null,
    settlementPrice: null,
    timestamp: new Date().toISOString(),
  }),
  resolveSymbolNames: async (symbols) => {
    const names = new Map<string, string>();
    const outcomes = new Map<string, string>();

    for (const symbol of symbols) {
      names.set(symbol, `Resolved ${symbol}`);
      const lowered = symbol.toLowerCase();
      if (lowered.includes("yes")) outcomes.set(symbol, "Yes");
      if (lowered.includes("no")) outcomes.set(symbol, "No");
    }

    return { names, outcomes };
  },
};

const quoteOnlyAdapter: MarketAdapter = {
  marketId: "quote-only",
  displayName: "Quote Only",
  description: "adapter to validate capability guard rails",
  symbolFormat: "mock",
  priceRange: [0.01, 1],
  capabilities: ["quote"],
  search: async () => [],
  getQuote: async (symbol) => ({
    symbol,
    price: 0.4,
    bid: 0.39,
    ask: 0.4,
    timestamp: new Date().toISOString(),
  }),
};

const fundingAdapter: MarketAdapter = {
  marketId: "funding-only",
  displayName: "Funding Only",
  description: "adapter to validate funding capability routes",
  symbolFormat: "ticker",
  priceRange: null,
  capabilities: ["search", "quote", "funding"],
  search: async () => [{ symbol: "BTC", name: "BTC-PERP" }],
  normalizeSymbol: async (symbol) => symbol.trim().replace(/[-_\s]*perp$/i, "").toUpperCase(),
  getQuote: async (symbol) => ({
    symbol,
    price: 100_000,
    bid: 99_950,
    ask: 100_050,
    timestamp: new Date().toISOString(),
  }),
  getFundingRate: async (symbol) => {
    if (symbol !== "BTC") {
      throw new MarketAdapterError("SYMBOL_NOT_FOUND", `No funding data for ${symbol}`);
    }
    return {
      symbol,
      rate: 0.0002,
      nextFundingAt: "2026-01-01T01:00:00.000Z",
      timestamp: new Date().toISOString(),
    };
  },
  getTradingConstraints: async () => ({
    minQuantity: 0.001,
    quantityStep: 0.001,
    supportsFractional: true,
    maxLeverage: 20,
  }),
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
  await sqlite.execute("DELETE FROM equity_snapshots");
  await sqlite.execute("DELETE FROM symbol_metadata_cache");
  await sqlite.execute("DELETE FROM idempotency_keys");
  await sqlite.execute("DELETE FROM api_keys");
  await sqlite.execute("DELETE FROM accounts");
  await sqlite.execute("DELETE FROM users");
};

const registerUser = async (userName: string): Promise<RegisterPayload> => {
  const response = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userName }),
  });

  expect(response.status).toBe(201);
  return (await response.json()) as RegisterPayload;
};

const authedJson = async (
  path: string,
  apiKey: string,
  init: Omit<RequestInit, "headers"> & { headers?: HeadersInit } = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  return app.request(path, {
    ...init,
    headers,
  });
};

const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const parseSseDataEvent = (chunk: Uint8Array): Record<string, unknown> => {
  const raw = new TextDecoder().decode(chunk);
  const dataLine = raw
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`Expected SSE data line but received chunk: ${raw}`);
  }
  return JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown>;
};

const parseSseDataEvents = (chunk: Uint8Array): Array<Record<string, unknown>> => {
  const raw = new TextDecoder().decode(chunk);
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
};

beforeAll(async () => {
  const [{ createApp }, dbModule, schemaModule, reconcilerModule, snapshotterModule] = await Promise.all([
    import("../src/app.js"),
    import("../src/db/client.js"),
    import("../src/db/schema.js"),
    import("../src/workers/reconciler.js"),
    import("../src/workers/equity-snapshotter.js"),
  ]);

  await dbModule.migrate();
  db = dbModule.db;
  sqlite = dbModule.sqlite;
  tables = schemaModule;

  registry = new MarketRegistry();
  registry.register(polymarketAdapter);
  registry.register(quoteOnlyAdapter);
  registry.register(fundingAdapter);
  reconcilePendingOrders = reconcilerModule.reconcilePendingOrders;
  recordEquitySnapshots = snapshotterModule.recordEquitySnapshots;

  app = createApp({ registry });
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

describe("api integration", () => {
  it("does not expose dashboard routes from the API server by default", async () => {
    const rootResponse = await app.request("/");
    expect(rootResponse.status).toBe(404);

    const dashboardResponse = await app.request("/dashboard");
    expect(dashboardResponse.status).toBe(404);
  });

  it("serves meta endpoints and protects authenticated routes", async () => {
    const healthResponse = await app.request("/health");
    expect(healthResponse.status).toBe(200);
    const health = await healthResponse.json();
    expect(healthResponse.headers.get("x-api-version")).toBe(API_VERSION);
    expect(health.status).toBe("ok");
    expect(health.version).toBe(API_VERSION);
    expect(health.markets.polymarket).toBe("available");
    expect(health.markets["quote-only"]).toBe("available");
    expect(health.markets["funding-only"]).toBe("available");

    const unauthorizedOrders = await app.request("/api/orders");
    expect(unauthorizedOrders.status).toBe(401);
    const unauthorizedPayload = await unauthorizedOrders.json();
    expect(unauthorizedPayload.error.code).toBe("UNAUTHORIZED");

    const user = await registerUser("api-not-found-user");
    const unknownApiRoute = await authedJson("/api/does-not-exist", user.apiKey);
    expect(unknownApiRoute.status).toBe(404);
    expect(unknownApiRoute.headers.get("content-type")).toContain("application/json");
    expect((await unknownApiRoute.json()).error.code).toBe("NOT_FOUND");
  });

  it("register requires userName and rejects legacy name payloads", async () => {
    const preferredResponse = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userName: "alias-user" }),
    });
    expect(preferredResponse.status).toBe(201);
    const preferredPayload = (await preferredResponse.json()) as RegisterPayload;

    const preferredUser = await db.select().from(tables.users).where(eq(tables.users.id, preferredPayload.userId)).get();
    expect(preferredUser?.name).toBe("alias-user");

    const legacyResponse = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "legacy-user" }),
    });
    expect(legacyResponse.status).toBe(400);
    expect((await legacyResponse.json()).error.code).toBe("INVALID_INPUT");
  });

  it("initializes with default registry when createApp is called without options", async () => {
    const { createApp } = await import("../src/app.js");
    const defaultApp = createApp();

    const healthResponse = await defaultApp.request("/health");
    expect(healthResponse.status).toBe(200);
    const healthPayload = await healthResponse.json();
    expect(healthResponse.headers.get("x-api-version")).toBe(API_VERSION);
    expect(healthPayload.version).toBe(API_VERSION);
    expect(healthPayload.markets.polymarket).toBe("available");
    expect(healthPayload.markets.hyperliquid).toBe("available");
  });

  it("rejects malformed auth headers and invalid query payloads", async () => {
    const user = await registerUser("query-guard-user");

    const malformedAuth = await app.request("/api/orders", {
      headers: { authorization: "Token malformed" },
    });
    expect(malformedAuth.status).toBe(401);
    expect((await malformedAuth.json()).error.code).toBe("UNAUTHORIZED");

    const invalidOrdersQuery = await authedJson("/api/orders?limit=999", user.apiKey);
    expect(invalidOrdersQuery.status).toBe(400);
    expect((await invalidOrdersQuery.json()).error.code).toBe("INVALID_INPUT");

    const invalidOrdersViewQuery = await authedJson("/api/orders?view=unsupported", user.apiKey);
    expect(invalidOrdersViewQuery.status).toBe(400);
    expect((await invalidOrdersViewQuery.json()).error.code).toBe("INVALID_INPUT");

    const invalidPositionsQuery = await authedJson("/api/positions?userId=", user.apiKey);
    expect(invalidPositionsQuery.status).toBe(400);
    expect((await invalidPositionsQuery.json()).error.code).toBe("INVALID_INPUT");

    const invalidTimelineQuery = await authedJson(`/api/account/timeline?limit=0`, user.apiKey);
    expect(invalidTimelineQuery.status).toBe(400);
    expect((await invalidTimelineQuery.json()).error.code).toBe("INVALID_INPUT");

    const invalidJournalQuery = await authedJson("/api/journal?limit=9999", user.apiKey);
    expect(invalidJournalQuery.status).toBe(400);
    expect((await invalidJournalQuery.json()).error.code).toBe("INVALID_INPUT");

    const browseQuery = await authedJson("/api/markets/polymarket/search", user.apiKey);
    expect(browseQuery.status).toBe(200);
    const browsePayload = await browseQuery.json();
    expect(Array.isArray(browsePayload.results)).toBe(true);

    const invalidQuoteQuery = await authedJson("/api/markets/polymarket/quote", user.apiKey);
    expect(invalidQuoteQuery.status).toBe(400);
    expect((await invalidQuoteQuery.json()).error.code).toBe("INVALID_INPUT");

    const invalidOrderbookQuery = await authedJson("/api/markets/polymarket/orderbook", user.apiKey);
    expect(invalidOrderbookQuery.status).toBe(400);
    expect((await invalidOrderbookQuery.json()).error.code).toBe("INVALID_INPUT");

    const invalidResolveQuery = await authedJson("/api/markets/polymarket/resolve", user.apiKey);
    expect(invalidResolveQuery.status).toBe(400);
    expect((await invalidResolveQuery.json()).error.code).toBe("INVALID_INPUT");
  });

  it("covers auth key lifecycle and admin constraints", async () => {
    const user = await registerUser("auth-user");

    const createKeyResponse = await authedJson("/api/auth/keys", user.apiKey, {
      method: "POST",
    });
    expect(createKeyResponse.status).toBe(201);
    const createKeyPayload = await createKeyResponse.json();
    expect(createKeyPayload.id).toBeDefined();
    expect(createKeyPayload.apiKey).toBeDefined();
    expect(createKeyPayload.prefix).toMatch(/^pt_live_/);
    expect(createKeyPayload.prefix).toMatch(/\*{4}$/);

    const revokeResponse = await authedJson(`/api/auth/keys/${createKeyPayload.id as string}`, user.apiKey, {
      method: "DELETE",
    });
    expect(revokeResponse.status).toBe(200);
    expect((await revokeResponse.json()).revoked).toBe(true);

    const revokedKeyRequest = await authedJson("/api/markets", createKeyPayload.apiKey as string);
    expect(revokedKeyRequest.status).toBe(401);

    const adminCreateKey = await authedJson("/api/auth/keys", "admin_test_key", {
      method: "POST",
    });
    expect(adminCreateKey.status).toBe(400);
    expect((await adminCreateKey.json()).error.code).toBe("INVALID_USER");

    const adminRevokeKey = await authedJson(`/api/auth/keys/${createKeyPayload.id as string}`, "admin_test_key", {
      method: "DELETE",
    });
    expect(adminRevokeKey.status).toBe(400);
    expect((await adminRevokeKey.json()).error.code).toBe("INVALID_USER");
  });

  it("keeps single-account ownership boundaries", async () => {
    const owner = await registerUser("owner-account-user");
    const other = await registerUser("other-account-user");

    const ownerAccounts = await db.select().from(tables.accounts).where(eq(tables.accounts.userId, owner.userId)).all();
    expect(ownerAccounts).toHaveLength(1);

    const ownerGetAccount = await authedJson(`/api/account`, owner.apiKey);
    expect(ownerGetAccount.status).toBe(200);
    expect((await ownerGetAccount.json()).id).toBe(owner.account.id);

    const otherGetAccount = await authedJson(`/api/account`, other.apiKey);
    expect(otherGetAccount.status).toBe(200);
    expect((await otherGetAccount.json()).id).toBe(other.account.id);

    const adminGetAccount = await authedJson(`/api/account`, "admin_test_key");
    expect(adminGetAccount.status).toBe(400);
    expect((await adminGetAccount.json()).error.code).toBe("INVALID_USER");
  });

  it("validates optional accountId inputs for orders and positions", async () => {
    const owner = await registerUser("accountid-owner");
    const outsider = await registerUser("accountid-outsider");

    quoteBySymbol["0x-accountid"] = { price: 0.55, bid: 0.54, ask: 0.55 };

    const matchingAccountOrder = await authedJson("/api/orders", owner.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: owner.account.id,
        market: "polymarket",
        symbol: "0x-accountid",
        side: "buy",
        type: "market",
        quantity: 2,
        reasoning: "explicitly target my own account",
      }),
    });
    expect(matchingAccountOrder.status).toBe(201);

    const foreignAccountOrder = await authedJson("/api/orders", owner.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: outsider.account.id,
        market: "polymarket",
        symbol: "0x-accountid",
        side: "buy",
        type: "market",
        quantity: 1,
        reasoning: "attempt to target another account",
      }),
    });
    expect(foreignAccountOrder.status).toBe(404);
    expect((await foreignAccountOrder.json()).error.code).toBe("ACCOUNT_NOT_FOUND");

    const ownOrders = await authedJson(`/api/orders?accountId=${owner.account.id}`, owner.apiKey);
    expect(ownOrders.status).toBe(200);
    expect((await ownOrders.json()).orders).toHaveLength(1);

    const foreignOrders = await authedJson(`/api/orders?accountId=${outsider.account.id}`, owner.apiKey);
    expect(foreignOrders.status).toBe(200);
    expect((await foreignOrders.json()).orders).toEqual([]);

    const ownPositions = await authedJson(`/api/positions?accountId=${owner.account.id}`, owner.apiKey);
    expect(ownPositions.status).toBe(200);
    expect((await ownPositions.json()).positions).toHaveLength(1);

    const foreignPositions = await authedJson(`/api/positions?accountId=${outsider.account.id}`, owner.apiKey);
    expect(foreignPositions.status).toBe(200);
    expect((await foreignPositions.json()).positions).toEqual([]);

    const adminOrders = await authedJson(`/api/orders?accountId=${owner.account.id}`, "admin_test_key");
    expect(adminOrders.status).toBe(200);
    expect((await adminOrders.json()).orders.length).toBeGreaterThanOrEqual(1);

    const adminPositions = await authedJson(`/api/positions?accountId=${owner.account.id}`, "admin_test_key");
    expect(adminPositions.status).toBe(200);
    expect((await adminPositions.json()).positions).toHaveLength(1);
  });

  it("covers order placement validation and trading error branches", async () => {
    const user = await registerUser("order-error-user");

    const adminPlaceOrder = await authedJson("/api/orders", "admin_test_key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-market-fill",
        side: "buy",
        type: "market",
        quantity: 1,
        reasoning: "admin should not place orders here",
      }),
    });
    expect(adminPlaceOrder.status).toBe(400);
    expect((await adminPlaceOrder.json()).error.code).toBe("INVALID_USER");

    const invalidLimitOrder = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-market-fill",
        side: "buy",
        type: "limit",
        quantity: 2,
        reasoning: "missing limit price should fail schema",
      }),
    });
    expect(invalidLimitOrder.status).toBe(400);
    expect((await invalidLimitOrder.json()).error.code).toBe("INVALID_INPUT");

    const marketNotFoundOrder = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "missing-market",
        symbol: "0x-market-fill",
        side: "buy",
        type: "market",
        quantity: 1,
        reasoning: "market should be rejected",
      }),
    });
    expect(marketNotFoundOrder.status).toBe(404);
    expect((await marketNotFoundOrder.json()).error.code).toBe("MARKET_NOT_FOUND");

    const insufficientBalanceOrder = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-market-fill",
        side: "buy",
        type: "market",
        quantity: 1_000_000,
        reasoning: "force insufficient balance branch",
      }),
    });
    expect(insufficientBalanceOrder.status).toBe(400);
    expect((await insufficientBalanceOrder.json()).error.code).toBe("INSUFFICIENT_BALANCE");

    const insufficientPositionOrder = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-market-fill",
        side: "sell",
        type: "market",
        quantity: 1,
        reasoning: "cannot sell without inventory",
      }),
    });
    expect(insufficientPositionOrder.status).toBe(400);
    expect((await insufficientPositionOrder.json()).error.code).toBe("INSUFFICIENT_POSITION");
  });

  it("enforces market-specific trading constraints and max leverage", async () => {
    const user = await registerUser("trading-constraints-user");

    const fractionalPolymarketOrder = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-market-fill",
        side: "buy",
        type: "market",
        quantity: 1.5,
        reasoning: "fractional size should be rejected for integer-only market",
      }),
    });
    expect(fractionalPolymarketOrder.status).toBe(400);
    expect((await fractionalPolymarketOrder.json()).error.code).toBe("INVALID_INPUT");

    const overLeverageOrder = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "funding-only",
        symbol: "BTC",
        side: "buy",
        type: "market",
        quantity: 0.1,
        leverage: 21,
        reasoning: "leverage above symbol max should fail",
      }),
    });
    expect(overLeverageOrder.status).toBe(400);
    expect((await overLeverageOrder.json()).error.code).toBe("INVALID_INPUT");

    const validFractionalPerpOrder = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "funding-only",
        symbol: "BTC",
        side: "buy",
        type: "market",
        quantity: 0.1,
        leverage: 5,
        reasoning: "fractional size should pass for fractional market",
      }),
    });
    expect(validFractionalPerpOrder.status).toBe(201);
    const validPayload = await validFractionalPerpOrder.json();
    expect(validPayload.status).toBe("filled");

    const positionRows = await db
      .select()
      .from(tables.positions)
      .where(eq(tables.positions.accountId, user.account.id))
      .all();
    expect(positionRows).toHaveLength(1);
    expect(positionRows[0]?.quantity).toBeCloseTo(0.1, 6);
  });

  it("covers market discovery and capability-guarded market data endpoints", async () => {
    const user = await registerUser("market-user");

    const marketsResponse = await authedJson("/api/markets", user.apiKey);
    expect(marketsResponse.status).toBe(200);
    const marketsPayload = await marketsResponse.json();
    expect(marketsPayload.markets.map((item: { id: string }) => item.id)).toEqual(
      expect.arrayContaining(["polymarket", "quote-only", "funding-only"]),
    );

    const searchResponse = await authedJson("/api/markets/polymarket/search?q=reconcile", user.apiKey);
    expect(searchResponse.status).toBe(200);
    const searchPayload = await searchResponse.json();
    expect(searchPayload.results.length).toBeGreaterThan(0);

    const quoteResponse = await authedJson("/api/markets/polymarket/quote?symbol=0x-market-fill", user.apiKey);
    expect(quoteResponse.status).toBe(200);
    const quotePayload = await quoteResponse.json();
    expect(quotePayload.price).toBe(0.52);

    const orderbookResponse = await authedJson("/api/markets/polymarket/orderbook?symbol=0x-market-fill", user.apiKey);
    expect(orderbookResponse.status).toBe(200);
    const orderbookPayload = await orderbookResponse.json();
    expect(Array.isArray(orderbookPayload.bids)).toBe(true);

    const resolveResponse = await authedJson("/api/markets/polymarket/resolve?symbol=0x-market-fill", user.apiKey);
    expect(resolveResponse.status).toBe(200);
    const resolvePayload = await resolveResponse.json();
    expect(resolvePayload.resolved).toBe(false);

    const fundingResponse = await authedJson("/api/markets/funding-only/funding?symbol=btc-perp", user.apiKey);
    expect(fundingResponse.status).toBe(200);
    const fundingPayload = await fundingResponse.json();
    expect(fundingPayload).toMatchObject({
      symbol: "BTC",
      rate: 0.0002,
      nextFundingAt: "2026-01-01T01:00:00.000Z",
    });

    const fundingConstraintsResponse = await authedJson(
      "/api/markets/funding-only/trading-constraints?symbol=btc-perp",
      user.apiKey,
    );
    expect(fundingConstraintsResponse.status).toBe(200);
    const fundingConstraintsPayload = await fundingConstraintsResponse.json();
    expect(fundingConstraintsPayload).toMatchObject({
      symbol: "BTC",
      constraints: {
        minQuantity: 0.001,
        quantityStep: 0.001,
        supportsFractional: true,
        maxLeverage: 20,
      },
    });

    const polymarketConstraintsResponse = await authedJson(
      "/api/markets/polymarket/trading-constraints?symbol=0x-market-fill",
      user.apiKey,
    );
    expect(polymarketConstraintsResponse.status).toBe(200);
    const polymarketConstraintsPayload = await polymarketConstraintsResponse.json();
    expect(polymarketConstraintsPayload).toMatchObject({
      symbol: "0x-market-fill",
      constraints: {
        minQuantity: 1,
        quantityStep: 1,
        supportsFractional: false,
        maxLeverage: null,
      },
    });

    const missingMarket = await authedJson("/api/markets/missing/quote?symbol=0x-market-fill", user.apiKey);
    expect(missingMarket.status).toBe(404);
    expect((await missingMarket.json()).error.code).toBe("MARKET_NOT_FOUND");

    const unsupportedSearch = await authedJson("/api/markets/quote-only/search?q=abc", user.apiKey);
    expect(unsupportedSearch.status).toBe(400);
    expect((await unsupportedSearch.json()).error.code).toBe("CAPABILITY_NOT_SUPPORTED");

    const unsupportedOrderbook = await authedJson("/api/markets/quote-only/orderbook?symbol=abc", user.apiKey);
    expect(unsupportedOrderbook.status).toBe(400);
    expect((await unsupportedOrderbook.json()).error.code).toBe("CAPABILITY_NOT_SUPPORTED");

    const unsupportedResolve = await authedJson("/api/markets/quote-only/resolve?symbol=abc", user.apiKey);
    expect(unsupportedResolve.status).toBe(400);
    expect((await unsupportedResolve.json()).error.code).toBe("CAPABILITY_NOT_SUPPORTED");

    const unsupportedFunding = await authedJson("/api/markets/quote-only/funding?symbol=abc", user.apiKey);
    expect(unsupportedFunding.status).toBe(400);
    expect((await unsupportedFunding.json()).error.code).toBe("CAPABILITY_NOT_SUPPORTED");
  });

  it("applies configured taker fee and persists fee rate for pending orders", async () => {
    const previousDefaultTakerFeeRate = process.env.DEFAULT_TAKER_FEE_RATE;
    process.env.DEFAULT_TAKER_FEE_RATE = "0.01";

    try {
      const user = await registerUser("fee-config-user");
      quoteBySymbol["0x-fee-market"] = { price: 10, bid: 9.9, ask: 10 };
      quoteBySymbol["0x-fee-pending"] = { price: 10, bid: 9.9, ask: 10 };

      const marketOrder = await authedJson("/api/orders", user.apiKey, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          market: "polymarket",
          symbol: "0x-fee-market",
          side: "buy",
          type: "market",
          quantity: 5,
          reasoning: "market order with configured fee",
        }),
      });
      expect(marketOrder.status).toBe(201);
      const marketOrderPayload = await marketOrder.json();

      const marketTrade = await db
        .select()
        .from(tables.trades)
        .where(eq(tables.trades.orderId, marketOrderPayload.id as string))
        .get();
      expect(marketTrade?.fee).toBeCloseTo(0.5, 6);

      const pendingOrder = await authedJson("/api/orders", user.apiKey, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          market: "polymarket",
          symbol: "0x-fee-pending",
          side: "buy",
          type: "limit",
          quantity: 2,
          limitPrice: 8,
          reasoning: "pending order should persist fee rate",
        }),
      });
      expect(pendingOrder.status).toBe(201);
      const pendingOrderPayload = await pendingOrder.json();
      expect(pendingOrderPayload.status).toBe("pending");

      const pendingParams = await db
        .select()
        .from(tables.orderExecutionParams)
        .where(eq(tables.orderExecutionParams.orderId, pendingOrderPayload.id as string))
        .get();
      expect(pendingParams?.takerFeeRate).toBeCloseTo(0.01, 6);

      process.env.DEFAULT_TAKER_FEE_RATE = "0.05";
      quoteBySymbol["0x-fee-pending"] = { price: 7.5, bid: 7.4, ask: 7.5 };

      const reconcilePayload = await reconcilePendingOrders(registry);
      expect(reconcilePayload.filledOrderIds).toContain(pendingOrderPayload.id);

      const pendingTrade = await db
        .select()
        .from(tables.trades)
        .where(eq(tables.trades.orderId, pendingOrderPayload.id as string))
        .get();
      expect(pendingTrade?.price).toBe(7.5);
      expect(pendingTrade?.fee).toBeCloseTo(0.15, 6);

      const accountRow = await db.select().from(tables.accounts).where(eq(tables.accounts.id, user.account.id)).get();
      expect(accountRow?.balance).toBeCloseTo(INITIAL_BALANCE - 50 - 0.5 - 15 - 0.15, 6);
    } finally {
      if (previousDefaultTakerFeeRate === undefined) {
        delete process.env.DEFAULT_TAKER_FEE_RATE;
      } else {
        process.env.DEFAULT_TAKER_FEE_RATE = previousDefaultTakerFeeRate;
      }
    }
  });

  it("supports batch quote/orderbook endpoints with partial failures", async () => {
    const user = await registerUser("market-batch-user");

    const originalGetQuote = polymarketAdapter.getQuote;
    const originalGetOrderbook = polymarketAdapter.getOrderbook;

    const quoteSpy = vi.spyOn(polymarketAdapter, "getQuote").mockImplementation(async (symbol) => {
      if (symbol === "0x-batch-fail") {
        throw new MarketAdapterError("SYMBOL_NOT_FOUND", "No quote available for symbol");
      }
      return originalGetQuote(symbol);
    });

    const orderbookSpy = vi.spyOn(polymarketAdapter, "getOrderbook").mockImplementation(async (symbol) => {
      if (symbol === "0x-batch-fail") {
        throw new MarketAdapterError("SYMBOL_NOT_FOUND", "No orderbook available for symbol");
      }
      if (!originalGetOrderbook) {
        throw new Error("orderbook not supported in test adapter");
      }
      return originalGetOrderbook(symbol);
    });

    const quotesResponse = await authedJson(
      "/api/markets/polymarket/quotes?symbols=0x-market-fill,0x-batch-fail,0x-market-fill",
      user.apiKey,
    );
    expect(quotesResponse.status).toBe(200);
    const quotesPayload = await quotesResponse.json();
    expect(quotesPayload.quotes).toHaveLength(1);
    expect(quotesPayload.errors).toHaveLength(1);
    expect(quotesPayload.errors[0]).toMatchObject({
      symbol: "0x-batch-fail",
      error: { code: "SYMBOL_NOT_FOUND" },
    });

    const orderbooksResponse = await authedJson(
      "/api/markets/polymarket/orderbooks?symbols=0x-market-fill,0x-batch-fail",
      user.apiKey,
    );
    expect(orderbooksResponse.status).toBe(200);
    const orderbooksPayload = await orderbooksResponse.json();
    expect(orderbooksPayload.orderbooks).toHaveLength(1);
    expect(orderbooksPayload.errors).toHaveLength(1);
    expect(orderbooksPayload.errors[0]).toMatchObject({
      symbol: "0x-batch-fail",
      error: { code: "SYMBOL_NOT_FOUND" },
    });

    const unsupportedBatchOrderbooks = await authedJson("/api/markets/quote-only/orderbooks?symbols=abc", user.apiKey);
    expect(unsupportedBatchOrderbooks.status).toBe(400);
    expect((await unsupportedBatchOrderbooks.json()).error.code).toBe("CAPABILITY_NOT_SUPPORTED");

    const fundingsResponse = await authedJson("/api/markets/funding-only/fundings?symbols=btc,missing", user.apiKey);
    expect(fundingsResponse.status).toBe(200);
    const fundingsPayload = await fundingsResponse.json();
    expect(fundingsPayload.fundings).toHaveLength(1);
    expect(fundingsPayload.fundings[0]).toMatchObject({
      symbol: "BTC",
      rate: 0.0002,
    });
    expect(fundingsPayload.errors).toHaveLength(1);
    expect(fundingsPayload.errors[0]).toMatchObject({
      symbol: "missing",
      error: { code: "SYMBOL_NOT_FOUND" },
    });

    const unsupportedBatchFundings = await authedJson("/api/markets/quote-only/fundings?symbols=abc", user.apiKey);
    expect(unsupportedBatchFundings.status).toBe(400);
    expect((await unsupportedBatchFundings.json()).error.code).toBe("CAPABILITY_NOT_SUPPORTED");

    expect(quoteSpy).toHaveBeenCalled();
    expect(orderbookSpy).toHaveBeenCalled();
  });

  it("covers market endpoint exception handling branches and resolve null fallback", async () => {
    const user = await registerUser("market-error-user");
    const originalGetQuote = polymarketAdapter.getQuote;
    const originalResolve = polymarketAdapter.resolve;

    const quoteSpy = vi.spyOn(polymarketAdapter, "getQuote").mockImplementation(async (symbol) => {
      if (symbol === "0x-madapter-error") {
        throw new MarketAdapterError("UPSTREAM_ERROR", "upstream unavailable");
      }
      if (symbol === "0x-symbol-not-found") {
        throw new MarketAdapterError("SYMBOL_NOT_FOUND", "No quote available for symbol");
      }
      if (symbol === "0x-generic-error") {
        throw new Error("generic quote failure");
      }
      if (symbol === "0x-unknown-error") {
        throw "unexpected-primitive-throw";
      }
      return originalGetQuote(symbol);
    });

    const resolveSpy = vi.spyOn(polymarketAdapter, "resolve").mockImplementation(async (symbol) => {
      if (symbol === "0x-null-resolution") {
        return null;
      }
      if (!originalResolve) {
        return null;
      }
      return originalResolve(symbol);
    });

    const adapterErrorResponse = await authedJson(
      "/api/markets/polymarket/quote?symbol=0x-madapter-error",
      user.apiKey,
    );
    expect(adapterErrorResponse.status).toBe(502);
    expect((await adapterErrorResponse.json()).error.code).toBe("UPSTREAM_ERROR");

    const symbolNotFoundResponse = await authedJson(
      "/api/markets/polymarket/quote?symbol=0x-symbol-not-found",
      user.apiKey,
    );
    expect(symbolNotFoundResponse.status).toBe(404);
    expect((await symbolNotFoundResponse.json()).error.code).toBe("SYMBOL_NOT_FOUND");

    const genericErrorResponse = await authedJson(
      "/api/markets/polymarket/quote?symbol=0x-generic-error",
      user.apiKey,
    );
    expect(genericErrorResponse.status).toBe(500);
    const genericErrorPayload = await genericErrorResponse.json();
    expect(genericErrorPayload.error.code).toBe("INTERNAL_ERROR");
    expect(genericErrorPayload.error.message).toContain("generic quote failure");

    const unknownErrorResponse = await authedJson(
      "/api/markets/polymarket/quote?symbol=0x-unknown-error",
      user.apiKey,
    );
    expect(unknownErrorResponse.status).toBe(500);
    const unknownErrorPayload = await unknownErrorResponse.json();
    expect(unknownErrorPayload.error.code).toBe("INTERNAL_ERROR");
    expect(unknownErrorPayload.error.message).toBe("Unknown server error");

    const nullResolutionResponse = await authedJson(
      "/api/markets/polymarket/resolve?symbol=0x-null-resolution",
      user.apiKey,
    );
    expect(nullResolutionResponse.status).toBe(200);
    expect(await nullResolutionResponse.json()).toMatchObject({
      symbol: "0x-null-resolution",
      resolved: false,
      outcome: null,
      settlementPrice: null,
    });

    expect(quoteSpy).toHaveBeenCalled();
    expect(resolveSpy).toHaveBeenCalled();
  });

  it("streams SSE events with user-scoped and admin-wide visibility", async () => {
    const owner = await registerUser("events-owner");
    const outsider = await registerUser("events-outsider");

    quoteBySymbol["0x-events-fill"] = { price: 0.52, bid: 0.51, ask: 0.52 };

    const ownerEvents = await authedJson("/api/events", owner.apiKey);
    const outsiderEvents = await authedJson("/api/events", outsider.apiKey);
    const adminEvents = await authedJson("/api/events", "admin_test_key");

    expect(ownerEvents.status).toBe(200);
    expect(ownerEvents.headers.get("content-type")).toContain("text/event-stream");
    expect(ownerEvents.headers.get("cache-control")).toContain("no-cache");
    expect(ownerEvents.headers.get("connection")).toContain("keep-alive");
    expect(ownerEvents.headers.get("x-api-version")).toBe(API_VERSION);
    expect(outsiderEvents.status).toBe(200);
    expect(adminEvents.status).toBe(200);

    const ownerReader = ownerEvents.body?.getReader();
    const outsiderReader = outsiderEvents.body?.getReader();
    const adminReader = adminEvents.body?.getReader();

    expect(ownerReader).toBeDefined();
    expect(outsiderReader).toBeDefined();
    expect(adminReader).toBeDefined();

    const ownerReadyPromise = ownerReader!.read();
    const outsiderReadyPromise = outsiderReader!.read();
    const adminReadyPromise = adminReader!.read();

    const ownerReadyChunk = await withTimeout(ownerReadyPromise, 2000, "owner system.ready");
    const outsiderReadyChunk = await withTimeout(outsiderReadyPromise, 2000, "outsider system.ready");
    const adminReadyChunk = await withTimeout(adminReadyPromise, 2000, "admin system.ready");

    expect(ownerReadyChunk.done).toBe(false);
    expect(outsiderReadyChunk.done).toBe(false);
    expect(adminReadyChunk.done).toBe(false);

    const ownerReadyEvent = parseSseDataEvent(ownerReadyChunk.value ?? new Uint8Array());
    const outsiderReadyEvent = parseSseDataEvent(outsiderReadyChunk.value ?? new Uint8Array());
    const adminReadyEvent = parseSseDataEvent(adminReadyChunk.value ?? new Uint8Array());

    expect(ownerReadyEvent).toMatchObject({
      type: "system.ready",
      data: { version: API_VERSION },
    });
    expect(outsiderReadyEvent).toMatchObject({
      type: "system.ready",
      data: { version: API_VERSION },
    });
    expect(adminReadyEvent).toMatchObject({
      type: "system.ready",
      data: { version: API_VERSION },
    });

    expect(typeof (ownerReadyEvent.data as { connectedAt?: unknown }).connectedAt).toBe("string");
    expect(typeof (outsiderReadyEvent.data as { connectedAt?: unknown }).connectedAt).toBe("string");
    expect(typeof (adminReadyEvent.data as { connectedAt?: unknown }).connectedAt).toBe("string");

    const ownerReadPromise = ownerReader!.read();
    const outsiderReadPromise = outsiderReader!.read();
    const adminReadPromise = adminReader!.read();

    const orderResponse = await authedJson("/api/orders", owner.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-events-fill",
        side: "buy",
        type: "market",
        quantity: 2,
        reasoning: "Emit event for SSE stream listeners",
      }),
    });
    expect(orderResponse.status).toBe(201);
    const orderPayload = await orderResponse.json();

    const ownerChunk = await withTimeout(ownerReadPromise, 2000, "owner SSE event");
    const adminChunk = await withTimeout(adminReadPromise, 2000, "admin SSE event");

    expect(ownerChunk.done).toBe(false);
    expect(adminChunk.done).toBe(false);

    const ownerEvent = parseSseDataEvent(ownerChunk.value ?? new Uint8Array());
    const adminEvent = parseSseDataEvent(adminChunk.value ?? new Uint8Array());

    expect(ownerEvent.type).toBe("order.filled");
    expect(ownerEvent.userId).toBe(owner.userId);
    expect(ownerEvent.accountId).toBe(owner.account.id);
    expect(ownerEvent.orderId).toBe(orderPayload.id);

    expect(adminEvent.type).toBe("order.filled");
    expect(adminEvent.orderId).toBe(orderPayload.id);
    expect(adminEvent.userId).toBe(owner.userId);

    await expect(withTimeout(outsiderReadPromise, 250, "outsider SSE event")).rejects.toThrow(
      "Timed out waiting for outsider SSE event",
    );

    await ownerReader!.cancel();
    await outsiderReader!.cancel();
    await adminReader!.cancel();
  });

  it("replays missed SSE events when reconnecting with Last-Event-ID", async () => {
    const user = await registerUser("events-replay-user");
    quoteBySymbol["0x-events-replay"] = { price: 0.53, bid: 0.52, ask: 0.53 };

    const firstStream = await authedJson("/api/events", user.apiKey);
    expect(firstStream.status).toBe(200);
    const firstReader = firstStream.body?.getReader();
    expect(firstReader).toBeDefined();

    const readyChunk = await withTimeout(firstReader!.read(), 2000, "first replay stream system.ready");
    expect(readyChunk.done).toBe(false);
    const readyEvent = parseSseDataEvent(readyChunk.value ?? new Uint8Array());
    expect(readyEvent.type).toBe("system.ready");

    const firstReadPromise = firstReader!.read();
    const firstOrder = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-events-replay",
        side: "buy",
        type: "market",
        quantity: 1,
        reasoning: "first event before reconnect",
      }),
    });
    expect(firstOrder.status).toBe(201);
    const firstOrderPayload = await firstOrder.json();

    const firstEventChunk = await withTimeout(firstReadPromise, 2000, "first replay stream order event");
    expect(firstEventChunk.done).toBe(false);
    const firstEvent = parseSseDataEvent(firstEventChunk.value ?? new Uint8Array());
    expect(firstEvent.type).toBe("order.filled");
    expect(firstEvent.orderId).toBe(firstOrderPayload.id);
    expect(typeof firstEvent.id).toBe("string");

    const replayCursor = String(firstEvent.id);
    await firstReader!.cancel();

    const secondOrder = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-events-replay",
        side: "buy",
        type: "market",
        quantity: 1,
        reasoning: "second event while disconnected",
      }),
    });
    expect(secondOrder.status).toBe(201);
    const secondOrderPayload = await secondOrder.json();

    const thirdOrder = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-events-replay",
        side: "buy",
        type: "market",
        quantity: 1,
        reasoning: "third event while disconnected",
      }),
    });
    expect(thirdOrder.status).toBe(201);
    const thirdOrderPayload = await thirdOrder.json();

    const replayStream = await authedJson("/api/events", user.apiKey, {
      headers: { "last-event-id": replayCursor },
    });
    expect(replayStream.status).toBe(200);
    const replayReader = replayStream.body?.getReader();
    expect(replayReader).toBeDefined();

    const replayReadyChunk = await withTimeout(replayReader!.read(), 2000, "replay stream system.ready");
    expect(replayReadyChunk.done).toBe(false);
    const replayReadyEvent = parseSseDataEvent(replayReadyChunk.value ?? new Uint8Array());
    expect(replayReadyEvent.type).toBe("system.ready");

    const expectedReplayOrderIds = new Set([secondOrderPayload.id as string, thirdOrderPayload.id as string]);
    const observedReplayOrderIds = new Set<string>();

    for (let i = 0; i < 5 && observedReplayOrderIds.size < expectedReplayOrderIds.size; i += 1) {
      const replayChunk = await withTimeout(replayReader!.read(), 2000, `replay chunk ${i + 1}`);
      if (replayChunk.done) break;

      const events = parseSseDataEvents(replayChunk.value ?? new Uint8Array());
      for (const event of events) {
        if (event.type === "order.filled" && typeof event.orderId === "string" && expectedReplayOrderIds.has(event.orderId)) {
          observedReplayOrderIds.add(event.orderId);
        }
      }
    }

    expect(Array.from(observedReplayOrderIds)).toEqual(expect.arrayContaining(Array.from(expectedReplayOrderIds)));
    await replayReader!.cancel();
  });

  it("covers order lifecycle, journal filtering, and timeline aggregation", async () => {
    const user = await registerUser("lifecycle-user");
    quoteBySymbol["0x-pending"] = { price: 0.66, bid: 0.65, ask: 0.66 };

    const pendingOrderResponse = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-pending",
        side: "buy",
        type: "limit",
        quantity: 9,
        limitPrice: 0.4,
        reasoning: "Place resting order while waiting for better entry",
      }),
    });
    expect(pendingOrderResponse.status).toBe(201);
    const pendingOrder = await pendingOrderResponse.json();
    expect(pendingOrder.status).toBe("pending");

    const orderByIdResponse = await authedJson(`/api/orders/${pendingOrder.id as string}`, user.apiKey);
    expect(orderByIdResponse.status).toBe(200);
    expect((await orderByIdResponse.json()).status).toBe("pending");

    const openOrdersResponse = await authedJson("/api/orders?view=open", user.apiKey);
    expect(openOrdersResponse.status).toBe(200);
    expect((await openOrdersResponse.json()).orders).toHaveLength(1);

    const portfolioResponse = await authedJson("/api/account/portfolio", user.apiKey);
    expect(portfolioResponse.status).toBe(200);
    const portfolioPayload = await portfolioResponse.json();
    expect(portfolioPayload.openOrders).toHaveLength(1);
    expect(portfolioPayload.openOrders[0]?.id).toBe(pendingOrder.id);

    const listOrdersResponse = await authedJson(
      `/api/orders?status=pending&market=polymarket&symbol=0x-pending`,
      user.apiKey,
    );
    expect(listOrdersResponse.status).toBe(200);
    const listOrdersPayload = await listOrdersResponse.json();
    expect(listOrdersPayload.orders).toHaveLength(1);

    const cancelMissingReasoning = await authedJson(`/api/orders/${pendingOrder.id as string}`, user.apiKey, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(cancelMissingReasoning.status).toBe(400);
    expect((await cancelMissingReasoning.json()).error.code).toBe("REASONING_REQUIRED");

    const cancelResponse = await authedJson(`/api/orders/${pendingOrder.id as string}`, user.apiKey, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoning: "Thesis invalidated by new information" }),
    });
    expect(cancelResponse.status).toBe(200);
    expect((await cancelResponse.json()).status).toBe("cancelled");

    const cancelledOrderById = await authedJson(`/api/orders/${pendingOrder.id as string}`, user.apiKey);
    expect(cancelledOrderById.status).toBe(200);
    expect((await cancelledOrderById.json()).status).toBe("cancelled");

    const openAfterCancel = await authedJson("/api/orders?view=open", user.apiKey);
    expect(openAfterCancel.status).toBe(200);
    expect((await openAfterCancel.json()).orders).toHaveLength(0);

    const historyAfterCancel = await authedJson("/api/orders?view=history", user.apiKey);
    expect(historyAfterCancel.status).toBe(200);
    expect((await historyAfterCancel.json()).orders).toHaveLength(1);

    const cancelAgainResponse = await authedJson(`/api/orders/${pendingOrder.id as string}`, user.apiKey, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoning: "Trying to cancel again" }),
    });
    expect(cancelAgainResponse.status).toBe(400);
    expect((await cancelAgainResponse.json()).error.code).toBe("INVALID_ORDER");

    const journalCreateResponse = await authedJson("/api/journal", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: "Tracking sentiment divergence in related contracts",
        tags: ["strategy", "sentiment"],
      }),
    });
    expect(journalCreateResponse.status).toBe(201);

    const journalFilteredResponse = await authedJson(
      "/api/journal?limit=10&offset=0&q=sentiment&tags=strategy",
      user.apiKey,
    );
    expect(journalFilteredResponse.status).toBe(200);
    const journalFilteredPayload = await journalFilteredResponse.json();
    expect(journalFilteredPayload.entries).toHaveLength(1);

    const timelineResponse = await authedJson(`/api/account/timeline?limit=20&offset=0`, user.apiKey);
    expect(timelineResponse.status).toBe(200);
    const timelinePayload = await timelineResponse.json();
    expect(Array.isArray(timelinePayload.events)).toBe(true);
    expect(timelinePayload.events.some((event: { type: string }) => event.type === "order.cancelled")).toBe(true);
    expect(timelinePayload.events.some((event: { type: string }) => event.type === "journal")).toBe(true);

    const adminJournalAccess = await authedJson("/api/journal", "admin_test_key");
    expect(adminJournalAccess.status).toBe(400);
    expect((await adminJournalAccess.json()).error.code).toBe("INVALID_USER");
  });

  it("normalizes symbols for order placement and replays idempotent writes", async () => {
    const user = await registerUser("idempotency-user");

    const initialOrder = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-order-1",
      },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "alias-fill",
        side: "buy",
        type: "market",
        quantity: 2,
        reasoning: "idempotency placement",
      }),
    });
    expect(initialOrder.status).toBe(201);
    const initialOrderPayload = await initialOrder.json();
    expect(initialOrderPayload.symbol).toBe("0x-market-fill");

    const replayedOrder = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-order-1",
      },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "alias-fill",
        side: "buy",
        type: "market",
        quantity: 2,
        reasoning: "idempotency placement",
      }),
    });
    expect(replayedOrder.status).toBe(201);
    expect(replayedOrder.headers.get("x-idempotent-replay")).toBe("true");
    const replayedOrderPayload = await replayedOrder.json();
    expect(replayedOrderPayload.id).toBe(initialOrderPayload.id);
    expect(replayedOrderPayload.symbol).toBe("0x-market-fill");

    const conflictingReplay = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-order-1",
      },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "alias-fill",
        side: "buy",
        type: "market",
        quantity: 3,
        reasoning: "same key different payload should fail",
      }),
    });
    expect(conflictingReplay.status).toBe(409);
    expect((await conflictingReplay.json()).error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");

    const filteredOrders = await authedJson("/api/orders?market=polymarket&symbol=alias-fill", user.apiKey);
    expect(filteredOrders.status).toBe(200);
    expect((await filteredOrders.json()).orders).toHaveLength(1);

    const positionsResponse = await authedJson("/api/positions", user.apiKey);
    expect(positionsResponse.status).toBe(200);
    const positionsPayload = await positionsResponse.json();
    expect(positionsPayload.positions).toHaveLength(1);
    expect(positionsPayload.positions[0].symbol).toBe("0x-market-fill");

    const orderRows = await db.select().from(tables.orders).where(eq(tables.orders.accountId, user.account.id)).all();
    const tradeRows = await db.select().from(tables.trades).where(eq(tables.trades.accountId, user.account.id)).all();
    expect(orderRows).toHaveLength(1);
    expect(tradeRows).toHaveLength(1);

    const firstJournal = await authedJson("/api/journal", user.apiKey, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-journal-1",
      },
      body: JSON.stringify({ content: "journal idem", tags: ["idem"] }),
    });
    expect(firstJournal.status).toBe(201);
    const firstJournalPayload = await firstJournal.json();

    const replayedJournal = await authedJson("/api/journal", user.apiKey, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "idem-journal-1",
      },
      body: JSON.stringify({ content: "journal idem", tags: ["idem"] }),
    });
    expect(replayedJournal.status).toBe(201);
    expect(replayedJournal.headers.get("x-idempotent-replay")).toBe("true");
    expect((await replayedJournal.json()).id).toBe(firstJournalPayload.id);
  });

  it("covers order cancellation not-found/ownership branches and empty account listing", async () => {
    const owner = await registerUser("cancel-owner");
    const outsider = await registerUser("cancel-outsider");

    quoteBySymbol["0x-pending"] = { price: 0.66, bid: 0.65, ask: 0.66 };
    const pendingResponse = await authedJson("/api/orders", owner.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-pending",
        side: "buy",
        type: "limit",
        quantity: 4,
        limitPrice: 0.3,
        reasoning: "create pending order for cancel tests",
      }),
    });
    expect(pendingResponse.status).toBe(201);
    const pendingPayload = await pendingResponse.json();

    const adminGetOrder = await authedJson(`/api/orders/${pendingPayload.id as string}`, "admin_test_key");
    expect(adminGetOrder.status).toBe(200);
    expect((await adminGetOrder.json()).id).toBe(pendingPayload.id);

    const outsiderCancelResponse = await authedJson(`/api/orders/${pendingPayload.id as string}`, outsider.apiKey, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoning: "attempt to cancel foreign order" }),
    });
    expect(outsiderCancelResponse.status).toBe(404);
    expect((await outsiderCancelResponse.json()).error.code).toBe("ORDER_NOT_FOUND");

    const outsiderGetOrder = await authedJson(`/api/orders/${pendingPayload.id as string}`, outsider.apiKey);
    expect(outsiderGetOrder.status).toBe(404);
    expect((await outsiderGetOrder.json()).error.code).toBe("ORDER_NOT_FOUND");

    const missingOrderCancel = await authedJson("/api/orders/ord_missing", owner.apiKey, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoning: "order does not exist" }),
    });
    expect(missingOrderCancel.status).toBe(404);
    expect((await missingOrderCancel.json()).error.code).toBe("ORDER_NOT_FOUND");

    await db.delete(tables.accounts).where(eq(tables.accounts.userId, outsider.userId)).run();
    const outsiderOrders = await authedJson("/api/orders", outsider.apiKey);
    expect(outsiderOrders.status).toBe(200);
    expect((await outsiderOrders.json()).orders).toEqual([]);

    const adminOrders = await authedJson("/api/orders", "admin_test_key");
    expect(adminOrders.status).toBe(200);
    expect(Array.isArray((await adminOrders.json()).orders)).toBe(true);
  });

  it("uses cancellation time in timeline for cancelled orders", async () => {
    const user = await registerUser("timeline-cancel-time-user");
    const historicalCreatedAt = "2025-01-01T00:00:00.000Z";

    await db
      .insert(tables.orders)
      .values({
        id: "ord_timeline_cancelled_at",
        accountId: user.account.id,
        market: "polymarket",
        symbol: "0x-timeline-cancelled-at",
        side: "buy",
        type: "limit",
        quantity: 1,
        limitPrice: 0.1,
        status: "pending",
        filledPrice: null,
        reasoning: "pending order for cancellation timeline test",
        cancelReasoning: null,
        cancelledAt: null,
        filledAt: null,
        createdAt: historicalCreatedAt,
      })
      .run();

    const cancelResponse = await authedJson("/api/orders/ord_timeline_cancelled_at", user.apiKey, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reasoning: "cancel for timeline timestamp verification" }),
    });
    expect(cancelResponse.status).toBe(200);

    const cancelledOrder = await db
      .select()
      .from(tables.orders)
      .where(eq(tables.orders.id, "ord_timeline_cancelled_at"))
      .get();
    const cancelledAt = cancelledOrder?.cancelledAt ?? null;
    expect(cancelledAt).toBeTruthy();
    if (cancelledAt) {
      expect(cancelledAt > historicalCreatedAt).toBe(true);
    }

    const timelineResponse = await authedJson("/api/account/timeline?limit=20&offset=0", user.apiKey);
    expect(timelineResponse.status).toBe(200);
    const timelinePayload = await timelineResponse.json();
    const cancelledEvent = timelinePayload.events.find(
      (event: { type: string; data?: { id?: string }; createdAt?: string }) =>
        event.type === "order.cancelled" && event.data?.id === "ord_timeline_cancelled_at",
    );
    expect(cancelledEvent).toBeTruthy();
    expect(cancelledEvent.createdAt).toBe(cancelledAt);

    const adminTimelineResponse = await authedJson(`/api/admin/users/${user.userId}/timeline?limit=20&offset=0`, "admin_test_key");
    expect(adminTimelineResponse.status).toBe(200);
    const adminTimelinePayload = await adminTimelineResponse.json();
    const adminCancelledEvent = adminTimelinePayload.events.find(
      (event: { type: string; data?: { id?: string; cancelledAt?: string | null; filledAt?: string | null }; createdAt?: string }) =>
        event.type === "order.cancelled" && event.data?.id === "ord_timeline_cancelled_at",
    );
    expect(adminCancelledEvent).toBeTruthy();
    expect(adminCancelledEvent.data.cancelledAt).toBe(cancelledAt);
    expect(adminCancelledEvent.data.filledAt).toBeNull();
    expect(adminCancelledEvent.createdAt).toBe(cancelledAt);
  });

  it("covers market order fills, portfolio values, positions visibility, and sqlite persistence", async () => {
    const owner = await registerUser("portfolio-owner");
    const outsider = await registerUser("portfolio-outsider");

    quoteBySymbol["0x-market-fill"] = { price: 0.52, bid: 0.51, ask: 0.52 };

    const orderResponse = await authedJson("/api/orders", owner.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-market-fill",
        side: "buy",
        type: "market",
        quantity: 20,
        reasoning: "Establish initial directional exposure",
      }),
    });
    expect(orderResponse.status).toBe(201);
    const orderPayload = await orderResponse.json();
    expect(orderPayload.status).toBe("filled");
    expect(orderPayload.filledPrice).toBe(0.52);

    const positionsResponse = await authedJson(`/api/positions`, owner.apiKey);
    expect(positionsResponse.status).toBe(200);
    const positionsPayload = await positionsResponse.json();
    expect(positionsPayload.positions).toHaveLength(1);
    expect(positionsPayload.positions[0].quantity).toBe(20);

    const outsiderPositions = await authedJson(`/api/positions`, outsider.apiKey);
    expect(outsiderPositions.status).toBe(200);
    expect((await outsiderPositions.json()).positions).toEqual([]);

    const portfolioResponse = await authedJson(`/api/account/portfolio`, owner.apiKey);
    expect(portfolioResponse.status).toBe(200);
    const portfolioPayload = await portfolioResponse.json();
    expect(portfolioPayload.positions).toHaveLength(1);
    expect(portfolioPayload.totalPnl).toBeCloseTo(0, 6);
    expect(portfolioPayload.totalFunding).toBe(0);
    expect(portfolioPayload.positions[0].accumulatedFunding).toBe(0);

    const expectedBalance = Number((INITIAL_BALANCE - 20 * 0.52).toFixed(6));
    expect(portfolioPayload.balance).toBeCloseTo(expectedBalance, 6);
    expect(portfolioPayload.totalValue).toBeCloseTo(expectedBalance + 20 * 0.52, 6);

    const orderRows = await db.select().from(tables.orders).where(eq(tables.orders.accountId, owner.account.id)).all();
    const tradeRows = await db.select().from(tables.trades).where(eq(tables.trades.accountId, owner.account.id)).all();
    const positionRows = await db.select().from(tables.positions).where(eq(tables.positions.accountId, owner.account.id)).all();
    const accountRows = await db.select().from(tables.accounts).where(eq(tables.accounts.id, owner.account.id)).all();

    expect(orderRows).toHaveLength(1);
    expect(orderRows[0]?.status).toBe("filled");
    expect(tradeRows).toHaveLength(1);
    expect(positionRows).toHaveLength(1);
    expect(accountRows[0]?.balance).toBeCloseTo(expectedBalance, 6);
  });

  it("includes funding payments in portfolio aggregation and timeline views", async () => {
    const user = await registerUser("funding-view-user");

    await db
      .insert(tables.positions)
      .values({
        id: "pos_funding_view",
        accountId: user.account.id,
        market: "funding-only",
        symbol: "BTC",
        quantity: 2,
        avgCost: 95_000,
      })
      .run();

    await db
      .insert(tables.fundingPayments)
      .values([
        {
          id: "fnd_credit",
          accountId: user.account.id,
          market: "funding-only",
          symbol: "BTC",
          quantity: 2,
          fundingRate: -0.0001,
          payment: 3.5,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "fnd_debit",
          accountId: user.account.id,
          market: "funding-only",
          symbol: "BTC",
          quantity: 2,
          fundingRate: 0.0002,
          payment: -1.25,
          createdAt: "2026-01-01T01:00:00.000Z",
        },
      ])
      .run();

    const portfolioResponse = await authedJson("/api/account/portfolio", user.apiKey);
    expect(portfolioResponse.status).toBe(200);
    const portfolioPayload = await portfolioResponse.json();
    expect(portfolioPayload.totalFunding).toBe(2.25);
    expect(portfolioPayload.positions).toHaveLength(1);
    expect(portfolioPayload.positions[0]).toMatchObject({
      market: "funding-only",
      symbol: "BTC",
      accumulatedFunding: 2.25,
    });

    const timelineResponse = await authedJson("/api/account/timeline?limit=20&offset=0", user.apiKey);
    expect(timelineResponse.status).toBe(200);
    const timelinePayload = await timelineResponse.json();
    const fundingEvent = timelinePayload.events.find(
      (event: { type: string; data?: { id?: string; payment?: number } }) =>
        event.type === "funding.applied" && event.data?.id === "fnd_debit",
    );
    expect(fundingEvent).toBeTruthy();
    expect(fundingEvent.data.payment).toBe(-1.25);

    const adminTimelineResponse = await authedJson(`/api/admin/users/${user.userId}/timeline?limit=20&offset=0`, "admin_test_key");
    expect(adminTimelineResponse.status).toBe(200);
    const adminTimelinePayload = await adminTimelineResponse.json();
    const adminFundingEvent = adminTimelinePayload.events.find(
      (event: { type: string; data?: { id?: string; payment?: number } }) =>
        event.type === "funding.applied" && event.data?.id === "fnd_debit",
    );
    expect(adminFundingEvent).toBeTruthy();
    expect(adminFundingEvent.data.payment).toBe(-1.25);
  });

  it("surfaces liquidations as dedicated timeline events and hides the backing filled order", async () => {
    const user = await registerUser("liquidation-timeline-user");

    await db
      .insert(tables.orders)
      .values({
        id: "ord_liq_timeline",
        accountId: user.account.id,
        market: "funding-only",
        symbol: "BTC",
        side: "sell",
        type: "market",
        quantity: 2,
        limitPrice: null,
        status: "filled",
        filledPrice: 93_500,
        reasoning: "Auto-liquidation: maintenance margin breached (...)",
        cancelReasoning: null,
        cancelledAt: null,
        filledAt: "2026-01-01T02:00:00.000Z",
        createdAt: "2026-01-01T02:00:00.000Z",
      })
      .run();

    await db
      .insert(tables.liquidations)
      .values({
        id: "liq_timeline",
        orderId: "ord_liq_timeline",
        accountId: user.account.id,
        market: "funding-only",
        symbol: "BTC",
        side: "sell",
        quantity: 2,
        leverage: 10,
        margin: 20,
        maintenanceMarginRatio: 0.05,
        triggerPrice: 94_500,
        executionPrice: 93_500,
        triggerPositionEquity: 9,
        maintenanceMargin: 9.45,
        grossPayout: 7,
        feeCharged: 0,
        netPayout: 7,
        reasoning: "Auto-liquidation: maintenance margin breached (triggerPrice=94500, executionPrice=93500)",
        cancelledReduceOnlyOrderIds: JSON.stringify(["ord_reduce_only"]),
        createdAt: "2026-01-01T02:00:00.000Z",
      })
      .run();

    const timelineResponse = await authedJson("/api/account/timeline?limit=20&offset=0", user.apiKey);
    expect(timelineResponse.status).toBe(200);
    const timelinePayload = await timelineResponse.json();
    const liquidationEvent = timelinePayload.events.find(
      (event: { type: string; data?: { id?: string; netPayout?: number; cancelledReduceOnlyOrderIds?: string[] } }) =>
        event.type === "position.liquidated" && event.data?.id === "liq_timeline",
    );
    expect(liquidationEvent).toBeTruthy();
    expect(liquidationEvent.data.netPayout).toBe(7);
    expect(liquidationEvent.data.cancelledReduceOnlyOrderIds).toEqual(["ord_reduce_only"]);
    expect(
      timelinePayload.events.some(
        (event: { type: string; data?: { id?: string } }) => event.type === "order" && event.data?.id === "ord_liq_timeline",
      ),
    ).toBe(false);

    const adminTimelineResponse = await authedJson(`/api/admin/users/${user.userId}/timeline?limit=20&offset=0`, "admin_test_key");
    expect(adminTimelineResponse.status).toBe(200);
    const adminTimelinePayload = await adminTimelineResponse.json();
    expect(
      adminTimelinePayload.events.some(
        (event: { type: string; data?: { id?: string } }) => event.type === "position.liquidated" && event.data?.id === "liq_timeline",
      ),
    ).toBe(true);
  });

  it("covers portfolio adapter-missing branch and journal tag deserialization fallback", async () => {
    const user = await registerUser("portfolio-fallback-user");

    await db
      .insert(tables.positions)
      .values({
        id: "pos_missing_adapter",
        accountId: user.account.id,
        market: "missing-market",
        symbol: "0x-ghost",
        quantity: 3,
        avgCost: 0.2,
      })
      .run();

    const portfolioResponse = await authedJson(`/api/account/portfolio`, user.apiKey);
    expect(portfolioResponse.status).toBe(200);
    const portfolioPayload = await portfolioResponse.json();
    expect(portfolioPayload.positions).toEqual([]);
    expect(portfolioPayload.totalValue).toBe(INITIAL_BALANCE);

    await db
      .insert(tables.journal)
      .values({
        id: "jrn_invalid_tags",
        userId: user.userId,
        content: "manual row with malformed tags payload",
        tags: "not-a-json-array",
        createdAt: new Date().toISOString(),
      })
      .run();

    const journalResponse = await authedJson("/api/journal", user.apiKey);
    expect(journalResponse.status).toBe(200);
    const journalPayload = await journalResponse.json();
    expect(journalPayload.entries[0]?.tags).toEqual([]);
  });

  it("reconciles pending limit orders globally across accounts", async () => {
    const userA = await registerUser("reconcile-a");
    const userB = await registerUser("reconcile-b");

    quoteBySymbol["0x-reconcile-a"] = { price: 0.71, bid: 0.7, ask: 0.71 };
    quoteBySymbol["0x-reconcile-b"] = { price: 0.72, bid: 0.71, ask: 0.72 };

    const pendingA = await authedJson("/api/orders", userA.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-reconcile-a",
        side: "buy",
        type: "limit",
        quantity: 10,
        limitPrice: 0.5,
        reasoning: "Wait for improved entry",
      }),
    });
    expect(pendingA.status).toBe(201);
    const pendingAPayload = await pendingA.json();
    expect(pendingAPayload.status).toBe("pending");

    const pendingB = await authedJson("/api/orders", userB.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-reconcile-b",
        side: "buy",
        type: "limit",
        quantity: 12,
        limitPrice: 0.5,
        reasoning: "Wait for improved entry",
      }),
    });
    expect(pendingB.status).toBe(201);

    const initialReconcile = await reconcilePendingOrders(registry);
    expect(initialReconcile.filled).toBe(0);

    quoteBySymbol["0x-reconcile-a"] = { price: 0.45, bid: 0.44, ask: 0.45 };
    quoteBySymbol["0x-reconcile-b"] = { price: 0.46, bid: 0.45, ask: 0.46 };

    const reconcileResult = await reconcilePendingOrders(registry);
    expect(reconcileResult.processed).toBeGreaterThanOrEqual(2);
    expect(reconcileResult.filled).toBe(2);
    expect(reconcileResult.filledOrderIds).toEqual(
      expect.arrayContaining([pendingAPayload.id as string]),
    );

    const filledOrdersA = await authedJson(`/api/orders?status=filled`, userA.apiKey);
    expect(filledOrdersA.status).toBe(200);
    expect((await filledOrdersA.json()).orders).toHaveLength(1);

    const filledOrdersB = await authedJson(`/api/orders?status=filled`, userB.apiKey);
    expect(filledOrdersB.status).toBe(200);
    expect((await filledOrdersB.json()).orders).toHaveLength(1);
  });

  it("batches quote requests by market and symbol during reconciliation", async () => {
    const user = await registerUser("reconcile-batch-user");
    quoteBySymbol["0x-reconcile-batch"] = { price: 0.8, bid: 0.79, ask: 0.8 };

    const pendingOne = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-reconcile-batch",
        side: "buy",
        type: "limit",
        quantity: 3,
        limitPrice: 0.5,
        reasoning: "batch reconcile pending one",
      }),
    });
    expect(pendingOne.status).toBe(201);
    expect((await pendingOne.json()).status).toBe("pending");

    const pendingTwo = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-reconcile-batch",
        side: "buy",
        type: "limit",
        quantity: 4,
        limitPrice: 0.5,
        reasoning: "batch reconcile pending two",
      }),
    });
    expect(pendingTwo.status).toBe(201);
    expect((await pendingTwo.json()).status).toBe("pending");

    quoteBySymbol["0x-reconcile-batch"] = { price: 0.45, bid: 0.44, ask: 0.45 };
    const originalGetQuote = polymarketAdapter.getQuote;
    const quoteSpy = vi.spyOn(polymarketAdapter, "getQuote").mockImplementation(async (symbol) => originalGetQuote(symbol));

    const reconcilePayload = await reconcilePendingOrders(registry);
    expect(reconcilePayload.filled).toBe(2);

    const batchSymbolCalls = quoteSpy.mock.calls.filter(([symbol]) => symbol === "0x-reconcile-batch");
    expect(batchSymbolCalls).toHaveLength(1);

    const filledOrders = await authedJson("/api/orders?status=filled", user.apiKey);
    expect(filledOrders.status).toBe(200);
    expect((await filledOrders.json()).orders).toHaveLength(2);
  });

  it("covers reconcile edge branches for skipped paths and empty targets", async () => {
    expect(await reconcilePendingOrders(registry)).toMatchObject({
      processed: 0,
      filled: 0,
      cancelled: 0,
      skipped: 0,
      cancelledOrderIds: [],
    });

    const user = await registerUser("reconcile-skips");
    const createdAt = new Date().toISOString();

    await db
      .insert(tables.orders)
      .values({
        id: "ord_skip_type",
        accountId: user.account.id,
        market: "polymarket",
        symbol: "0x-skip-type",
        side: "buy",
        type: "market",
        quantity: 1,
        limitPrice: null,
        status: "pending",
        filledPrice: null,
        reasoning: "manually inserted pending market order",
        cancelReasoning: null,
        filledAt: null,
        createdAt,
      })
      .run();

    await db
      .insert(tables.orders)
      .values({
        id: "ord_skip_adapter",
        accountId: user.account.id,
        market: "missing-market",
        symbol: "0x-skip-adapter",
        side: "buy",
        type: "limit",
        quantity: 1,
        limitPrice: 0.5,
        status: "pending",
        filledPrice: null,
        reasoning: "missing adapter should be skipped",
        cancelReasoning: null,
        filledAt: null,
        createdAt,
      })
      .run();

    await db
      .insert(tables.orders)
      .values({
        id: "ord_skip_quote",
        accountId: user.account.id,
        market: "polymarket",
        symbol: "0x-skip-quote",
        side: "buy",
        type: "limit",
        quantity: 1,
        limitPrice: 0.5,
        status: "pending",
        filledPrice: null,
        reasoning: "quote throw should be skipped",
        cancelReasoning: null,
        filledAt: null,
        createdAt,
      })
      .run();

    await db
      .insert(tables.orders)
      .values({
        id: "ord_skip_missing_account",
        accountId: "acc_missing",
        market: "polymarket",
        symbol: "0x-skip-missing-account",
        side: "buy",
        type: "limit",
        quantity: 1,
        limitPrice: 0.5,
        status: "pending",
        filledPrice: null,
        reasoning: "missing account should be skipped",
        cancelReasoning: null,
        filledAt: null,
        createdAt,
      })
      .run();

    await db
      .insert(tables.orders)
      .values({
        id: "ord_skip_fill_error",
        accountId: user.account.id,
        market: "polymarket",
        symbol: "0x-skip-fill-error",
        side: "buy",
        type: "limit",
        quantity: 10_000_000,
        limitPrice: 0.99,
        status: "pending",
        filledPrice: null,
        reasoning: "fill execution should fail with insufficient balance",
        cancelReasoning: null,
        filledAt: null,
        createdAt,
      })
      .run();

    await db
      .insert(tables.orders)
      .values({
        id: "ord_skip_404",
        accountId: user.account.id,
        market: "polymarket",
        symbol: "0x-skip-404",
        side: "buy",
        type: "limit",
        quantity: 1,
        limitPrice: 0.5,
        status: "pending",
        filledPrice: null,
        reasoning: "upstream 404 should auto-cancel",
        cancelReasoning: null,
        cancelledAt: null,
        filledAt: null,
        createdAt,
      })
      .run();

    quoteBySymbol["0x-skip-fill-error"] = { price: 0.6, bid: 0.59, ask: 0.6 };
    quoteBySymbol["0x-skip-missing-account"] = { price: 0.4, bid: 0.39, ask: 0.4 };
    quoteBySymbol["0x-skip-quote"] = { price: 0.4, bid: 0.39, ask: 0.4 };

    const originalGetQuote = polymarketAdapter.getQuote;
    vi.spyOn(polymarketAdapter, "getQuote").mockImplementation(async (symbol) => {
      if (symbol === "0x-skip-404") {
        throw new Error("Upstream request failed (404): https://example/book?token_id=0x-skip-404");
      }
      if (symbol === "0x-skip-quote") {
        throw new Error("quote retrieval failed");
      }
      return originalGetQuote(symbol);
    });

    const reconcilePayload = await reconcilePendingOrders(registry);
    expect(reconcilePayload.processed).toBeGreaterThanOrEqual(5);
    expect(reconcilePayload.filled).toBe(0);
    expect(reconcilePayload.skipped).toBeGreaterThanOrEqual(4);
    expect(reconcilePayload.cancelled).toBeGreaterThanOrEqual(1);
    expect(reconcilePayload.cancelledOrderIds).toContain("ord_skip_404");

    const autoCancelledOrder = await db.select().from(tables.orders).where(eq(tables.orders.id, "ord_skip_404")).get();
    expect(autoCancelledOrder?.status).toBe("cancelled");
    expect(autoCancelledOrder?.cancelledAt).toBeTruthy();
  });

  it("covers admin-only fund management and overview aggregation", async () => {
    const user = await registerUser("admin-overview-user");

    const removedAccountRoute = await authedJson(`/api/admin/accounts/${user.account.id}/deposit`, "admin_test_key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 100 }),
    });
    expect(removedAccountRoute.status).toBe(404);
    expect((await removedAccountRoute.json()).error.code).toBe("NOT_FOUND");

    const userAccessAdminEndpoint = await authedJson(`/api/admin/users/${user.userId}/deposit`, user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 100 }),
    });
    expect(userAccessAdminEndpoint.status).toBe(403);
    expect((await userAccessAdminEndpoint.json()).error.code).toBe("FORBIDDEN");

    const depositResponse = await authedJson(`/api/admin/users/${user.userId}/deposit`, "admin_test_key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 250 }),
    });
    expect(depositResponse.status).toBe(200);
    expect((await depositResponse.json()).balance).toBeCloseTo(INITIAL_BALANCE + 250, 6);

    const withdrawResponse = await authedJson(`/api/admin/users/${user.userId}/withdraw`, "admin_test_key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 100 }),
    });
    expect(withdrawResponse.status).toBe(200);
    expect((await withdrawResponse.json()).balance).toBeCloseTo(INITIAL_BALANCE + 150, 6);

    const overdrawResponse = await authedJson(`/api/admin/users/${user.userId}/withdraw`, "admin_test_key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: INITIAL_BALANCE * 10 }),
    });
    expect(overdrawResponse.status).toBe(400);
    expect((await overdrawResponse.json()).error.code).toBe("INSUFFICIENT_BALANCE");

    const placeOrderResponse = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-market-fill",
        side: "buy",
        type: "market",
        quantity: 5,
        reasoning: "Seed position for overview aggregation",
      }),
    });
    expect(placeOrderResponse.status).toBe(201);

    const overviewResponse = await authedJson("/api/admin/overview", "admin_test_key");
    expect(overviewResponse.status).toBe(200);
    const overviewPayload = await overviewResponse.json();
    expect(overviewPayload.totals.users).toBe(1);
    expect(Array.isArray(overviewPayload.markets)).toBe(true);
    expect(Array.isArray(overviewPayload.agents)).toBe(true);
    expect(
      overviewPayload.agents.some((agent: { userId: string }) => agent.userId === user.userId),
    ).toBe(true);

    const indexListResult = await sqlite.execute("PRAGMA index_list('positions')");
    const hasUniqueIndex = indexListResult.rows.some((row) => {
      const typed = row as Record<string, unknown>;
      return typed.name === "positions_unique_idx";
    });
    expect(hasUniqueIndex).toBe(true);
  });

  it("covers admin trader creation, portfolio views, and idempotent order placement", async () => {
    const createTraderResponse = await authedJson("/api/admin/traders", "admin_test_key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userName: "dashboard-admin-trader" }),
    });
    expect(createTraderResponse.status).toBe(201);
    const createdTrader = await createTraderResponse.json() as {
      userId: string;
      userName: string;
      accountId: string;
      balance: number;
    };
    expect(createdTrader.userName).toBe("dashboard-admin-trader");
    expect(createdTrader.balance).toBe(INITIAL_BALANCE);

    const createdUsers = await db.select().from(tables.users).where(eq(tables.users.id, createdTrader.userId)).all();
    const createdAccounts = await db.select().from(tables.accounts).where(eq(tables.accounts.id, createdTrader.accountId)).all();
    expect(createdUsers).toHaveLength(1);
    expect(createdAccounts).toHaveLength(1);
    expect(createdAccounts[0]?.balance).toBe(INITIAL_BALANCE);

    const initialPortfolioResponse = await authedJson(
      `/api/admin/users/${createdTrader.userId}/portfolio`,
      "admin_test_key",
    );
    expect(initialPortfolioResponse.status).toBe(200);
    const initialPortfolioPayload = await initialPortfolioResponse.json() as {
      accountId: string;
      openOrders: unknown[];
      positions: unknown[];
      recentOrders: unknown[];
      balance: number;
    };
    expect(initialPortfolioPayload.accountId).toBe(createdTrader.accountId);
    expect(initialPortfolioPayload.balance).toBe(INITIAL_BALANCE);
    expect(initialPortfolioPayload.openOrders).toEqual([]);
    expect(initialPortfolioPayload.positions).toEqual([]);
    expect(initialPortfolioPayload.recentOrders).toEqual([]);

    const mismatchedAccountOrder = await authedJson(`/api/admin/users/${createdTrader.userId}/orders`, "admin_test_key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: "acc_wrong_target",
        market: "polymarket",
        symbol: "0x-market-fill",
        side: "buy",
        type: "market",
        quantity: 1,
        reasoning: "mismatched account id should be rejected",
      }),
    });
    expect(mismatchedAccountOrder.status).toBe(404);
    expect((await mismatchedAccountOrder.json()).error.code).toBe("ACCOUNT_NOT_FOUND");

    const initialAdminOrder = await authedJson(`/api/admin/users/${createdTrader.userId}/orders`, "admin_test_key", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "admin-order-idem-1",
      },
      body: JSON.stringify({
        accountId: createdTrader.accountId,
        market: "polymarket",
        symbol: "alias-fill",
        side: "buy",
        type: "market",
        quantity: 2,
        reasoning: "admin dashboard test order",
      }),
    });
    expect(initialAdminOrder.status).toBe(201);
    const initialAdminOrderPayload = await initialAdminOrder.json() as {
      id: string;
      symbol: string;
      status: string;
      filledPrice: number;
    };
    expect(initialAdminOrderPayload.symbol).toBe("0x-market-fill");
    expect(initialAdminOrderPayload.status).toBe("filled");
    expect(initialAdminOrderPayload.filledPrice).toBe(0.52);

    const replayedAdminOrder = await authedJson(`/api/admin/users/${createdTrader.userId}/orders`, "admin_test_key", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "admin-order-idem-1",
      },
      body: JSON.stringify({
        accountId: createdTrader.accountId,
        market: "polymarket",
        symbol: "alias-fill",
        side: "buy",
        type: "market",
        quantity: 2,
        reasoning: "admin dashboard test order",
      }),
    });
    expect(replayedAdminOrder.status).toBe(201);
    expect(replayedAdminOrder.headers.get("x-idempotent-replay")).toBe("true");
    const replayedAdminOrderPayload = await replayedAdminOrder.json() as { id: string };
    expect(replayedAdminOrderPayload.id).toBe(initialAdminOrderPayload.id);

    const conflictingReplay = await authedJson(`/api/admin/users/${createdTrader.userId}/orders`, "admin_test_key", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "admin-order-idem-1",
      },
      body: JSON.stringify({
        accountId: createdTrader.accountId,
        market: "polymarket",
        symbol: "alias-fill",
        side: "buy",
        type: "market",
        quantity: 3,
        reasoning: "same key different payload should conflict",
      }),
    });
    expect(conflictingReplay.status).toBe(409);
    expect((await conflictingReplay.json()).error.code).toBe("IDEMPOTENCY_KEY_CONFLICT");

    const orderRows = await db
      .select()
      .from(tables.orders)
      .where(eq(tables.orders.accountId, createdTrader.accountId))
      .all();
    const tradeRows = await db
      .select()
      .from(tables.trades)
      .where(eq(tables.trades.accountId, createdTrader.accountId))
      .all();
    expect(orderRows).toHaveLength(1);
    expect(tradeRows).toHaveLength(1);

    const filledExecutionParams = await db
      .select()
      .from(tables.orderExecutionParams)
      .where(eq(tables.orderExecutionParams.orderId, initialAdminOrderPayload.id))
      .all();
    expect(filledExecutionParams).toHaveLength(1);
    expect(filledExecutionParams[0]?.leverage).toBe(1);
    expect(filledExecutionParams[0]?.reduceOnly).toBe(false);

    const updatedPortfolioResponse = await authedJson(
      `/api/admin/users/${createdTrader.userId}/portfolio`,
      "admin_test_key",
    );
    expect(updatedPortfolioResponse.status).toBe(200);
    const updatedPortfolioPayload = await updatedPortfolioResponse.json() as {
      openOrders: Array<{ id: string; symbol: string; status: string }>;
      positions: Array<{ symbol: string; quantity: number; currentPrice: number | null }>;
      recentOrders: Array<{ id: string; symbol: string; status: string }>;
      balance: number;
    };
    expect(updatedPortfolioPayload.openOrders).toEqual([]);
    expect(updatedPortfolioPayload.positions).toHaveLength(1);
    expect(updatedPortfolioPayload.positions[0]).toMatchObject({
      symbol: "0x-market-fill",
      quantity: 2,
      currentPrice: 0.52,
    });
    expect(updatedPortfolioPayload.recentOrders[0]).toMatchObject({
      id: initialAdminOrderPayload.id,
      symbol: "0x-market-fill",
      status: "filled",
    });
    expect(updatedPortfolioPayload.balance).toBeCloseTo(INITIAL_BALANCE - 1.04, 6);

    const pendingAdminOrder = await authedJson(`/api/admin/users/${createdTrader.userId}/orders`, "admin_test_key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        accountId: createdTrader.accountId,
        market: "polymarket",
        symbol: "0x-pending",
        side: "buy",
        type: "limit",
        quantity: 1,
        limitPrice: 0.5,
        reasoning: "admin pending order should persist execution params",
      }),
    });
    expect(pendingAdminOrder.status).toBe(201);
    const pendingAdminOrderPayload = await pendingAdminOrder.json() as { id: string; status: string };
    expect(pendingAdminOrderPayload.status).toBe("pending");

    const pendingExecutionParams = await db
      .select()
      .from(tables.orderExecutionParams)
      .where(eq(tables.orderExecutionParams.orderId, pendingAdminOrderPayload.id))
      .all();
    expect(pendingExecutionParams).toHaveLength(1);
    expect(pendingExecutionParams[0]?.leverage).toBe(1);
    expect(pendingExecutionParams[0]?.reduceOnly).toBe(false);

    const pendingPortfolioResponse = await authedJson(
      `/api/admin/users/${createdTrader.userId}/portfolio`,
      "admin_test_key",
    );
    expect(pendingPortfolioResponse.status).toBe(200);
    const pendingPortfolioPayload = await pendingPortfolioResponse.json() as {
      openOrders: Array<{ id: string; symbol: string; status: string }>;
    };
    expect(pendingPortfolioPayload.openOrders).toHaveLength(1);
    expect(pendingPortfolioPayload.openOrders[0]).toMatchObject({
      id: pendingAdminOrderPayload.id,
      symbol: "0x-pending",
      status: "pending",
    });
  });

  it("keeps admin overview read-only and records equity snapshots via the worker service", async () => {
    const user = await registerUser("overview-snapshot-user");

    const initialSnapshotRows = await db.select().from(tables.equitySnapshots).all();
    expect(initialSnapshotRows).toHaveLength(0);

    const overviewResponse = await authedJson("/api/admin/overview", "admin_test_key");
    expect(overviewResponse.status).toBe(200);

    const afterOverviewRows = await db.select().from(tables.equitySnapshots).all();
    expect(afterOverviewRows).toHaveLength(0);

    const firstSnapshotRun = await recordEquitySnapshots(registry);
    expect(firstSnapshotRun).toEqual({ created: 1, skipped: 0 });

    const createdSnapshotRows = await db.select().from(tables.equitySnapshots).all();
    expect(createdSnapshotRows).toHaveLength(1);
    expect(createdSnapshotRows[0]?.userId).toBe(user.userId);

    const secondSnapshotRun = await recordEquitySnapshots(registry);
    expect(secondSnapshotRun).toEqual({ created: 0, skipped: 1 });
  });

  it("caches resolved symbol metadata for admin overview and timeline responses", async () => {
    const user = await registerUser("admin-symbol-cache-user");
    quoteBySymbol["0x-meta-no"] = { price: 0.44, bid: 0.43, ask: 0.44 };

    const orderResponse = await authedJson("/api/orders", user.apiKey, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: "polymarket",
        symbol: "0x-meta-no",
        side: "buy",
        type: "market",
        quantity: 2,
        reasoning: "seed symbol metadata cache",
      }),
    });
    expect(orderResponse.status).toBe(201);

    const resolveSpy = vi.spyOn(polymarketAdapter, "resolveSymbolNames");

    const firstOverviewResponse = await authedJson("/api/admin/overview", "admin_test_key");
    expect(firstOverviewResponse.status).toBe(200);
    const firstOverviewPayload = await firstOverviewResponse.json();

    const firstAgent = firstOverviewPayload.agents.find((agent: { userId: string }) => agent.userId === user.userId);
    const firstPosition = firstAgent?.positions?.find((position: { symbol: string }) => position.symbol === "0x-meta-no");
    expect(firstPosition?.symbolName).toBe("Resolved 0x-meta-no");
    expect(firstPosition?.side).toBe("No");
    expect(resolveSpy).toHaveBeenCalled();

    const cachedRows = await db
      .select()
      .from(tables.symbolMetadataCache)
      .where(eq(tables.symbolMetadataCache.symbol, "0x-meta-no"))
      .all();
    expect(cachedRows).toHaveLength(1);
    expect(cachedRows[0]?.symbolName).toBe("Resolved 0x-meta-no");
    expect(cachedRows[0]?.outcome).toBe("No");

    resolveSpy.mockImplementation(async () => {
      throw new Error("symbol resolver unavailable");
    });

    const secondOverviewResponse = await authedJson("/api/admin/overview", "admin_test_key");
    expect(secondOverviewResponse.status).toBe(200);
    const secondOverviewPayload = await secondOverviewResponse.json();
    const secondAgent = secondOverviewPayload.agents.find((agent: { userId: string }) => agent.userId === user.userId);
    const secondPosition = secondAgent?.positions?.find((position: { symbol: string }) => position.symbol === "0x-meta-no");
    expect(secondPosition?.symbolName).toBe("Resolved 0x-meta-no");
    expect(secondPosition?.side).toBe("No");

    const timelineResponse = await authedJson(`/api/admin/users/${user.userId}/timeline?limit=20&offset=0`, "admin_test_key");
    expect(timelineResponse.status).toBe(200);
    const timelinePayload = await timelineResponse.json();
    const orderEvent = timelinePayload.events.find(
      (event: { type: string; data?: { symbol?: string; symbolName?: string | null } }) =>
        event.type === "order" && event.data?.symbol === "0x-meta-no",
    );
    expect(orderEvent?.data?.symbolName).toBe("Resolved 0x-meta-no — No");
  });

  it("covers admin fund endpoint invalid-json and account-not-found branches", async () => {
    const user = await registerUser("admin-fund-edge");

    const invalidJsonDeposit = await authedJson(`/api/admin/users/${user.userId}/deposit`, "admin_test_key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid",
    });
    expect(invalidJsonDeposit.status).toBe(400);
    expect((await invalidJsonDeposit.json()).error.code).toBe("INVALID_JSON");

    const invalidAmountDeposit = await authedJson(`/api/admin/users/${user.userId}/deposit`, "admin_test_key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: -1 }),
    });
    expect(invalidAmountDeposit.status).toBe(400);
    expect((await invalidAmountDeposit.json()).error.code).toBe("INVALID_INPUT");

    const missingAccountDeposit = await authedJson("/api/admin/users/usr_missing/deposit", "admin_test_key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 10 }),
    });
    expect(missingAccountDeposit.status).toBe(404);
    expect((await missingAccountDeposit.json()).error.code).toBe("ACCOUNT_NOT_FOUND");

    const missingAccountWithdraw = await authedJson("/api/admin/users/usr_missing/withdraw", "admin_test_key", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 10 }),
    });
    expect(missingAccountWithdraw.status).toBe(404);
    expect((await missingAccountWithdraw.json()).error.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("covers admin overview branches for missing user, missing adapter, quote failure, and shared quote keys", async () => {
    const userA = await registerUser("overview-user-a");
    const userB = await registerUser("overview-user-b");

    const createdAt = new Date().toISOString();
    await db
      .insert(tables.positions)
      .values({
        id: "pos_shared_a",
        accountId: userA.account.id,
        market: "polymarket",
        symbol: "0x-shared",
        quantity: 3,
        avgCost: 0.4,
      })
      .run();

    await db
      .insert(tables.positions)
      .values({
        id: "pos_shared_b",
        accountId: userB.account.id,
        market: "polymarket",
        symbol: "0x-shared",
        quantity: 4,
        avgCost: 0.45,
      })
      .run();

    await db
      .insert(tables.positions)
      .values({
        id: "pos_quote_fail",
        accountId: userA.account.id,
        market: "polymarket",
        symbol: "0x-overview-quote-fail",
        quantity: 2,
        avgCost: 0.5,
      })
      .run();

    await db
      .insert(tables.accounts)
      .values({
        id: "acc_orphan",
        userId: "usr_orphan",
        balance: 123,
        name: "orphan-account",
        reasoning: "manual orphan account row",
        createdAt,
      })
      .run();

    await db
      .insert(tables.positions)
      .values({
        id: "pos_orphan_missing_adapter",
        accountId: "acc_orphan",
        market: "missing-market",
        symbol: "0x-orphan",
        quantity: 1,
        avgCost: 0.1,
      })
      .run();

    quoteBySymbol["0x-shared"] = { price: 0.56, bid: 0.55, ask: 0.56 };
    const originalGetQuote = polymarketAdapter.getQuote;
    vi.spyOn(polymarketAdapter, "getQuote").mockImplementation(async (symbol) => {
      if (symbol === "0x-overview-quote-fail") {
        throw new Error("overview quote failure");
      }
      return originalGetQuote(symbol);
    });

    const overviewResponse = await authedJson("/api/admin/overview", "admin_test_key");
    expect(overviewResponse.status).toBe(200);
    const overviewPayload = await overviewResponse.json();
    expect(overviewPayload.totals.users).toBeGreaterThanOrEqual(2);
    expect(
      overviewPayload.markets.some((market: { marketId: string; unpricedPositions: number }) => {
        return market.marketId === "missing-market" && market.unpricedPositions >= 1;
      }),
    ).toBe(true);
    expect(
      overviewPayload.markets.some((market: { marketId: string; quotedPositions: number }) => {
        return market.marketId === "polymarket" && market.quotedPositions >= 1;
      }),
    ).toBe(true);
  });

  it("persists register-created user/account/api-key rows in sqlite", async () => {
    const user = await registerUser("sqlite-persistence-user");

    const userRows = await db.select().from(tables.users).where(eq(tables.users.id, user.userId)).all();
    const accountRows = await db.select().from(tables.accounts).where(eq(tables.accounts.id, user.account.id)).all();
    const keyRows = await db.select().from(tables.apiKeys).where(eq(tables.apiKeys.userId, user.userId)).all();

    expect(userRows).toHaveLength(1);
    expect(accountRows).toHaveLength(1);
    expect(accountRows[0]?.balance).toBe(INITIAL_BALANCE);
    expect(keyRows).toHaveLength(1);
    expect(keyRows[0]?.revokedAt).toBeNull();
  });
});
