import { afterEach, describe, expect, it, vi } from "vitest";

import { PolymarketAdapter } from "../src/polymarket.js";
import { MarketAdapterError } from "../src/types.js";

const jsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
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

  it("searches preview references through search-v2 and caches results", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://gamma.example/search-v2")) {
        return jsonResponse({
          events: [
            {
              title: "Iran event",
              markets: [
                {
                  slug: "iran-hormuz",
                  question: "Will Iran close the Strait of Hormuz?",
                  conditionId: `0x${"a".repeat(64)}`,
                  lastTradePrice: "0.57",
                  volume24hr: "12345",
                },
              ],
            },
          ],
          pagination: { hasMore: false },
        });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    const first = await adapter.search("iran");
    const second = await adapter.search("iran");

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      reference: "iran-hormuz",
      name: "Will Iran close the Strait of Hormuz?",
      price: 0.57,
      volume: 12345,
      endDate: null,
      metadata: {
        conditionId: `0x${"a".repeat(64)}`,
        outcomes: [],
        outcomePrices: [],
        defaultOutcome: null,
        eventTitle: "Iran event",
        createdAt: null,
      },
    });
    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("browses active markets from events and sorts them locally", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://gamma.example/events")) {
        return jsonResponse([
          {
            title: "Macro",
            liquidity: "8000",
            endDate: "2026-03-10T00:00:00.000Z",
            createdAt: "2026-03-01T00:00:00.000Z",
            markets: [
              { slug: "fed-cut", question: "Will the Fed cut in March?", volume24hr: "2000", lastTradePrice: "0.41" },
              { slug: "jobs-hot", question: "Will payrolls beat expectations?", volume24hr: "5000", lastTradePrice: "0.62" },
            ],
          },
        ]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    const results = await adapter.browse?.({ sort: "volume", limit: 10, offset: 0 });

    expect(results?.map((row) => row.reference)).toEqual(["jobs-hot", "fed-cut"]);
  });

  it("filters out closed or archived discovery results", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://gamma.example/events")) {
        return jsonResponse([
          {
            title: "Mixed event",
            liquidity: "8000",
            markets: [
              { slug: "closed-market", question: "Closed market", active: true, closed: true, archived: false, volume24hr: "9000" },
              { slug: "archived-market", question: "Archived market", active: true, closed: false, archived: true, volume24hr: "8000" },
              { slug: "live-market", question: "Live market", active: true, closed: false, archived: false, volume24hr: "7000" },
            ],
          },
        ]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    const results = await adapter.browse?.({ sort: "volume", limit: 10, offset: 0 });

    expect(results).toMatchObject([{ reference: "live-market", name: "Live market" }]);
  });

  it("normalizes slug, condition id, and token id references to token ids", async () => {
    const conditionId = `0x${"b".repeat(64)}`;
    const tokenId = "123456789";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gamma.example/markets?slug=iran-hormuz&limit=1") {
        return jsonResponse([{ slug: "iran-hormuz", conditionId, clobTokenIds: JSON.stringify([tokenId, "987"]) }]);
      }
      if (url === `https://gamma.example/markets?conditionId=${conditionId}&limit=1`) {
        return jsonResponse([{ slug: "iran-hormuz", conditionId, clobTokenIds: JSON.stringify([tokenId, "987"]) }]);
      }
      if (url === `https://gamma.example/markets?clob_token_ids=${tokenId}&limit=1`) {
        return jsonResponse([{ slug: "iran-hormuz", conditionId, clobTokenIds: JSON.stringify([tokenId, "987"]) }]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    await expect(adapter.normalizeReference("iran-hormuz")).resolves.toBe(tokenId);
    await expect(adapter.normalizeReference(conditionId)).resolves.toBe(tokenId);
    await expect(adapter.normalizeReference(tokenId)).resolves.toBe(tokenId);
    await expect(adapter.resolve(tokenId)).resolves.toMatchObject({ reference: tokenId, resolved: false });
  });

  it("parses orderbook and quote using slug references", async () => {
    const conditionId = `0x${"c".repeat(64)}`;
    const tokenId = "555";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gamma.example/markets?slug=iran-hormuz&limit=1") {
        return jsonResponse([{ slug: "iran-hormuz", conditionId, clobTokenIds: JSON.stringify([tokenId]) }]);
      }
      if (url === `https://clob.example/book?token_id=${tokenId}`) {
        return jsonResponse({
          bids: [["0.45", "12"], ["0.44", "10"]],
          asks: [["0.55", "15"], ["0.56", "18"]],
        });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    const quote = await adapter.getQuote("iran-hormuz");
    const book = await adapter.getOrderbook("iran-hormuz");

    expect(quote).toMatchObject({ reference: "iran-hormuz", bid: 0.45, ask: 0.55, price: 0.5 });
    expect(book.reference).toBe("iran-hormuz");
    expect(book.bids.map((level) => level.price)).toEqual([0.45, 0.44]);
    expect(book.asks.map((level) => level.price)).toEqual([0.55, 0.56]);
  });

  it("maps orderbook 404s to SYMBOL_NOT_FOUND after reference resolution", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gamma.example/markets?slug=missing-book&limit=1") {
        return jsonResponse([{ slug: "missing-book", conditionId: `0x${"d".repeat(64)}`, clobTokenIds: JSON.stringify(["777"]) }]);
      }
      if (url === "https://clob.example/book?token_id=777") {
        return jsonResponse({ error: "not found" }, 404);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    await expect(adapter.getQuote("missing-book")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
    });
  });

  it("returns resolved payloads using the original reference", async () => {
    const conditionId = `0x${"1".repeat(64)}`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === `https://gamma.example/markets?conditionId=${conditionId}&limit=1`) {
        return jsonResponse([
          {
            slug: "resolved-market",
            conditionId,
            clobTokenIds: JSON.stringify(["999"]),
            resolved: true,
            outcome: "YES",
            settlementPrice: "1",
          },
        ]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    const resolution = await adapter.resolve(conditionId);

    expect(resolution).toMatchObject({ reference: conditionId, resolved: true, outcome: "YES", settlementPrice: 1 });
  });

  it("resolves names and outcomes for token ids", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gamma.example/markets?clob_token_ids=123&limit=1") {
        return jsonResponse([
          {
            question: "Will Iran close the Strait of Hormuz?",
            conditionId: `0x${"e".repeat(64)}`,
            clobTokenIds: JSON.stringify(["123", "456"]),
            outcomes: JSON.stringify(["Yes", "No"]),
          },
        ]);
      }
      if (url === "https://gamma.example/markets?clob_token_ids=456&limit=1") {
        return jsonResponse([
          {
            question: "Will Iran close the Strait of Hormuz?",
            conditionId: `0x${"e".repeat(64)}`,
            clobTokenIds: JSON.stringify(["123", "456"]),
            outcomes: JSON.stringify(["Yes", "No"]),
          },
        ]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    const resolution = await adapter.resolveSymbolNames(["123", "456"]);

    expect(resolution.names.get("123")).toBe("Will Iran close the Strait of Hormuz?");
    expect(resolution.outcomes.get("123")).toBe("Yes");
    expect(resolution.outcomes.get("456")).toBe("No");
  });

  it("falls back to browse for blank searches and supports alternate browse sorts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://gamma.example/events")) {
        return jsonResponse([
          {
            title: "Macro",
            liquidity: "9000",
            endDate: "2026-03-11T00:00:00.000Z",
            createdAt: "2026-03-01T00:00:00.000Z",
            markets: [
              { slug: "older", question: "Older market", volume24hr: "2000", liquidity: "4000", lastTradePrice: "0.40" },
              { slug: "newer", question: "Newer market", volume24hr: "2000", liquidity: "7000", lastTradePrice: "0.60" },
            ],
          },
          {
            title: "Rates",
            liquidity: "5000",
            endDate: "2026-03-09T00:00:00.000Z",
            createdAt: "2026-03-05T00:00:00.000Z",
            markets: [
              { slug: "soonest", question: "Soonest market", volume24hr: "1000", liquidity: "3000", lastTradePrice: "0.30" },
            ],
          },
        ]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    await expect(adapter.search("   ", { limit: 2, offset: 0 })).resolves.toMatchObject([
      { reference: "newer" },
      { reference: "older" },
    ]);

    await expect(adapter.browse?.({ sort: "liquidity", limit: 3, offset: 0 })).resolves.toMatchObject([
      { reference: "newer" },
      { reference: "older" },
      { reference: "soonest" },
    ]);

    await expect(adapter.browse?.({ sort: "endingSoon", limit: 3, offset: 0 })).resolves.toMatchObject([
      { reference: "soonest" },
      { reference: "newer" },
      { reference: "older" },
    ]);

    await expect(adapter.browse?.({ sort: "newest", limit: 3, offset: 0 })).resolves.toMatchObject([
      { reference: "soonest" },
      { reference: "newer" },
      { reference: "older" },
    ]);
  });

  it("gracefully handles invalid search and browse payloads", async () => {
    const adapter = makeAdapter();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://gamma.example/search-v2")) {
        return jsonResponse("bad-payload");
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });
    await expect(adapter.search("iran")).resolves.toEqual([]);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://gamma.example/events")) {
        return jsonResponse({ events: [] });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });
    await expect(adapter.browse?.()).resolves.toEqual([]);
  });

  it("rejects unresolved slug and condition references", async () => {
    const conditionId = `0x${"f".repeat(64)}`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gamma.example/markets?slug=missing&limit=1") {
        return jsonResponse([]);
      }
      if (url === `https://gamma.example/markets?conditionId=${conditionId}&limit=1`) {
        return jsonResponse([{ slug: "missing-token", conditionId, clobTokenIds: JSON.stringify([]) }]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    await expect(adapter.normalizeReference("missing")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
    });
    await expect(adapter.normalizeReference(conditionId)).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
    });
  });

  it("returns one-sided quotes, validates empty quotes, and rejects invalid orderbooks", async () => {
    const conditionId = `0x${"9".repeat(64)}`;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gamma.example/markets?slug=ask-only&limit=1") {
        return jsonResponse([{ slug: "ask-only", conditionId, clobTokenIds: JSON.stringify(["222"]) }]);
      }
      if (url === "https://clob.example/book?token_id=222") {
        return jsonResponse({ bids: [], asks: [{ price: "0.61", size: "8" }] });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const askOnlyAdapter = makeAdapter();
    await expect(askOnlyAdapter.getQuote("ask-only")).resolves.toMatchObject({ reference: "ask-only", price: 0.61, ask: 0.61 });
    await expect(askOnlyAdapter.getQuote("ask-only")).resolves.toMatchObject({ reference: "ask-only", price: 0.61, ask: 0.61 });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gamma.example/markets?slug=no-book&limit=1") {
        return jsonResponse([{ slug: "no-book", conditionId, clobTokenIds: JSON.stringify(["223"]) }]);
      }
      if (url === "https://clob.example/book?token_id=223") {
        return jsonResponse({ bids: [], asks: [] });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const noBookAdapter = makeAdapter();
    await expect(noBookAdapter.getQuote("no-book")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
    });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gamma.example/markets?slug=bad-book&limit=1") {
        return jsonResponse([{ slug: "bad-book", conditionId, clobTokenIds: JSON.stringify(["224"]) }]);
      }
      if (url === "https://clob.example/book?token_id=224") {
        return jsonResponse("invalid-book");
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const badBookAdapter = makeAdapter();
    await expect(badBookAdapter.getOrderbook("bad-book")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "UPSTREAM_ERROR",
    });
  });

  it("caches missing resolutions and returns null for unresolved condition ids", async () => {
    const conditionId = `0x${"7".repeat(64)}`;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gamma.example/markets?slug=missing-resolution&limit=1") {
        return jsonResponse([]);
      }
      if (url === `https://gamma.example/markets?conditionId=${conditionId}&limit=1`) {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    await expect(adapter.resolve("missing-resolution")).resolves.toBeNull();
    await expect(adapter.resolve("missing-resolution")).resolves.toBeNull();
    await expect(adapter.resolve(conditionId)).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("resolves symbol names from condition ids and token records", async () => {
    const conditionId = `0x${"8".repeat(64)}`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === `https://gamma.example/markets?conditionId=${conditionId}&limit=1`) {
        return jsonResponse([
          {
            question: "Will the launch happen?",
            conditionId,
            tokens: [
              { token_id: "101", outcome: "Yes" },
              { token_id: "202", outcome: "No" },
              null,
            ],
          },
        ]);
      }
      if (url === "https://gamma.example/markets?clob_token_ids=101&limit=1") {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    const resolution = await adapter.resolveSymbolNames([conditionId, "101"]);

    expect(resolution.names.get(conditionId)).toBe("Will the launch happen?");
    expect(resolution.names.get("101")).toBe("Will the launch happen?");
    expect(resolution.outcomes.get("101")).toBe("Yes");
    expect(resolution.outcomes.get("202")).toBe("No");
  });

  it("ignores non-critical resolveSymbolNames batch failures", async () => {
    vi.spyOn(Promise, "allSettled").mockRejectedValueOnce(new Error("settled failed"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));

    const adapter = makeAdapter();
    const resolution = await adapter.resolveSymbolNames(["123"]);

    expect(resolution.names.size).toBe(0);
    expect(resolution.outcomes.size).toBe(0);
  });

  it("delegates blank searches to browse", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://gamma.example/events")) {
        return jsonResponse([
          {
            title: "Macro",
            liquidity: "5000",
            markets: [{ slug: "delegated-market", question: "Delegated market", volume24hr: "1000" }],
          },
        ]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    await expect(adapter.search("   ", { limit: 5, offset: 0 })).resolves.toMatchObject([
      { reference: "delegated-market", name: "Delegated market" },
    ]);
  });

  it("deduplicates paginated search previews and skips malformed entries", async () => {
    const conditionOne = `0x${"f".repeat(64)}`;
    const conditionTwo = `0x${"0".repeat(64)}`;
    const conditionThree = `0x${"2".repeat(64)}`;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.origin === "https://gamma.example" && url.pathname === "/search-v2") {
        const page = url.searchParams.get("page");
        if (page === "1") {
          return jsonResponse({
            events: [
              null,
              {
                title: "Event One",
                markets: [
                  null,
                  {
                    slug: "dup-market",
                    question: "Duplicate once",
                    conditionId: conditionOne,
                    lastTradePrice: "0.5",
                    outcomes: '["Yes","No"]',
                    outcomePrices: '["0.5","0.5"]',
                  },
                  {
                    slug: "dup-market",
                    question: "Duplicate twice",
                    conditionId: conditionOne,
                    lastTradePrice: "0.4",
                  },
                  {
                    slug: "title-fallback",
                    title: "Fallback title",
                    conditionId: conditionTwo,
                    outcomePrice: "0.33",
                    liquidity: "100",
                  },
                ],
              },
            ],
            pagination: { hasMore: true },
          });
        }
        if (page === "2") {
          return jsonResponse({
            events: [
              {
                title: "Event Two",
                markets: [
                  {
                    slug: "second-page",
                    question: "Second page",
                    conditionId: conditionThree,
                    lastTradePrice: "0.61",
                    volume24hr: "42",
                  },
                ],
              },
            ],
            pagination: { hasMore: false },
          });
        }
      }
      throw new Error(`Unexpected fetch url: ${String(input)}`);
    });

    const adapter = makeAdapter();
    const results = await adapter.search("iran", { limit: 3, offset: 0 });

    expect(results.map((row) => row.reference)).toEqual(["dup-market", "title-fallback", "second-page"]);
    expect(results[0]?.metadata).toMatchObject({
      conditionId: conditionOne,
      outcomes: ["Yes", "No"],
      outcomePrices: [0.5, 0.5],
      defaultOutcome: "Yes",
    });
    expect(results[1]).toMatchObject({ name: "Fallback title", price: 0.33, liquidity: 100 });
  });

  it("supports endingSoon, newest, liquidity, and fallback browse sorting", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith("https://gamma.example/events")) {
        return jsonResponse([
          {
            title: "Sooner",
            liquidity: "900",
            endDate: "2026-03-08T00:00:00.000Z",
            createdAt: "2026-03-07T00:00:00.000Z",
            markets: [{ slug: "soon-market", question: "Soon market", volume24hr: "10" }],
          },
          {
            title: "Newer",
            liquidity: "1200",
            endDate: "2026-03-12T00:00:00.000Z",
            createdAt: "2026-03-09T00:00:00.000Z",
            markets: [{ slug: "liquid-market", question: "Liquid market", volume24hr: "90" }],
          },
          {
            title: "No End",
            liquidity: "100",
            createdAt: "2026-03-01T00:00:00.000Z",
            markets: [{ slug: "no-end-market", question: "No end market", volume24hr: "20" }],
          },
        ]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();

    expect((await adapter.browse?.({ sort: "endingSoon", limit: 3, offset: 0 }))?.map((row) => row.reference)).toEqual([
      "soon-market",
      "liquid-market",
      "no-end-market",
    ]);
    expect((await adapter.browse?.({ sort: "newest", limit: 3, offset: 0 }))?.map((row) => row.reference)).toEqual([
      "liquid-market",
      "soon-market",
      "no-end-market",
    ]);
    expect((await adapter.browse?.({ sort: "liquidity", limit: 3, offset: 0 }))?.map((row) => row.reference)).toEqual([
      "liquid-market",
      "soon-market",
      "no-end-market",
    ]);
    expect((await adapter.browse?.({ sort: "not-a-sort", limit: 3, offset: 0 }))?.map((row) => row.reference)).toEqual([
      "liquid-market",
      "no-end-market",
      "soon-market",
    ]);
  });

  it("returns static trading constraints", async () => {
    const adapter = makeAdapter();
    await expect(adapter.getTradingConstraints("anything")).resolves.toEqual({
      minQuantity: 1,
      quantityStep: 1,
      supportsFractional: false,
      maxLeverage: null,
    });
  });

  it("rejects condition and slug references without token mappings", async () => {
    const conditionId = `0x${"3".repeat(64)}`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === `https://gamma.example/markets?conditionId=${conditionId}&limit=1`) {
        return jsonResponse([{ conditionId, clobTokenIds: "[]" }]);
      }
      if (url === "https://gamma.example/markets?slug=missing-token&limit=1") {
        return jsonResponse([{ slug: "missing-token", conditionId: `0x${"4".repeat(64)}`, clobTokenIds: "not-json" }]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    await expect(adapter.normalizeReference(conditionId)).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
    });
    await expect(adapter.normalizeReference("missing-token")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
    });
  });

  it("parses mixed orderbook rows, computes quotes, and remaps cached orderbooks", async () => {
    const conditionId = `0x${"5".repeat(64)}`;
    const tokenId = "777";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gamma.example/markets?slug=mixed-market&limit=1") {
        return jsonResponse([{ slug: "mixed-market", conditionId, clobTokenIds: JSON.stringify([tokenId]) }]);
      }
      if (url === `https://clob.example/book?token_id=${tokenId}`) {
        return jsonResponse({
          bids: [["bad", "1"], { price: "0.41", size: "5" }],
          asks: [["0.55", "2"], { price: "oops", size: "1" }, ["0.53", "1"]],
        });
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    const quote = await adapter.getQuote("mixed-market");
    const book = await adapter.getOrderbook(tokenId);

    expect(quote).toMatchObject({ reference: "mixed-market", bid: 0.41, ask: 0.53, price: 0.47 });
    expect(book.reference).toBe(tokenId);
    expect(book.bids).toEqual([{ price: 0.41, size: 5 }]);
    expect(book.asks).toEqual([{ price: 0.53, size: 1 }, { price: 0.55, size: 2 }]);
  });

  it("rejects empty quotes and invalid orderbook payloads", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gamma.example/markets?slug=empty-book&limit=1") {
        return jsonResponse([{ slug: "empty-book", conditionId: `0x${"6".repeat(64)}`, clobTokenIds: JSON.stringify(["888"]) }]);
      }
      if (url === "https://clob.example/book?token_id=888") {
        return jsonResponse({ bids: [], asks: [] });
      }
      if (url === "https://gamma.example/markets?slug=invalid-book&limit=1") {
        return jsonResponse([{ slug: "invalid-book", conditionId: `0x${"7".repeat(64)}`, clobTokenIds: JSON.stringify(["889"]) }]);
      }
      if (url === "https://clob.example/book?token_id=889") {
        return jsonResponse("invalid-book", 200);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    await expect(adapter.getQuote("empty-book")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "SYMBOL_NOT_FOUND",
    });
    await expect(adapter.getOrderbook("invalid-book")).rejects.toMatchObject<Partial<MarketAdapterError>>({
      code: "UPSTREAM_ERROR",
    });
  });

  it("returns null for unresolved references and missing markets", async () => {
    const missingCondition = `0x${"8".repeat(64)}`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://gamma.example/markets?slug=missing-market&limit=1") {
        return jsonResponse([]);
      }
      if (url === `https://gamma.example/markets?conditionId=${missingCondition}&limit=1`) {
        return jsonResponse([]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    await expect(adapter.resolve("missing-market")).resolves.toBeNull();
    await expect(adapter.resolve(missingCondition)).resolves.toBeNull();
  });

  it("resolves symbol names from token objects and fallback outcome arrays", async () => {
    const conditionId = `0x${"9".repeat(64)}`;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === `https://gamma.example/markets?conditionId=${conditionId}&limit=1`) {
        return jsonResponse([
          {
            question: "Will turnout exceed 60%?",
            conditionId,
            tokens: [
              null,
              { token_id: "11", outcome: "Yes" },
              { token_id: "12" },
            ],
            clobTokenIds: JSON.stringify(["11", "12", "13"]),
            outcomes: JSON.stringify(["Yes", "No", "Maybe"]),
          },
        ]);
      }
      if (url === "https://gamma.example/markets?clob_token_ids=13&limit=1") {
        return jsonResponse([
          {
            question: "Will turnout exceed 60%?",
            conditionId,
            clobTokenIds: JSON.stringify(["11", "12", "13"]),
            outcomes: JSON.stringify(["Yes", "No", "Maybe"]),
          },
        ]);
      }
      throw new Error(`Unexpected fetch url: ${url}`);
    });

    const adapter = makeAdapter();
    const resolution = await adapter.resolveSymbolNames([conditionId, "11", "12", "13"]);

    expect(resolution.names.get(conditionId)).toBe("Will turnout exceed 60%?");
    expect(resolution.names.get("11")).toBe("Will turnout exceed 60%?");
    expect(resolution.outcomes.get("11")).toBe("Yes");
    expect(resolution.outcomes.get("12")).toBe("No");
    expect(resolution.outcomes.get("13")).toBe("Maybe");
  });

});
