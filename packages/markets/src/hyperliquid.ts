import { TtlCache } from "./cache.js";
import {
    MarketAdapterError,
    type Asset,
    type FundingRate,
    type MarketAdapter,
    type Orderbook,
    type OrderbookLevel,
    type Quote,
    type SearchOptions,
    type TradingConstraints,
} from "./types.js";

const QUOTE_TTL_MS = 5_000;
const ORDERBOOK_TTL_MS = 5_000;
const META_TTL_MS = 300_000;
const FUNDING_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

const DEFAULT_API_URL = "https://api.hyperliquid.xyz/info";

type UnknownObject = Record<string, unknown>;

const parseNumber = (value: unknown): number | null => {
    if (typeof value === "number" && !Number.isNaN(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
};

const postInfo = async <T>(apiUrl: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> => {
    let response: Response;
    try {
        response = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === "TimeoutError") {
            throw new MarketAdapterError("UPSTREAM_TIMEOUT", `Hyperliquid API timeout (${timeoutMs}ms): ${String(body.type ?? "info")}`);
        }
        const message = error instanceof Error ? error.message : "Unknown fetch error";
        throw new MarketAdapterError("UPSTREAM_ERROR", `Hyperliquid API request failed: ${message}`);
    }

    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new MarketAdapterError("UPSTREAM_ERROR", `Hyperliquid API error (${response.status}): ${text}`);
    }

    return (await response.json()) as T;
};

export type HyperliquidAdapterOptions = {
    apiUrl?: string;
    requestTimeoutMs?: number;
};

type MetaUniverse = {
    name: string;
    szDecimals: number;
    maxLeverage: number;
    isDelisted?: boolean;
};

type MetaResponse = {
    universe: MetaUniverse[];
};

type L2BookResponse = {
    levels: Array<Array<{ px: string; sz: string; n: number }>>;
};

type PredictedFundingEntry = {
    coin?: string;
    fundingRate: string | number;
    nextFundingTime: number | string;
};

type CurrentFundingParseResult = {
    matchedCoin: boolean;
    entry: PredictedFundingEntry | null;
};

const parseEpochMs = (value: unknown): number | null => {
    const numeric = parseNumber(value);
    if (numeric === null || !Number.isFinite(numeric)) return null;
    const ms = numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
    return Math.trunc(ms);
};

const isHyperliquidVenue = (value: unknown): boolean => {
    if (typeof value !== "string") return false;
    const venue = value.toLowerCase();
    return venue === "hlperp" || venue === "hyperliquid";
};

const asFundingEntry = (value: unknown): PredictedFundingEntry | null => {
    if (typeof value !== "object" || value === null) return null;
    return value as PredictedFundingEntry;
};

const parseCurrentShapeFundingEntry = (data: unknown[], normalizedSymbol: string): CurrentFundingParseResult => {
    for (const item of data) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const coin = item[0];
        const venues = item[1];
        if (typeof coin !== "string" || coin !== normalizedSymbol || !Array.isArray(venues)) continue;

        let fallback: PredictedFundingEntry | null = null;
        for (const venueItem of venues) {
            if (!Array.isArray(venueItem) || venueItem.length < 2) continue;
            const venue = venueItem[0];
            const info = asFundingEntry(venueItem[1]);
            if (!info) continue;
            if (fallback === null) fallback = info;
            if (isHyperliquidVenue(venue)) {
                return { matchedCoin: true, entry: info };
            }
        }
        return { matchedCoin: true, entry: fallback };
    }

    return { matchedCoin: false, entry: null };
};

const parseLegacyShapeFundingEntry = (data: unknown[], normalizedSymbol: string): PredictedFundingEntry | null => {
    for (const item of data) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const venue = item[0];
        const info = asFundingEntry(item[1]);
        if (!info) continue;
        if (info.coin !== normalizedSymbol) continue;
        if (!isHyperliquidVenue(venue)) continue;
        return info;
    }
    return null;
};

export class HyperliquidAdapter implements MarketAdapter {
    readonly marketId = "hyperliquid";
    readonly displayName = "Hyperliquid";
    readonly description = "Crypto perpetual futures — no expiry, funding rate every hour";
    readonly symbolFormat = "Ticker (e.g. BTC, ETH, SOL)";
    readonly priceRange: [number, number] | null = null;
    readonly capabilities = ["search", "quote", "orderbook", "funding"] as const;

    private readonly apiUrl: string;
    private readonly cache = new TtlCache();
    private readonly requestTimeoutMs: number;

    constructor(options: HyperliquidAdapterOptions = {}) {
        this.apiUrl = options.apiUrl ?? DEFAULT_API_URL;
        this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    }

    private buildTradingConstraints(asset: MetaUniverse): TradingConstraints {
        const decimals = Math.max(0, Math.trunc(asset.szDecimals));
        const quantityStep = decimals === 0 ? 1 : Number((10 ** -decimals).toFixed(decimals));
        return {
            minQuantity: quantityStep,
            quantityStep,
            supportsFractional: decimals > 0,
            maxLeverage: asset.maxLeverage,
        };
    }

    private async findMetaBySymbol(symbol: string): Promise<MetaUniverse> {
        const candidate = symbol.trim().replace(/[-_\s]*perp$/i, "").toUpperCase();
        const universe = await this.getMeta();
        const matched = universe.find((asset) => asset.name.toUpperCase() === candidate);
        if (!matched) {
            throw new MarketAdapterError("SYMBOL_NOT_FOUND", `Unknown Hyperliquid symbol: ${symbol}`);
        }
        return matched;
    }

    private async getMeta(): Promise<MetaUniverse[]> {
        const cached = this.cache.get<MetaUniverse[]>("meta");
        if (cached) return cached;

        const data = await postInfo<MetaResponse>(this.apiUrl, { type: "meta" }, this.requestTimeoutMs);

        if (!data || !Array.isArray(data.universe)) {
            throw new MarketAdapterError("UPSTREAM_ERROR", "Invalid meta response from Hyperliquid");
        }

        this.cache.set("meta", data.universe, META_TTL_MS);
        return data.universe;
    }

    private async getL2Book(symbol: string): Promise<L2BookResponse> {
        const cacheKey = `l2:${symbol}`;
        const cached = this.cache.get<L2BookResponse>(cacheKey);
        if (cached) return cached;

        const data = await postInfo<L2BookResponse>(this.apiUrl, {
            type: "l2Book",
            coin: symbol,
        }, this.requestTimeoutMs);

        if (!data || !Array.isArray(data.levels)) {
            throw new MarketAdapterError("UPSTREAM_ERROR", "Invalid l2Book response from Hyperliquid");
        }

        this.cache.set(cacheKey, data, ORDERBOOK_TTL_MS);
        return data;
    }

    async normalizeSymbol(symbol: string): Promise<string> {
        const raw = symbol.trim();
        if (raw.length === 0) {
            throw new MarketAdapterError("SYMBOL_NOT_FOUND", "Symbol is required");
        }
        const matched = await this.findMetaBySymbol(raw);
        return matched.name;
    }

    async getTradingConstraints(symbol: string): Promise<TradingConstraints> {
        const matched = await this.findMetaBySymbol(symbol);
        return this.buildTradingConstraints(matched);
    }

    async search(query: string, options?: SearchOptions): Promise<Asset[]> {
        const universe = await this.getMeta();
        const limit = options?.limit ?? 20;
        const offset = options?.offset ?? 0;
        const lowerQuery = query.toLowerCase().trim();
        const listed = universe.filter((asset) => !asset.isDelisted);

        const filtered = lowerQuery
            ? listed.filter((asset) => asset.name.toLowerCase().includes(lowerQuery))
            : listed;

        const page = filtered.slice(offset, offset + limit);

        // Fetch mid prices for the page to include current price
        let midPrices: Record<string, string> = {};
        try {
            midPrices = await this.getAllMids();
        } catch {
            // mid prices are optional enrichment; proceed without them
        }

        return page.map((asset) => ({
            symbol: asset.name,
            name: `${asset.name}-PERP`,
            price: parseNumber(midPrices[asset.name]) ?? undefined,
            metadata: {
                szDecimals: asset.szDecimals,
                maxLeverage: asset.maxLeverage,
                ...this.buildTradingConstraints(asset),
            },
        }));
    }

    private async getAllMids(): Promise<Record<string, string>> {
        const cached = this.cache.get<Record<string, string>>("allMids");
        if (cached) return cached;

        const data = await postInfo<Record<string, string>>(this.apiUrl, { type: "allMids" }, this.requestTimeoutMs);
        this.cache.set("allMids", data, QUOTE_TTL_MS);
        return data;
    }

    private async getPredictedFundings(): Promise<unknown[]> {
        const cached = this.cache.get<unknown[]>("predictedFundings");
        if (cached) return cached;

        const data = await postInfo<unknown>(this.apiUrl, {
            type: "predictedFundings",
        }, this.requestTimeoutMs);

        if (!Array.isArray(data)) {
            throw new MarketAdapterError("UPSTREAM_ERROR", "Invalid predictedFundings response from Hyperliquid");
        }

        this.cache.set("predictedFundings", data, FUNDING_TTL_MS);
        return data;
    }

    async getQuote(symbol: string): Promise<Quote> {
        const normalizedSymbol = await this.normalizeSymbol(symbol);
        const cacheKey = `quote:${normalizedSymbol}`;
        const cached = this.cache.get<Quote>(cacheKey);
        if (cached) return cached;

        const book = await this.getL2Book(normalizedSymbol);
        const bids = book.levels[0] ?? [];
        const asks = book.levels[1] ?? [];

        const bestBid = bids.length > 0 ? parseNumber(bids[0].px) : null;
        const bestAsk = asks.length > 0 ? parseNumber(asks[0].px) : null;

        if (bestBid === null && bestAsk === null) {
            throw new MarketAdapterError("SYMBOL_NOT_FOUND", `No order book data for ${normalizedSymbol}`);
        }

        const mid =
            bestBid !== null && bestAsk !== null
                ? (bestBid + bestAsk) / 2
                : (bestBid ?? bestAsk)!;

        const quote: Quote = {
            symbol: normalizedSymbol,
            price: Number(mid.toFixed(6)),
            bid: bestBid ?? undefined,
            ask: bestAsk ?? undefined,
            timestamp: new Date().toISOString(),
        };

        this.cache.set(cacheKey, quote, QUOTE_TTL_MS);
        return quote;
    }

    async getOrderbook(symbol: string): Promise<Orderbook> {
        const normalizedSymbol = await this.normalizeSymbol(symbol);
        const cacheKey = `ob:${normalizedSymbol}`;
        const cached = this.cache.get<Orderbook>(cacheKey);
        if (cached) return cached;

        const book = await this.getL2Book(normalizedSymbol);
        const rawBids = book.levels[0] ?? [];
        const rawAsks = book.levels[1] ?? [];

        const parseLevels = (levels: Array<{ px: string; sz: string }>): OrderbookLevel[] =>
            levels
                .map((level) => {
                    const price = parseNumber(level.px);
                    const size = parseNumber(level.sz);
                    if (price === null || size === null) return null;
                    return { price, size };
                })
                .filter((level): level is OrderbookLevel => level !== null);

        const bids = parseLevels(rawBids).sort((a, b) => b.price - a.price);
        const asks = parseLevels(rawAsks).sort((a, b) => a.price - b.price);

        const orderbook: Orderbook = {
            symbol: normalizedSymbol,
            bids,
            asks,
            timestamp: new Date().toISOString(),
        };

        this.cache.set(cacheKey, orderbook, ORDERBOOK_TTL_MS);
        return orderbook;
    }

    async getFundingRate(symbol: string): Promise<FundingRate> {
        const normalizedSymbol = await this.normalizeSymbol(symbol);
        const cacheKey = `funding:${normalizedSymbol}`;
        const cached = this.cache.get<FundingRate>(cacheKey);
        if (cached) return cached;

        const data = await this.getPredictedFundings();

        const currentShape = parseCurrentShapeFundingEntry(data, normalizedSymbol);
        const entry =
            currentShape.entry ??
            (currentShape.matchedCoin ? null : parseLegacyShapeFundingEntry(data, normalizedSymbol));

        if (!entry) {
            throw new MarketAdapterError("SYMBOL_NOT_FOUND", `No funding rate data for ${normalizedSymbol}`);
        }

        const rate = parseNumber(entry.fundingRate);
        if (rate === null) {
            throw new MarketAdapterError("UPSTREAM_ERROR", `Invalid funding rate for ${normalizedSymbol}`);
        }

        const nextFundingTimeMs = parseEpochMs(entry.nextFundingTime);
        if (nextFundingTimeMs === null) {
            throw new MarketAdapterError("UPSTREAM_ERROR", `Invalid next funding timestamp for ${normalizedSymbol}`);
        }

        const fundingRate: FundingRate = {
            symbol: normalizedSymbol,
            rate,
            nextFundingAt: new Date(nextFundingTimeMs).toISOString(),
            timestamp: new Date().toISOString(),
        };

        this.cache.set(cacheKey, fundingRate, FUNDING_TTL_MS);
        return fundingRate;
    }
}
