import { afterEach, describe, expect, it, vi } from "vitest";

import { HyperliquidAdapter } from "../src/hyperliquid.js";
import { MarketAdapterError } from "../src/types.js";

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

describe("HyperliquidAdapter", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("has correct adapter metadata", () => {
        const adapter = makeAdapter();
        expect(adapter.marketId).toBe("hyperliquid");
        expect(adapter.displayName).toBe("Hyperliquid");
        expect(adapter.priceRange).toBeNull();
        expect(adapter.capabilities).toContain("funding");
        expect(adapter.capabilities).toContain("quote");
        expect(adapter.capabilities).toContain("orderbook");
        expect(adapter.capabilities).toContain("search");
    });

    it("searches assets by query and caches meta", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.type === "meta") return jsonResponse(META_RESPONSE);
            if (body.type === "allMids") return jsonResponse({ BTC: "95000.5", ETH: "3200.1", SOL: "180.5", DOGE: "0.25" });
            throw new Error(`Unexpected request type: ${body.type}`);
        });

        const adapter = makeAdapter();
        const results = await adapter.search("btc");

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({
            symbol: "BTC",
            name: "BTC-PERP",
            price: 95000.5,
        });

        // Second call should use cache for meta
        await adapter.search("eth");
        // meta is called once (cached), allMids may be called again if TTL expired
        const metaCalls = fetchSpy.mock.calls.filter(([, init]) => {
            const body = JSON.parse((init as RequestInit).body as string);
            return body.type === "meta";
        });
        expect(metaCalls).toHaveLength(1);
    });

    it("returns all assets when query is empty", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.type === "meta") return jsonResponse(META_RESPONSE);
            if (body.type === "allMids") return jsonResponse({});
            throw new Error(`Unexpected request type: ${body.type}`);
        });

        const adapter = makeAdapter();
        const results = await adapter.search("");

        expect(results).toHaveLength(4);
        expect(results.map((r) => r.symbol)).toEqual(["BTC", "ETH", "SOL", "DOGE"]);
    });

    it("excludes delisted assets from search results", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.type === "meta") return jsonResponse(META_WITH_DELISTED);
            if (body.type === "allMids") return jsonResponse({ BTC: "95000.5" });
            throw new Error(`Unexpected request type: ${body.type}`);
        });

        const adapter = makeAdapter();
        const results = await adapter.search("");

        expect(results).toHaveLength(1);
        expect(results[0]?.symbol).toBe("BTC");
    });

    it("supports pagination in search", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.type === "meta") return jsonResponse(META_RESPONSE);
            if (body.type === "allMids") return jsonResponse({});
            throw new Error(`Unexpected request type: ${body.type}`);
        });

        const adapter = makeAdapter();
        const results = await adapter.search("", { limit: 2, offset: 1 });

        expect(results).toHaveLength(2);
        expect(results[0]?.symbol).toBe("ETH");
        expect(results[1]?.symbol).toBe("SOL");
    });

    it("normalizes symbol aliases and perp suffixes", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.type === "meta") return jsonResponse(META_RESPONSE);
            throw new Error(`Unexpected request type: ${body.type}`);
        });

        const adapter = makeAdapter();
        await expect(adapter.normalizeSymbol(" btc-perp ")).resolves.toBe("BTC");
        await expect(adapter.normalizeSymbol("eth")).resolves.toBe("ETH");
        await expect(adapter.normalizeSymbol("unknown")).rejects.toMatchObject<Partial<MarketAdapterError>>({
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

        expect(first.symbol).toBe("BTC");
        expect(first.price).toBe(95000);
        expect(first.bid).toBe(94990);
        expect(first.ask).toBe(95010);
        expect(second).toEqual(first);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("builds quote from bid-only book", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.type === "meta") return jsonResponse(META_RESPONSE);
            if (body.type === "l2Book") {
                return jsonResponse(makeL2Book([["100.5", "10"]], []));
            }
            throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
        });

        const adapter = makeAdapter();
        const quote = await adapter.getQuote("SOL");

        expect(quote.price).toBe(100.5);
        expect(quote.bid).toBe(100.5);
        expect(quote.ask).toBeUndefined();
    });

    it("throws SYMBOL_NOT_FOUND on empty book", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.type === "meta") return jsonResponse(META_RESPONSE);
            if (body.type === "l2Book") {
                return jsonResponse(makeL2Book([], []));
            }
            throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
        });

        const adapter = makeAdapter();
        await expect(adapter.getQuote("INVALID")).rejects.toMatchObject<Partial<MarketAdapterError>>({
            code: "SYMBOL_NOT_FOUND",
        });
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

        expect(book.symbol).toBe("ETH");
        expect(book.bids.map((l) => l.price)).toEqual([94990, 94980, 94970]);
        expect(book.asks.map((l) => l.price)).toEqual([95010, 95020, 95030]);
    });

    it("gets funding rate for a symbol", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.type === "meta") return jsonResponse(META_RESPONSE);
            if (body.type === "predictedFundings") {
                return jsonResponse([
                    [
                        "BTC",
                        [
                            ["BinPerp", { fundingRate: "0.0002", nextFundingTime: 1700000000000 }],
                            ["HlPerp", { fundingRate: "0.0001", nextFundingTime: 1700000000000 }],
                        ],
                    ],
                    [
                        "ETH",
                        [
                            ["HlPerp", { fundingRate: "-0.00005", nextFundingTime: 1700000000000 }],
                        ],
                    ],
                ]);
            }
            throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
        });

        const adapter = makeAdapter();
        const btcFunding = await adapter.getFundingRate("btc-perp");

        expect(btcFunding.symbol).toBe("BTC");
        expect(btcFunding.rate).toBe(0.0001);
        expect(btcFunding.nextFundingAt).toBeTruthy();
    });

    it("supports legacy predictedFundings tuple format", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.type === "meta") return jsonResponse(META_RESPONSE);
            if (body.type === "predictedFundings") {
                return jsonResponse([
                    ["Hyperliquid", { coin: "BTC", fundingRate: "0.0001", nextFundingTime: 1700000000000 }],
                    ["Binance Perp", { coin: "BTC", fundingRate: "0.0002", nextFundingTime: 1700000000000 }],
                ]);
            }
            throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
        });

        const adapter = makeAdapter();
        const btcFunding = await adapter.getFundingRate("BTC");
        expect(btcFunding.rate).toBe(0.0001);
    });

    it("throws SYMBOL_NOT_FOUND for unknown coin funding rate", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.type === "meta") return jsonResponse(META_RESPONSE);
            if (body.type === "predictedFundings") {
                return jsonResponse([
                    ["BTC", [["HlPerp", { fundingRate: "0.0001", nextFundingTime: 1700000000000 }]]],
                ]);
            }
            throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
        });

        const adapter = makeAdapter();
        await expect(adapter.getFundingRate("UNKNOWN")).rejects.toMatchObject<Partial<MarketAdapterError>>({
            code: "SYMBOL_NOT_FOUND",
        });
    });

    it("raises UPSTREAM_ERROR on non-200 responses", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("server error", { status: 500 }));

        const adapter = makeAdapter();
        await expect(adapter.search("BTC")).rejects.toMatchObject<Partial<MarketAdapterError>>({
            code: "UPSTREAM_ERROR",
        });
    });

    it("raises UPSTREAM_ERROR on invalid meta response", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse("not-an-object"));

        const adapter = makeAdapter();
        await expect(adapter.search("BTC")).rejects.toMatchObject<Partial<MarketAdapterError>>({
            code: "UPSTREAM_ERROR",
        });
    });

    it("raises UPSTREAM_ERROR on invalid l2Book response", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.type === "meta") return jsonResponse(META_RESPONSE);
            if (body.type === "l2Book") return jsonResponse({ wrong: "shape" });
            throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
        });

        const adapter = makeAdapter();
        await expect(adapter.getQuote("BTC")).rejects.toMatchObject<Partial<MarketAdapterError>>({
            code: "UPSTREAM_ERROR",
        });
    });

    it("caches funding rate results", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.type === "meta") return jsonResponse(META_RESPONSE);
            if (body.type === "predictedFundings") {
                return jsonResponse([
                    ["BTC", [["HlPerp", { fundingRate: "0.0001", nextFundingTime: 1700000000000 }]]],
                ]);
            }
            throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
        });

        const adapter = makeAdapter();
        const first = await adapter.getFundingRate("BTC");
        const second = await adapter.getFundingRate("BTC");

        expect(first.rate).toBe(0.0001);
        expect(second).toEqual(first);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("reuses predictedFundings cache across different symbols", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.type === "meta") return jsonResponse(META_RESPONSE);
            if (body.type === "predictedFundings") {
                return jsonResponse([
                    ["BTC", [["HlPerp", { fundingRate: "0.0001", nextFundingTime: 1700000000000 }]]],
                    ["ETH", [["HlPerp", { fundingRate: "0.0002", nextFundingTime: 1700000000000 }]]],
                ]);
            }
            throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
        });

        const adapter = makeAdapter();
        const btc = await adapter.getFundingRate("BTC");
        const eth = await adapter.getFundingRate("ETH");
        expect(btc.rate).toBe(0.0001);
        expect(eth.rate).toBe(0.0002);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("does not fall back to legacy shape when current coin match has no usable funding entry", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
            const body = JSON.parse((init as RequestInit).body as string);
            if (body.type === "meta") return jsonResponse(META_RESPONSE);
            if (body.type === "predictedFundings") {
                return jsonResponse([
                    ["BTC", [["BinPerp", null]]],
                    ["Hyperliquid", { coin: "BTC", fundingRate: "0.0001", nextFundingTime: 1700000000000 }],
                ]);
            }
            throw new Error(`Unexpected request: ${JSON.stringify(body)}`);
        });

        const adapter = makeAdapter();
        await expect(adapter.getFundingRate("BTC")).rejects.toMatchObject<Partial<MarketAdapterError>>({
            code: "SYMBOL_NOT_FOUND",
        });
    });

    it("throws UPSTREAM_TIMEOUT when fetch exceeds timeout", async () => {
        vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));

        const adapter = makeAdapter();
        await expect(adapter.search("BTC")).rejects.toMatchObject<Partial<MarketAdapterError>>({
            code: "UPSTREAM_TIMEOUT",
        });
    });
});
