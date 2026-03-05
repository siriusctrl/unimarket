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
    expect(searchUrl).toContain("offset=0");
  });

  it("browses all active markets when query is empty", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([
        {
          conditionId: "0x-browse-item",
          question: "Will ETH hit $10k?",
          lastTradePrice: "0.22",
          volume24hr: "5000",
        },
      ]),
    );

    const adapter = makeAdapter();
    const results = await adapter.search("", { limit: 10, offset: 20 });

    expect(results).toEqual([
      {
        symbol: "0x-browse-item",
        name: "Will ETH hit $10k?",
        price: 0.22,
        volume: 5000,
      },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const browseUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(browseUrl).not.toContain("search=");
    expect(browseUrl).toContain("limit=10");
    expect(browseUrl).toContain("offset=20");
    expect(browseUrl).toContain("active=true");
    expect(browseUrl).toContain("closed=false");
  });

  it("includes market metadata when token and outcome details are available", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([
        {
          conditionId: `0x${"d".repeat(64)}`,
          question: "Will metadata be exposed?",
          clobTokenIds: JSON.stringify(["111", "222"]),
          outcomes: JSON.stringify(["Yes", "No"]),
          outcomePrices: JSON.stringify(["0.61", "0.39"]),
          lastTradePrice: "0.61",
        },
      ]),
    );

    const adapter = makeAdapter();
    const results = await adapter.search("metadata");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      symbol: `0x${"d".repeat(64)}`,
      name: "Will metadata be exposed?",
      metadata: {
        tokenIds: ["111", "222"],
        outcomes: ["Yes", "No"],
        outcomePrices: [0.61, 0.39],
        defaultTokenId: "111",
      },
    });
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

  it("resolves condition-id symbols to clob token ids for quote and orderbook", async () => {
    const conditionId = `0x${"a".repeat(64)}`;
    const tokenId = "123456789012345678901";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://gamma.example/markets")) {
        return jsonResponse([
          {
            conditionId,
            question: "Will test market resolve?",
            clobTokenIds: JSON.stringify([tokenId, "987"]),
          },
        ]);
      }
      if (url === `https://clob.example/book?token_id=${tokenId}`) {
        return jsonResponse({
          bids: [["0.45", "12"]],
          asks: [["0.55", "15"]],
        });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    const quote = await adapter.getQuote(conditionId);

    expect(quote.symbol).toBe(conditionId);
    expect(quote.bid).toBe(0.45);
    expect(quote.ask).toBe(0.55);
    expect(quote.price).toBe(0.5);

    const calledUrls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(calledUrls).toEqual(
      expect.arrayContaining([
        `https://clob.example/book?token_id=${tokenId}`,
      ]),
    );
    expect(calledUrls.some((url) => url.includes(`conditionId=${conditionId}`))).toBe(true);
  });

  it("reuses condition-id to token-id mapping discovered during search", async () => {
    const conditionId = `0x${"b".repeat(64)}`;
    const tokenId = "789012345678901234567";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://gamma.example/markets")) {
        return jsonResponse([
          {
            conditionId,
            question: "Search should warm symbol mapping cache",
            clobTokenIds: JSON.stringify([tokenId]),
          },
        ]);
      }
      if (url === `https://clob.example/book?token_id=${tokenId}`) {
        return jsonResponse({
          bids: [["0.4", "3"]],
          asks: [["0.42", "4"]],
        });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    const results = await adapter.search("cache");
    expect(results[0]?.symbol).toBe(conditionId);

    const quote = await adapter.getQuote(conditionId);
    expect(quote.price).toBe(0.41);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws SYMBOL_NOT_FOUND when a condition-id symbol has no token ids", async () => {
    const conditionId = `0x${"c".repeat(64)}`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([{ conditionId, question: "Missing tokens" }]));

    const adapter = makeAdapter();
    await expect(adapter.getQuote(conditionId)).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
    });
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
    const missingConditionId = `0x${"e".repeat(64)}`;
    const unresolvedConditionId = `0x${"f".repeat(64)}`;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(jsonResponse([]));
    fetchSpy.mockResolvedValueOnce(
      jsonResponse([
        {
          conditionId: unresolvedConditionId,
          resolved: false,
        },
      ]),
    );

    const adapter = makeAdapter();

    const missing = await adapter.resolve(missingConditionId);
    expect(missing).toBeNull();

    const unresolvedFirst = await adapter.resolve(unresolvedConditionId);
    const unresolvedSecond = await adapter.resolve(unresolvedConditionId);

    expect(unresolvedFirst).toMatchObject({
      symbol: unresolvedConditionId,
      resolved: false,
      outcome: null,
      settlementPrice: null,
    });
    expect(unresolvedSecond).toEqual(unresolvedFirst);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns resolved payload with outcome and settlement price", async () => {
    const resolvedConditionId = `0x${"1".repeat(64)}`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse([
        {
          conditionId: resolvedConditionId,
          resolved: true,
          outcome: "YES",
          settlementPrice: "1",
        },
      ]),
    );

    const adapter = makeAdapter();
    const resolution = await adapter.resolve(resolvedConditionId);

    expect(resolution).toMatchObject({
      symbol: resolvedConditionId,
      resolved: true,
      outcome: "YES",
      settlementPrice: 1,
    });
  });

  it("resolves token-id symbols by mapping token ids to condition ids first", async () => {
    const tokenId = "123456789";
    const conditionId = `0x${"2".repeat(64)}`;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes(`clob_token_ids=${tokenId}`)) {
        return jsonResponse([
          {
            conditionId,
            clobTokenIds: JSON.stringify([tokenId]),
          },
        ]);
      }
      if (url.includes(`conditionId=${conditionId}`)) {
        return jsonResponse([
          {
            conditionId,
            resolved: true,
            outcome: "YES",
            settlementPrice: "1",
          },
        ]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    const resolution = await adapter.resolve(tokenId);

    expect(resolution).toMatchObject({
      symbol: tokenId,
      resolved: true,
      outcome: "YES",
      settlementPrice: 1,
    });
    const calledUrls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(calledUrls.some((url) => url.includes(`clob_token_ids=${tokenId}`))).toBe(true);
    expect(calledUrls.some((url) => url.includes(`conditionId=${conditionId}`))).toBe(true);
  });

  it("returns null when token-id symbols cannot be mapped to condition ids", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));
    const adapter = makeAdapter();

    const first = await adapter.resolve("missing-token");
    const second = await adapter.resolve("missing-token");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
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

  it("maps orderbook 404 responses to SYMBOL_NOT_FOUND", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));

    const adapter = makeAdapter();
    await expect(adapter.getQuote("plain-token-id")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
    });
  });

  it("resolves names/outcomes for multiple token ids without combined clob_token_ids queries", async () => {
    const tokenA = "111111";
    const tokenB = "222222";
    const conditionA = `0x${"3".repeat(64)}`;
    const conditionB = `0x${"4".repeat(64)}`;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes(`clob_token_ids=${tokenA}%2C${tokenB}`) || url.includes(`clob_token_ids=${tokenA},${tokenB}`)) {
        return jsonResponse({ type: "validation error", error: "invalid clob token ids" }, 400);
      }
      if (url.includes(`clob_token_ids=${tokenA}`)) {
        return jsonResponse([
          {
            conditionId: conditionA,
            question: "Will token A resolve?",
            clobTokenIds: JSON.stringify([tokenA]),
            outcomes: JSON.stringify(["Yes"]),
          },
        ]);
      }
      if (url.includes(`clob_token_ids=${tokenB}`)) {
        return jsonResponse([
          {
            conditionId: conditionB,
            question: "Will token B resolve?",
            clobTokenIds: JSON.stringify([tokenB]),
            outcomes: JSON.stringify(["No"]),
          },
        ]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    const resolved = await adapter.resolveSymbolNames([tokenA, tokenB]);

    expect(resolved.names.get(tokenA)).toBe("Will token A resolve?");
    expect(resolved.outcomes.get(tokenA)).toBe("Yes");
    expect(resolved.names.get(tokenB)).toBe("Will token B resolve?");
    expect(resolved.outcomes.get(tokenB)).toBe("No");

    const calledUrls = fetchSpy.mock.calls.map(([url]) => String(url));
    expect(calledUrls.some((url) => url.includes(`clob_token_ids=${tokenA}`))).toBe(true);
    expect(calledUrls.some((url) => url.includes(`clob_token_ids=${tokenB}`))).toBe(true);
    expect(
      calledUrls.some((url) => url.includes(`clob_token_ids=${tokenA}%2C${tokenB}`) || url.includes(`clob_token_ids=${tokenA},${tokenB}`)),
    ).toBe(false);
  });
});
