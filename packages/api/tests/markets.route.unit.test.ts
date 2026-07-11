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
  it("lists markets and returns each adapter's explicit trading constraints", async () => {
    const typedAdapter = {
      getTradingConstraints: vi.fn().mockResolvedValue({
        minQuantity: 0.01,
        quantityStep: 0.01,
        supportsFractional: true,
        maxLeverage: 5,
      }),
    };
    const plainAdapter = {
      getTradingConstraints: vi.fn().mockResolvedValue({
        minQuantity: 1,
        quantityStep: 1,
        supportsFractional: false,
        maxLeverage: null,
      }),
    };
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
    const browseOnly = { browse: vi.fn().mockResolvedValue([]) };
    const quoteOnly = {
      getQuote: vi.fn().mockResolvedValue({ reference: "BTC", price: 1, bid: 0.99, ask: 1.01, timestamp: "2026-03-08T00:00:00.000Z" }),
    };
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

    const quote = await app.request("/markets/quote/quote?reference=BTC");
    expect(quote.status).toBe(200);
    await expect(quote.json()).resolves.toMatchObject({
      reference: "BTC",
      price: 1,
      bid: 0.99,
      ask: 1.01,
      mid: 1,
      spreadAbs: 0.02,
      spreadBps: 200,
      timestamp: "2026-03-08T00:00:00.000Z",
    });

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

  it("keeps quote responses lean and does not trigger implicit funding lookups", async () => {
    const adapter = {
      getQuote: vi.fn(async (reference: string) => ({
        reference,
        price: reference === "btc" ? 100 : 50,
        bid: reference === "btc" ? 99 : undefined,
        ask: reference === "btc" ? 101 : undefined,
        timestamp: "2026-03-08T00:00:00.000Z",
      })),
      getFundingRate: vi.fn(),
    };
    const registry = { list: () => [], get: () => adapter };
    const app = makeApp(registry);

    const quote = await app.request("/markets/mock/quote?reference=btc");
    expect(quote.status).toBe(200);
    await expect(quote.json()).resolves.toEqual({
      reference: "btc",
      price: 100,
      bid: 99,
      ask: 101,
      mid: 100,
      spreadAbs: 2,
      spreadBps: 200,
      timestamp: "2026-03-08T00:00:00.000Z",
    });

    const quotes = await app.request("/markets/mock/quotes?references=btc,eth");
    expect(quotes.status).toBe(200);
    await expect(quotes.json()).resolves.toEqual({
      quotes: [
        {
          reference: "btc",
          price: 100,
          bid: 99,
          ask: 101,
          mid: 100,
          spreadAbs: 2,
          spreadBps: 200,
          timestamp: "2026-03-08T00:00:00.000Z",
        },
        {
          reference: "eth",
          price: 50,
          mid: 50,
          spreadAbs: null,
          spreadBps: null,
          timestamp: "2026-03-08T00:00:00.000Z",
        },
      ],
      errors: [],
    });
    expect(adapter.getFundingRate).not.toHaveBeenCalled();
  });

  it("maps batch quote, orderbook, and funding errors per reference", async () => {
    const adapter = {
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
        if (reference === "btc") {
          return {
            reference,
            rate: 0.01,
            nextFundingAt: "2026-03-07T01:00:00.000Z",
            timestamp: "2026-03-07T00:00:00.000Z",
            direction: "long_pays_short" as const,
            intervalHours: 1,
            annualizedRate: 87.6,
          };
        }
        if (reference === "eth") throw new MarketAdapterError("SYMBOL_NOT_FOUND", "missing funding");
        throw new Error("funding exploded");
      }),
    };
    const registry = { list: () => [], get: () => adapter };
    const app = makeApp(registry);

    const quotes = await app.request("/markets/mock/quotes?references=btc,eth,sol");
    await expect(quotes.json()).resolves.toEqual({
      quotes: [{ reference: "btc", price: 100, mid: 100, spreadAbs: null, spreadBps: null }],
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
      fundings: [{
        reference: "btc",
        rate: 0.01,
        nextFundingAt: "2026-03-07T01:00:00.000Z",
        timestamp: "2026-03-07T00:00:00.000Z",
        direction: "long_pays_short",
        intervalHours: 1,
        annualizedRate: 87.6,
      }],
      errors: [
        { reference: "eth", error: { code: "SYMBOL_NOT_FOUND", message: "missing funding" } },
        { reference: "sol", error: { code: "INTERNAL_ERROR", message: "funding exploded" } },
      ],
    });
  });

  it("returns unresolved defaults and validates malformed query payloads", async () => {
    const adapter = {
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

  it("passes optional search sort through to the adapter", async () => {
    const adapter = {
      searchSortOptions: [{ value: "volume", label: "Volume" }],
      search: vi.fn().mockResolvedValue([{ reference: "xyz:NVDA", name: "xyz:NVDA-PERP" }]),
    };
    const registry = { list: () => [], get: () => adapter };
    const app = makeApp(registry);

    const response = await app.request("/markets/mock/search?q=nvda&sort=volume&limit=5&offset=2");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [{ reference: "xyz:NVDA", name: "xyz:NVDA-PERP" }],
      hasMore: false,
    });
    expect(adapter.search).toHaveBeenCalledWith("nvda", {
      sort: "volume",
      limit: 6,
      offset: 2,
    });
  });

  it("returns discovery hasMore and rejects unsupported sort keys", async () => {
    const adapter = {
      searchSortOptions: [{ value: "volume", label: "Volume" }],
      browseOptions: [{ value: "price", label: "Price" }],
      search: vi.fn().mockResolvedValue([
        {
          reference: "a",
          name: "A",
          fundingPreview: {
            rate: 0.0025,
            nextFundingAt: "2026-03-08T01:00:00.000Z",
            timestamp: "2026-03-08T00:00:00.000Z",
            direction: "long_pays_short" as const,
            intervalHours: 1,
            annualizedRate: 21.9,
          },
        },
        { reference: "b", name: "B" },
        { reference: "c", name: "C" },
      ]),
      browse: vi.fn().mockResolvedValue([
        { reference: "btc", name: "BTC" },
        { reference: "eth", name: "ETH" },
      ]),
    };
    const registry = { list: () => [], get: () => adapter };
    const app = makeApp(registry);

    const searchResponse = await app.request("/markets/mock/search?q=nvda&limit=2");
    expect(searchResponse.status).toBe(200);
    await expect(searchResponse.json()).resolves.toEqual({
      results: [
        {
          reference: "a",
          name: "A",
          fundingPreview: {
            rate: 0.0025,
            nextFundingAt: "2026-03-08T01:00:00.000Z",
            timestamp: "2026-03-08T00:00:00.000Z",
            direction: "long_pays_short",
            intervalHours: 1,
            annualizedRate: 21.9,
          },
        },
        { reference: "b", name: "B" },
      ],
      hasMore: true,
    });

    const invalidSearchSort = await app.request("/markets/mock/search?q=nvda&sort=price");
    expect(invalidSearchSort.status).toBe(400);
    await expect(invalidSearchSort.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT", message: expect.stringContaining("Unsupported sort 'price'") },
    });

    const invalidBrowseSort = await app.request("/markets/mock/browse?sort=volume");
    expect(invalidBrowseSort.status).toBe(400);
    await expect(invalidBrowseSort.json()).resolves.toMatchObject({
      error: { code: "INVALID_INPUT", message: expect.stringContaining("Unsupported sort 'volume'") },
    });
  });

  it("returns price history candles and rejects unsupported markets", async () => {
    const candleData = [
      { timestamp: "2026-03-07T00:00:00.000Z", open: 100, high: 105, low: 95, close: 102, volume: 500 },
    ];
    const historyPayload = {
      reference: "BTC",
      interval: "1h",
      resampledFrom: null,
      range: {
        mode: "lookback",
        lookback: "7d",
        asOf: "2026-03-08T00:00:00.000Z",
        startTime: "2026-03-01T00:00:00.000Z",
        endTime: "2026-03-08T00:00:00.000Z",
      },
      candles: candleData,
      summary: {
        open: 100,
        close: 102,
        change: 2,
        changePct: 2,
        high: 105,
        low: 95,
        volume: 500,
        candleCount: 1,
      },
    };
    const withHistory = {
      getQuote: vi.fn().mockResolvedValue({ price: 100 }),
      priceHistory: {
        nativeIntervals: ["1h"],
        supportedIntervals: ["1h"],
        defaultInterval: "1h",
        supportedLookbacks: ["7d"],
        defaultLookbacks: { "1h": "7d" },
        maxCandles: 300,
        supportsCustomRange: true,
        supportsResampling: false,
      },
      getPriceHistory: vi.fn().mockResolvedValue(historyPayload),
    };
    const withoutHistory = {
      getQuote: vi.fn().mockResolvedValue({ price: 50 }),
    };
    const registry = {
      list: () => [],
      get: (marketId: string) => {
        if (marketId === "hl") return withHistory;
        if (marketId === "pm") return withoutHistory;
        return undefined;
      },
    };
    const app = makeApp(registry);

    const happy = await app.request("/markets/hl/price-history?reference=BTC");
    expect(happy.status).toBe(200);
    await expect(happy.json()).resolves.toEqual(historyPayload);

    const withLookback = await app.request(
      "/markets/hl/price-history?reference=BTC&interval=1h&lookback=7d&asOf=2026-03-08T00:00:00.000Z",
    );
    expect(withLookback.status).toBe(200);
    expect(withHistory.getPriceHistory).toHaveBeenLastCalledWith("BTC", {
      interval: "1h",
      lookback: "7d",
      asOf: "2026-03-08T00:00:00.000Z",
      startTime: undefined,
      endTime: undefined,
    });

    const invalid = await app.request(
      "/markets/hl/price-history?reference=BTC&lookback=7d&startTime=2026-03-01T00:00:00.000Z&endTime=2026-03-08T00:00:00.000Z",
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: "INVALID_INPUT" } });

    const unsupported = await app.request("/markets/pm/price-history?reference=YES");
    expect(unsupported.status).toBe(400);
    await expect(unsupported.json()).resolves.toMatchObject({ error: { code: "CAPABILITY_NOT_SUPPORTED" } });

    const missing = await app.request("/markets/unknown/price-history?reference=BTC");
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "MARKET_NOT_FOUND" } });
  });
});
