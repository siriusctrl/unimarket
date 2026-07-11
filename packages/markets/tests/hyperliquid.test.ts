import { afterEach, describe, expect, it, vi } from "vitest";

import { HyperliquidAdapter } from "../src/hyperliquid.js";
import { getMarketCapabilities, MarketAdapterError } from "../src/types.js";

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
};

const makeAdapter = () =>
  new HyperliquidAdapter({
    apiUrl: "https://hl.example/info",
  });

const PERP_DEXS_RESPONSE = [null];

const META_RESPONSE = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 50 },
    { name: "ETH", szDecimals: 4, maxLeverage: 50 },
    { name: "SOL", szDecimals: 2, maxLeverage: 20 },
    { name: "DOGE", szDecimals: 0, maxLeverage: 10 },
  ],
};

const META_WITH_DELISTED = {
  universe: [
    { name: "BTC", szDecimals: 5, maxLeverage: 50 },
    { name: "OLD", szDecimals: 0, maxLeverage: 1, isDelisted: true },
  ],
};

const makeL2Book = (bids: [string, string][], asks: [string, string][]) => ({
  levels: [
    bids.map(([px, sz]) => ({ px, sz, n: 1 })),
    asks.map(([px, sz]) => ({ px, sz, n: 1 })),
  ],
});

const ASSET_CTXS_RESPONSE = [
  META_RESPONSE,
  [
    { midPx: "95000.5", markPx: "95001", dayNtlVlm: "5000000000", openInterest: "80000", funding: "0.0001", prevDayPx: "94000" },
    { midPx: "3200.1", markPx: "3201", dayNtlVlm: "2000000000", openInterest: "500000", funding: "0.00005", prevDayPx: "3180" },
    { midPx: "180.5", markPx: "180.6", dayNtlVlm: "800000000", openInterest: "1200000", funding: "0.0002", prevDayPx: "175" },
    { midPx: "0.25", markPx: "0.251", dayNtlVlm: "300000000", openInterest: "9000000", funding: "-0.0001", prevDayPx: "0.24" },
  ],
];

const VNTL_META_RESPONSE = {
  universe: [
    { name: "vntl:OPENAI", szDecimals: 3, maxLeverage: 3 },
  ],
};

const XYZ_META_RESPONSE = {
  universe: [
    { name: "xyz:NVDA", szDecimals: 2, maxLeverage: 5 },
  ],
};

const FLX_META_RESPONSE = {
  universe: [
    { name: "flx:NVDA", szDecimals: 2, maxLeverage: 4 },
  ],
};

const VNTL_ASSET_CTXS_RESPONSE = [
  VNTL_META_RESPONSE,
  [
    { midPx: "975.55", markPx: "963.18", dayNtlVlm: "37401.3756", openInterest: "2363.462", funding: "0.0000173865", prevDayPx: "945.13" },
  ],
];

const XYZ_ASSET_CTXS_RESPONSE = [
  XYZ_META_RESPONSE,
  [
    { midPx: "121.5", markPx: "121.1", dayNtlVlm: "1500000", openInterest: "8200", funding: "0.00005", prevDayPx: "118.9" },
  ],
];

const FLX_ASSET_CTXS_RESPONSE = [
  FLX_META_RESPONSE,
  [
    { midPx: "120.2", markPx: "120.1", dayNtlVlm: "400000", openInterest: "9200", funding: "0.00004", prevDayPx: "119.1" },
  ],
];

describe("HyperliquidAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("has correct adapter metadata", () => {
    const adapter = makeAdapter();
    expect(adapter.marketId).toBe("hyperliquid");
    expect(adapter.displayName).toBe("Hyperliquid");
    expect(adapter.referenceFormat).toContain("Ticker");
    expect(getMarketCapabilities(adapter)).toEqual(expect.arrayContaining(["search", "browse", "quote", "orderbook", "funding"]));
    expect(adapter.priceHistory).toMatchObject({
      defaultInterval: "1h",
      supportsCustomRange: true,
      supportsResampling: false,
    });
  });

  it("searches references by query and caches meta", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "perpDexs") return jsonResponse(PERP_DEXS_RESPONSE);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "metaAndAssetCtxs") return jsonResponse(ASSET_CTXS_RESPONSE);
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const adapter = makeAdapter();
    const results = await adapter.search("btc");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ reference: "BTC", name: "BTC-PERP", price: 95000.5 });

    await adapter.search("eth");
    const metaCalls = fetchSpy.mock.calls.filter(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return body.type === "meta";
    });
    expect(metaCalls).toHaveLength(1);
  });

  it("searches builder-deployed perps and resolves unique dex-prefixed aliases", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "perpDexs") {
        return jsonResponse([null, { name: "vntl" }, { name: "xyz" }, { name: "flx" }]);
      }
      if (body.type === "meta" && body.dex === "vntl") return jsonResponse(VNTL_META_RESPONSE);
      if (body.type === "meta" && body.dex === "xyz") return jsonResponse(XYZ_META_RESPONSE);
      if (body.type === "meta" && body.dex === "flx") return jsonResponse(FLX_META_RESPONSE);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "metaAndAssetCtxs" && body.dex === "vntl") return jsonResponse(VNTL_ASSET_CTXS_RESPONSE);
      if (body.type === "metaAndAssetCtxs" && body.dex === "xyz") return jsonResponse(XYZ_ASSET_CTXS_RESPONSE);
      if (body.type === "metaAndAssetCtxs" && body.dex === "flx") return jsonResponse(FLX_ASSET_CTXS_RESPONSE);
      if (body.type === "metaAndAssetCtxs") return jsonResponse(ASSET_CTXS_RESPONSE);
      if (body.type === "l2Book" && body.coin === "vntl:OPENAI") {
        return jsonResponse(makeL2Book([["970", "1.2"]], [["980", "0.8"]]));
      }
      throw new Error(`Unexpected request type: ${JSON.stringify(body)}`);
    });

    const adapter = makeAdapter();
    const results = await adapter.search("openai");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      reference: "vntl:OPENAI",
      name: "vntl:OPENAI-PERP",
      price: 975.55,
    });
    await expect(adapter.normalizeReference("openai")).resolves.toBe("vntl:OPENAI");
    await expect(adapter.normalizeReference("nvda")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
      message: expect.stringContaining("Use a dex-prefixed reference such as"),
    });

    const quote = await adapter.getQuote("vntl:OPENAI");
    expect(quote.price).toBe(975);
    expect(quote.bid).toBe(970);
    expect(quote.ask).toBe(980);
  });

  it("defaults duplicate search hits to relevance-volume ranking and honors explicit sort", async () => {
    const higherPriceLowerVolume = [
      XYZ_META_RESPONSE,
      [
        { midPx: "121.5", markPx: "121.1", dayNtlVlm: "400000", openInterest: "8200", funding: "0.00005", prevDayPx: "118.9" },
      ],
    ];
    const lowerPriceHigherVolume = [
      FLX_META_RESPONSE,
      [
        { midPx: "120.2", markPx: "120.1", dayNtlVlm: "1500000", openInterest: "9200", funding: "0.00004", prevDayPx: "119.1" },
      ],
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "perpDexs") {
        return jsonResponse([null, { name: "xyz" }, { name: "flx" }]);
      }
      if (body.type === "meta" && body.dex === "xyz") return jsonResponse(XYZ_META_RESPONSE);
      if (body.type === "meta" && body.dex === "flx") return jsonResponse(FLX_META_RESPONSE);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "metaAndAssetCtxs" && body.dex === "xyz") return jsonResponse(higherPriceLowerVolume);
      if (body.type === "metaAndAssetCtxs" && body.dex === "flx") return jsonResponse(lowerPriceHigherVolume);
      if (body.type === "metaAndAssetCtxs") return jsonResponse(ASSET_CTXS_RESPONSE);
      throw new Error(`Unexpected request type: ${JSON.stringify(body)}`);
    });

    const adapter = makeAdapter();
    const defaultRanked = await adapter.search("nvda");
    const byPrice = await adapter.search("nvda", { sort: "price" });

    expect(defaultRanked.map((row) => row.reference)).toEqual(["flx:NVDA", "xyz:NVDA"]);
    expect(byPrice.map((row) => row.reference)).toEqual(["xyz:NVDA", "flx:NVDA"]);
  });

  it("fails query discovery when any advertised builder dex is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "perpDexs") {
        return jsonResponse([null, { name: "vntl" }, { name: "broken" }]);
      }
      if (body.type === "meta" && body.dex === "vntl") return jsonResponse(VNTL_META_RESPONSE);
      if (body.type === "meta" && body.dex === "broken") throw new Error("builder dex unavailable");
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "metaAndAssetCtxs" && body.dex === "vntl") return jsonResponse(VNTL_ASSET_CTXS_RESPONSE);
      if (body.type === "metaAndAssetCtxs" && body.dex === "broken") throw new Error("builder dex unavailable");
      if (body.type === "metaAndAssetCtxs") return jsonResponse(ASSET_CTXS_RESPONSE);
      throw new Error(`Unexpected request type: ${JSON.stringify(body)}`);
    });

    await expect(makeAdapter().search("openai")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "UPSTREAM_ERROR",
    });
  });

  it("browses all listed references with pagination", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "metaAndAssetCtxs") return jsonResponse([
        META_RESPONSE,
        [
          { midPx: "95000", dayNtlVlm: "1000", openInterest: "1", funding: "0", prevDayPx: "1" },
          { midPx: "3200", dayNtlVlm: "1000", openInterest: "1", funding: "0", prevDayPx: "1" },
          { midPx: "180", dayNtlVlm: "1000", openInterest: "1", funding: "0", prevDayPx: "1" },
          { midPx: "0.25", dayNtlVlm: "1000", openInterest: "1", funding: "0", prevDayPx: "1" },
        ],
      ]);
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const adapter = makeAdapter();
    const browseResults = await adapter.browse?.({ limit: 2, offset: 1 });

    expect(browseResults?.map((row) => row.reference)).toEqual(["ETH", "SOL"]);
  });

  it("excludes delisted assets from discovery results", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_WITH_DELISTED);
      if (body.type === "metaAndAssetCtxs") return jsonResponse([
        META_WITH_DELISTED,
        [
          { midPx: "95000.5", dayNtlVlm: "5000000000", openInterest: "80000", funding: "0.0001", prevDayPx: "94000" },
          { midPx: "1", dayNtlVlm: "0", openInterest: "0", funding: "0", prevDayPx: "1" },
        ],
      ]);
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const adapter = makeAdapter();
    const browseResults = await adapter.browse?.();

    expect(browseResults).toHaveLength(1);
    expect(browseResults?.[0]?.reference).toBe("BTC");
  });

  it("normalizes reference aliases and perp suffixes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "perpDexs") return jsonResponse(PERP_DEXS_RESPONSE);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const adapter = makeAdapter();
    await expect(adapter.normalizeReference(" btc-perp ")).resolves.toBe("BTC");
    await expect(adapter.normalizeReference("eth")).resolves.toBe("ETH");
    await expect(adapter.normalizeReference("unknown")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
    });
  });

  it("returns trading constraints from meta", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const adapter = makeAdapter();
    const constraints = await adapter.getTradingConstraints?.("BTC");
    expect(constraints).toMatchObject({
      minQuantity: 0.00001,
      quantityStep: 0.00001,
      supportsFractional: true,
      maxLeverage: 50,
    });
  });

  it("gets quote from l2Book and caches it", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "l2Book" && body.coin === "BTC") {
        return jsonResponse(makeL2Book([["94990", "1.5"]], [["95010", "2.0"]]));
      }
      throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
    });

    const adapter = makeAdapter();
    const first = await adapter.getQuote("BTC");
    const second = await adapter.getQuote("BTC");

    expect(first.reference).toBe("BTC");
    expect(first.price).toBe(95000);
    expect(first.bid).toBe(94990);
    expect(first.ask).toBe(95010);
    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("gets orderbook with sorted levels", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "l2Book") {
        return jsonResponse(
          makeL2Book(
            [["94980", "1"], ["94990", "2"], ["94970", "3"]],
            [["95020", "4"], ["95010", "5"], ["95030", "6"]],
          ),
        );
      }
      throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
    });

    const adapter = makeAdapter();
    const book = await adapter.getOrderbook("ETH");

    expect(book.reference).toBe("ETH");
    expect(book.bids.map((l) => l.price)).toEqual([94990, 94980, 94970]);
    expect(book.asks.map((l) => l.price)).toEqual([95010, 95020, 95030]);
  });

  it("gets funding rate for a reference", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "predictedFundings") {
        return jsonResponse([
          ["BTC", [["HlPerp", { fundingRate: "0.0001", nextFundingTime: 1_700_000_000_000 }]]],
        ]);
      }
      throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
    });

    const adapter = makeAdapter();
    const btcFunding = await adapter.getFundingRate("btc-perp");

    expect(btcFunding.reference).toBe("btc-perp");
    expect(btcFunding.rate).toBe(0.0001);
    expect(btcFunding.nextFundingAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(btcFunding.direction).toBe("long_pays_short");
    expect(btcFunding.intervalHours).toBe(1);
    expect(btcFunding.annualizedRate).toBe(0.876);
  });

  it("returns the caller's reference when cached quote, orderbook, and funding entries are reused", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "l2Book" && body.coin === "BTC") {
        return jsonResponse(makeL2Book([["94990", "1.5"]], [["95010", "2.0"]]));
      }
      if (body.type === "predictedFundings") {
        return jsonResponse([
          ["BTC", [["HlPerp", { fundingRate: "0.0001", nextFundingTime: 1_700_000_000_000 }]]],
        ]);
      }
      throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
    });

    const adapter = makeAdapter();
    await expect(adapter.getQuote("btc-perp")).resolves.toMatchObject({ reference: "btc-perp" });
    await expect(adapter.getQuote("BTC")).resolves.toMatchObject({ reference: "BTC" });
    await expect(adapter.getOrderbook("btc-perp")).resolves.toMatchObject({ reference: "btc-perp" });
    await expect(adapter.getOrderbook("BTC")).resolves.toMatchObject({ reference: "BTC" });
    await expect(adapter.getFundingRate("btc-perp")).resolves.toMatchObject({ reference: "btc-perp" });
    await expect(adapter.getFundingRate("BTC")).resolves.toMatchObject({ reference: "BTC" });

    const l2BookCalls = fetchSpy.mock.calls.filter(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return body.type === "l2Book";
    });
    const fundingCalls = fetchSpy.mock.calls.filter(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return body.type === "predictedFundings";
    });
    expect(l2BookCalls).toHaveLength(1);
    expect(fundingCalls).toHaveLength(1);
  });

  it("rejects query searches when required discovery context fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "perpDexs") return jsonResponse(PERP_DEXS_RESPONSE);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "metaAndAssetCtxs") throw new Error("context fetch failed");
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    await expect(makeAdapter().search("o", { limit: 10, offset: 0 })).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "UPSTREAM_ERROR",
    });
  });

  it("reads builder-perp funding from asset contexts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T04:12:34.000Z"));

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "perpDexs") return jsonResponse([null, { name: "vntl" }]);
      if (body.type === "meta" && body.dex === "vntl") return jsonResponse(VNTL_META_RESPONSE);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "metaAndAssetCtxs" && body.dex === "vntl") return jsonResponse(VNTL_ASSET_CTXS_RESPONSE);
      if (body.type === "metaAndAssetCtxs") return jsonResponse(ASSET_CTXS_RESPONSE);
      if (body.type === "predictedFundings") return jsonResponse([]);
      throw new Error(`Unexpected request type: ${JSON.stringify(body)}`);
    });

    const adapter = makeAdapter();
    const funding = await adapter.getFundingRate("vntl:OPENAI");

    expect(funding).toMatchObject({
      reference: "vntl:OPENAI",
      rate: 0.0000173865,
      nextFundingAt: "2026-03-10T05:00:00.000Z",
      direction: "long_pays_short",
      intervalHours: 1,
      annualizedRate: 0.152306,
    });
    const predictedFundingCalls = fetchSpy.mock.calls.filter(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return body.type === "predictedFundings";
    });
    expect(predictedFundingCalls).toHaveLength(0);
  });

  it("rejects empty references and invalid meta or l2Book payloads", async () => {
    const metaSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse({ universe: null });
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const adapter = makeAdapter();
    await expect(adapter.normalizeReference("   ")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
    });
    await expect(adapter.getTradingConstraints("BTC")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "UPSTREAM_ERROR",
    });
    expect(metaSpy).toHaveBeenCalledTimes(1);

    metaSpy.mockReset();
    metaSpy.mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "l2Book") return jsonResponse({ levels: null });
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    await expect(adapter.getOrderbook("BTC")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "UPSTREAM_ERROR",
    });
  });

  it("supports one-sided quotes and filters invalid orderbook levels", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "l2Book" && body.coin === "BTC") {
        return jsonResponse({
          levels: [
            [],
            [
              { px: "101", sz: "2", n: 1 },
              { px: "bad", sz: "5", n: 1 },
              { px: "102", sz: "1.5", n: 1 },
            ],
          ],
        });
      }
      if (body.type === "l2Book" && body.coin === "ETH") {
        return jsonResponse({
          levels: [
            [
              { px: "99", sz: "1", n: 1 },
              { px: "oops", sz: "2", n: 1 },
              { px: "100", sz: "3", n: 1 },
            ],
            [{ px: "105", sz: "bad", n: 1 }],
          ],
        });
      }
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const adapter = makeAdapter();
    const quote = await adapter.getQuote("BTC");
    const book = await adapter.getOrderbook("ETH");

    expect(quote.price).toBe(101);
    expect(quote.bid).toBeUndefined();
    expect(quote.ask).toBe(101);
    expect(book.bids.map((level) => level.price)).toEqual([100, 99]);
    expect(book.asks).toEqual([]);
  });

  it("rejects quotes when no usable l2Book prices are available", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "l2Book") {
        return jsonResponse({
          levels: [[{ px: "bad", sz: "1", n: 1 }], [{ px: "bad", sz: "2", n: 1 }]],
        });
      }
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const adapter = makeAdapter();
    await expect(adapter.getQuote("BTC")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
    });
  });

  it("validates malformed funding data", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "predictedFundings") {
        return jsonResponse([["BTC", [["HlPerp", { fundingRate: "bad", nextFundingTime: "1700000000" }]]]]);
      }
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const invalidRateAdapter = makeAdapter();
    await expect(invalidRateAdapter.getFundingRate("BTC")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "UPSTREAM_ERROR",
    });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "predictedFundings") {
        return jsonResponse([["BTC", [["HlPerp", { fundingRate: "0.0001", nextFundingTime: "bad" }]]]]);
      }
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const invalidTimeAdapter = makeAdapter();
    await expect(invalidTimeAdapter.getFundingRate("BTC")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "UPSTREAM_ERROR",
    });
  });

  it("rejects unsupported funding payload shapes", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "predictedFundings") {
        return jsonResponse([["HlPerp", { coin: "ETH", fundingRate: "0.0002", nextFundingTime: "1700000000" }]]);
      }
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    await expect(makeAdapter().getFundingRate("ETH")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
    });
  });

  it("serves browse results from cache on repeated calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "metaAndAssetCtxs") return jsonResponse(ASSET_CTXS_RESPONSE);
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const adapter = makeAdapter();
    const first = await adapter.browse?.({ limit: 10, offset: 0 });
    const second = await adapter.browse?.({ limit: 10, offset: 0 });

    expect(first).toEqual(second);
    // meta is cached so only 1 call, metaAndAssetCtxs is cached for 5s so only 1 call — total 2 for first browse
    // second browse is served entirely from browse cache — 0 additional calls
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("applies limit and offset from browse cache without re-fetching", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "metaAndAssetCtxs") return jsonResponse(ASSET_CTXS_RESPONSE);
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const adapter = makeAdapter();
    const page1 = await adapter.browse?.({ limit: 2, offset: 0 });
    const page2 = await adapter.browse?.({ limit: 2, offset: 2 });

    // Price descending: BTC (95000.5), ETH (3200.1), SOL (180.5), DOGE (0.25)
    expect(page1?.map((r) => r.reference)).toEqual(["BTC", "ETH"]);
    expect(page2?.map((r) => r.reference)).toEqual(["SOL", "DOGE"]);
    // Second browse uses browse cache — only meta + metaAndAssetCtxs calls from first browse
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed browse context request", async () => {
    let ctxCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "metaAndAssetCtxs") {
        ctxCallCount += 1;
        if (ctxCallCount === 1) throw new Error("transient context failure");
        return jsonResponse(ASSET_CTXS_RESPONSE);
      }
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const adapter = makeAdapter();

    await expect(adapter.browse?.({ limit: 4, offset: 0 })).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "UPSTREAM_ERROR",
    });

    const recovered = await adapter.browse?.({ limit: 4, offset: 0 });
    expect(recovered?.find((r) => r.reference === "BTC")?.price).toBe(95000.5);
    expect(ctxCallCount).toBe(2);
  });

  it("browses by volume in descending order", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "metaAndAssetCtxs") return jsonResponse(ASSET_CTXS_RESPONSE);
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const adapter = makeAdapter();
    // dayNtlVlm order: BTC (5B) > ETH (2B) > SOL (800M) > DOGE (300M)
    const results = await adapter.browse?.({ sort: "volume", limit: 10 });

    expect(results?.map((r) => r.reference)).toEqual(["BTC", "ETH", "SOL", "DOGE"]);
    expect(results?.[0]?.volume).toBe(5_000_000_000);
    expect(results?.[3]?.volume).toBe(300_000_000);
    // Price should still be populated
    expect(results?.[0]?.price).toBe(95000.5);
  });

  it("browses by openInterest in descending order", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "metaAndAssetCtxs") return jsonResponse(ASSET_CTXS_RESPONSE);
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const adapter = makeAdapter();
    // openInterest order: DOGE (9M) > SOL (1.2M) > ETH (500K) > BTC (80K)
    const results = await adapter.browse?.({ sort: "openInterest", limit: 10 });

    expect(results?.map((r) => r.reference)).toEqual(["DOGE", "SOL", "ETH", "BTC"]);
    expect(results?.[0]?.openInterest).toBe(9_000_000);
    expect(results?.[3]?.openInterest).toBe(80_000);
  });

  it("populates volume, metadata, and funding previews on browse results", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "metaAndAssetCtxs") return jsonResponse(ASSET_CTXS_RESPONSE);
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    const adapter = makeAdapter();
    const results = await adapter.browse?.({ limit: 1, offset: 0 });

    const btc = results?.[0];
    expect(btc?.price).toBe(95000.5);
    expect(btc?.volume).toBe(5_000_000_000);
    expect(btc?.openInterest).toBe(80_000);
    expect(btc?.metadata?.funding).toBe(0.0001);
    expect(btc?.fundingPreview).toMatchObject({
      rate: 0.0001,
      direction: "long_pays_short",
      intervalHours: 1,
      annualizedRate: 0.876,
    });
  });

  it("rejects browse when required asset contexts are unavailable", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "metaAndAssetCtxs") throw new Error("context unavailable");
      throw new Error(`Unexpected request type: ${body.type}`);
    });

    await expect(makeAdapter().browse?.({ sort: "price", limit: 4 })).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "UPSTREAM_ERROR",
    });
    expect(fetchSpy.mock.calls.some(([, init]) => JSON.parse((init as RequestInit).body as string).type === "allMids")).toBe(false);
  });

  it("gets price history from candleSnapshot and caches results", async () => {
    const candleResponse = [
      { t: 1700000000000, o: "95000", h: "95500", l: "94500", c: "95200", v: "100.5" },
      { t: 1700003600000, o: "95200", h: "96000", l: "95100", c: "95800", v: "200.3" },
    ];

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "candleSnapshot") return jsonResponse(candleResponse);
      throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
    });

    const adapter = makeAdapter();
    const opts = {
      interval: "1h" as const,
      startTime: new Date(1700000000000).toISOString(),
      endTime: new Date(1700010000000).toISOString(),
    };
    const first = await adapter.getPriceHistory("BTC", opts);

    expect(first).toMatchObject({
      reference: "BTC",
      interval: "1h",
      resampledFrom: null,
      range: {
        mode: "custom",
        lookback: null,
        asOf: new Date(1700010000000).toISOString(),
        startTime: new Date(1699999200000).toISOString(),
        endTime: new Date(1700010000000).toISOString(),
      },
      summary: {
        open: 95000,
        close: 95800,
        high: 96000,
        low: 94500,
        volume: 300.8,
        candleCount: 2,
      },
    });
    expect(first.candles).toHaveLength(2);
    expect(first.candles[0]).toMatchObject({
      open: 95000,
      high: 95500,
      low: 94500,
      close: 95200,
      volume: 100.5,
    });
    expect(first.candles[0]?.timestamp).toBe(new Date(1700000000000).toISOString());

    // Second call with same options should be cached
    const second = await adapter.getPriceHistory("BTC", opts);
    expect(second).toEqual(first);

    const candleCalls = fetchSpy.mock.calls.filter(([, init]) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return body.type === "candleSnapshot";
    });
    expect(candleCalls).toHaveLength(1);
  });

  it("rejects invalid candleSnapshot responses", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      if (body.type === "meta") return jsonResponse(META_RESPONSE);
      if (body.type === "candleSnapshot") return jsonResponse("not an array");
      throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
    });

    const adapter = makeAdapter();
    await expect(adapter.getPriceHistory("BTC")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "UPSTREAM_ERROR",
    });
  });
});
