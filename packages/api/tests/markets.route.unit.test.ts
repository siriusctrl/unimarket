import { MarketAdapterError } from "@unimarket/markets";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createMarketRoutes } from "../src/routes/markets.js";

const makeApp = (registry: { list: () => unknown[]; get: (marketId: string) => unknown }) => {
  const app = new Hono();
  app.route("/markets", createMarketRoutes(registry as never));
  return app;
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createMarketRoutes", () => {
  it("lists markets and returns adapter-specific or default trading constraints", async () => {
    const typedAdapter = {
      capabilities: ["search"],
      getTradingConstraints: vi.fn().mockResolvedValue({
        minQuantity: 0.01,
        quantityStep: 0.01,
        supportsFractional: true,
        maxLeverage: 5,
      }),
    };
    const plainAdapter = { capabilities: ["search"] };
    const registry = {
      list: () => [{ id: "typed", name: "Typed" }, { id: "plain", name: "Plain" }],
      get: (marketId: string) => (marketId === "typed" ? typedAdapter : marketId === "plain" ? plainAdapter : undefined),
    };
    const app = makeApp(registry);

    const listRes = await app.request("/markets");
    expect(listRes.status).toBe(200);
    await expect(listRes.json()).resolves.toEqual({ markets: registry.list() });

    const typedRes = await app.request("/markets/typed/trading-constraints?reference=BTC");
    await expect(typedRes.json()).resolves.toEqual({
      reference: "BTC",
      constraints: { minQuantity: 0.01, quantityStep: 0.01, supportsFractional: true, maxLeverage: 5 },
    });

    const plainRes = await app.request("/markets/plain/trading-constraints?reference=YES");
    await expect(plainRes.json()).resolves.toEqual({
      reference: "YES",
      constraints: { minQuantity: 1, quantityStep: 1, supportsFractional: false, maxLeverage: null },
    });
  });

  it("returns missing-market and capability errors consistently", async () => {
    const browseOnly = { capabilities: ["browse"], browse: vi.fn().mockResolvedValue([]) };
    const quoteOnly = { capabilities: ["quote"], getQuote: vi.fn().mockResolvedValue({ price: 1 }) };
    const registry = {
      list: () => [],
      get: (marketId: string) => {
        if (marketId === "browse") return browseOnly;
        if (marketId === "quote") return quoteOnly;
        return undefined;
      },
    };
    const app = makeApp(registry);

    const missing = await app.request("/markets/missing/quote?reference=BTC");
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "MARKET_NOT_FOUND" } });

    const browse = await app.request("/markets/quote/browse?sort=price");
    expect(browse.status).toBe(400);
    await expect(browse.json()).resolves.toMatchObject({ error: { code: "CAPABILITY_NOT_SUPPORTED" } });

    const funding = await app.request("/markets/browse/funding?reference=BTC");
    expect(funding.status).toBe(400);
    await expect(funding.json()).resolves.toMatchObject({ error: { code: "CAPABILITY_NOT_SUPPORTED" } });

    const resolve = await app.request("/markets/quote/resolve?reference=BTC");
    expect(resolve.status).toBe(400);
    await expect(resolve.json()).resolves.toMatchObject({ error: { code: "CAPABILITY_NOT_SUPPORTED" } });
  });

  it("maps batch quote, orderbook, and funding errors per reference", async () => {
    const adapter = {
      capabilities: ["quote", "orderbook", "funding"],
      getQuote: vi.fn(async (reference: string) => {
        if (reference === "btc") return { reference, price: 100 };
        if (reference === "eth") throw new MarketAdapterError("SYMBOL_NOT_FOUND", "missing eth");
        throw new Error("quote exploded");
      }),
      getOrderbook: vi.fn(async (reference: string) => {
        if (reference === "btc") return { reference, bids: [], asks: [], timestamp: "2026-03-07T00:00:00.000Z" };
        if (reference === "eth") throw new MarketAdapterError("UPSTREAM_TIMEOUT", "slow book");
        throw "weird";
      }),
      getFundingRate: vi.fn(async (reference: string) => {
        if (reference === "btc") return { reference, rate: 0.01, nextFundingAt: "2026-03-07T01:00:00.000Z", timestamp: "2026-03-07T00:00:00.000Z" };
        if (reference === "eth") throw new MarketAdapterError("SYMBOL_NOT_FOUND", "missing funding");
        throw new Error("funding exploded");
      }),
    };
    const registry = { list: () => [], get: () => adapter };
    const app = makeApp(registry);

    const quotes = await app.request("/markets/mock/quotes?references=btc,eth,sol");
    await expect(quotes.json()).resolves.toEqual({
      quotes: [{ reference: "btc", price: 100 }],
      errors: [
        { reference: "eth", error: { code: "SYMBOL_NOT_FOUND", message: "missing eth" } },
        { reference: "sol", error: { code: "INTERNAL_ERROR", message: "quote exploded" } },
      ],
    });

    const orderbooks = await app.request("/markets/mock/orderbooks?references=btc,eth,sol");
    await expect(orderbooks.json()).resolves.toEqual({
      orderbooks: [{ reference: "btc", bids: [], asks: [], timestamp: "2026-03-07T00:00:00.000Z" }],
      errors: [
        { reference: "eth", error: { code: "UPSTREAM_TIMEOUT", message: "slow book" } },
        { reference: "sol", error: { code: "INTERNAL_ERROR", message: "Unknown server error" } },
      ],
    });

    const fundings = await app.request("/markets/mock/fundings?references=btc,eth,sol");
    await expect(fundings.json()).resolves.toEqual({
      fundings: [{ reference: "btc", rate: 0.01, nextFundingAt: "2026-03-07T01:00:00.000Z", timestamp: "2026-03-07T00:00:00.000Z" }],
      errors: [
        { reference: "eth", error: { code: "SYMBOL_NOT_FOUND", message: "missing funding" } },
        { reference: "sol", error: { code: "INTERNAL_ERROR", message: "funding exploded" } },
      ],
    });
  });

  it("returns unresolved defaults and validates malformed query payloads", async () => {
    const adapter = {
      capabilities: ["resolve", "search"],
      resolve: vi.fn().mockResolvedValue(null),
      search: vi.fn().mockResolvedValue([]),
    };
    const registry = { list: () => [], get: () => adapter };
    const app = makeApp(registry);

    const resolve = await app.request("/markets/mock/resolve?reference=missing-ref");
    await expect(resolve.json()).resolves.toEqual({
      reference: "missing-ref",
      resolved: false,
      outcome: null,
      settlementPrice: null,
    });

    const invalid = await app.request("/markets/mock/search");
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: "INVALID_INPUT" } });
  });
});
