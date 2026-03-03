import { afterEach, describe, expect, it, vi } from "vitest";

import { PolymarketAdapter } from "../src/polymarket.js";
import { MarketAdapterError } from "../src/types.js";

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
};

const makeAdapter = () =>
  new PolymarketAdapter({
    gammaBaseUrl: "https://gamma.example",
    clobBaseUrl: "https://clob.example",
  });

describe("PolymarketAdapter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("searches and caches parsed market assets", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([
        {
          conditionId: "0x-condition",
          question: "Will CPI print below 3% next month?",
          lastTradePrice: "0.57",
          volume24hr: "12345",
        },
      ]),
    );

    const adapter = makeAdapter();
    const first = await adapter.search("cpi");
    const second = await adapter.search("cpi");

    expect(first).toEqual([
      {
        symbol: "0x-condition",
        name: "Will CPI print below 3% next month?",
        price: 0.57,
        volume: 12345,
      },
    ]);
    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const searchUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(searchUrl).toContain("search=cpi");
    expect(searchUrl).toContain("active=true");
    expect(searchUrl).toContain("closed=false");
  });

  it("skips malformed search rows and accepts slug/title fallback fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([
        "invalid-row",
        { conditionId: "0x-missing-name" },
        { slug: "slug-only", title: "Fallback Title", outcomePrice: "0.44", volume: "321" },
      ]),
    );

    const adapter = makeAdapter();
    const results = await adapter.search("fallback");
    expect(results).toEqual([
      {
        symbol: "slug-only",
        name: "Fallback Title",
        price: 0.44,
        volume: 321,
      },
    ]);
  });

  it("parses orderbook levels from tuple/object formats and sorts them", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        bids: [
          ["0.41", "2"],
          { price: "0.43", size: "3" },
          ["bad", "entry"],
        ],
        asks: [
          { price: "0.55", size: "8" },
          ["0.53", "5"],
        ],
      }),
    );

    const adapter = makeAdapter();
    const orderbook = await adapter.getOrderbook("0x-book");

    expect(orderbook.bids.map((level) => level.price)).toEqual([0.43, 0.41]);
    expect(orderbook.asks.map((level) => level.price)).toEqual([0.53, 0.55]);
  });

  it("builds quote from best bid and ask and uses cache", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        bids: [["0.49", "20"]],
        asks: [["0.51", "25"]],
      }),
    );

    const adapter = makeAdapter();
    const first = await adapter.getQuote("0x-quote");
    const second = await adapter.getQuote("0x-quote");

    expect(first.price).toBe(0.5);
    expect(first.bid).toBe(0.49);
    expect(first.ask).toBe(0.51);
    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("builds quote when only one side exists and serves cached orderbook", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return jsonResponse({
        bids: [[0.48, 4]],
        asks: [],
      });
    });

    const adapter = makeAdapter();
    const quote = await adapter.getQuote("0x-single-side");
    expect(quote.price).toBe(0.48);
    expect(quote.bid).toBe(0.48);
    expect(quote.ask).toBeUndefined();

    const firstBook = await adapter.getOrderbook("0x-book-cache");
    const secondBook = await adapter.getOrderbook("0x-book-cache");
    expect(secondBook).toEqual(firstBook);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws SYMBOL_NOT_FOUND when no bid and ask exist", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        bids: [],
        asks: [],
      }),
    );

    const adapter = makeAdapter();
    await expect(adapter.getQuote("0x-empty")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
    });
  });

  it("returns null for missing resolution and caches unresolved resolution payloads", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse([]));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([
        {
          conditionId: "0x-unresolved",
          resolved: false,
        },
      ]),
    );

    const adapter = makeAdapter();

    const missing = await adapter.resolve("0x-missing");
    expect(missing).toBeNull();

    const unresolvedFirst = await adapter.resolve("0x-unresolved");
    const unresolvedSecond = await adapter.resolve("0x-unresolved");

    expect(unresolvedFirst).toMatchObject({
      symbol: "0x-unresolved",
      resolved: false,
      outcome: null,
      settlementPrice: null,
    });
    expect(unresolvedSecond).toEqual(unresolvedFirst);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns resolved payload with outcome and settlement price", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([
        {
          conditionId: "0x-resolved",
          resolved: true,
          outcome: "YES",
          settlementPrice: "1",
        },
      ]),
    );

    const adapter = makeAdapter();
    const resolution = await adapter.resolve("0x-resolved");

    expect(resolution).toMatchObject({
      symbol: "0x-resolved",
      resolved: true,
      outcome: "YES",
      settlementPrice: 1,
    });
  });

  it("raises UPSTREAM_ERROR on non-200 upstream responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad upstream", { status: 500 }));

    const adapter = makeAdapter();
    await expect(adapter.search("btc")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "UPSTREAM_ERROR",
    });
  });

  it("raises UPSTREAM_ERROR on invalid orderbook payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse("not-an-object"));

    const adapter = makeAdapter();
    await expect(adapter.getOrderbook("0x-invalid-book")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "UPSTREAM_ERROR",
    });
  });
});
