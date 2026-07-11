import { TtlCache } from "./cache.js";
import {
    buildPriceHistoryResult,
    DEFAULT_PRICE_HISTORY_LOOKBACKS_BY_INTERVAL,
    DEFAULT_PRICE_HISTORY_MAX_CANDLES,
    DEFAULT_PRICE_HISTORY_SUPPORTED_LOOKBACKS,
    PRICE_HISTORY_INTERVAL_MS,
    resolvePriceHistoryRange,
} from "./history.js";
import {
    MarketAdapterError,
    type BrowseOption,
    type BrowseOptions,
    type FundingRate,
    type FundingPreview,
    type MarketAdapter,
    type MarketReference,
    type Orderbook,
    type OrderbookLevel,
    type PriceHistoryResult,
    type PriceHistorySupport,
    type PriceHistoryOptions,
    type Quote,
    type SearchOptions,
    type TradingConstraints,
    annualizeFundingRate,
    fundingDirectionFromRate,
} from "./types.js";

const QUOTE_TTL_MS = 5_000;
const ORDERBOOK_TTL_MS = 5_000;
const META_TTL_MS = 300_000;
const FUNDING_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_BROWSE_CACHE_TTL_MS = 300_000;
const HOUR_MS = 3_600_000;
const HYPERLIQUID_FUNDING_INTERVAL_HOURS = 1;
const DEFAULT_PERP_DEX_CACHE_KEY = "default";

const CANDLE_TTL_MS: Record<string, number> = {
    "1m": 60_000,
    "5m": 120_000,
    "15m": 300_000,
    "1h": 300_000,
    "4h": 600_000,
    "1d": 1_800_000,
};
const HYPERLIQUID_BROWSE_OPTIONS: readonly BrowseOption[] = [
    { value: "price", label: "Price" },
    { value: "volume", label: "Volume" },
    { value: "openInterest", label: "Open Interest" },
];
const HYPERLIQUID_PRICE_HISTORY: PriceHistorySupport = {
    nativeIntervals: ["1m", "5m", "15m", "1h", "4h", "1d"],
    supportedIntervals: ["1m", "5m", "15m", "1h", "4h", "1d"],
    defaultInterval: "1h",
    supportedLookbacks: DEFAULT_PRICE_HISTORY_SUPPORTED_LOOKBACKS,
    defaultLookbacks: DEFAULT_PRICE_HISTORY_LOOKBACKS_BY_INTERVAL,
    maxCandles: DEFAULT_PRICE_HISTORY_MAX_CANDLES,
    supportsCustomRange: true,
    supportsResampling: false,
};

const DEFAULT_API_URL = "https://api.hyperliquid.xyz/info";

const parseNumber = (value: unknown): number | null => {
    if (typeof value === "number" && !Number.isNaN(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isNaN(parsed) ? null : parsed;
    }
    return null;
};

const getNextHourlyFundingAt = (now = Date.now()): string => {
    return new Date(Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS).toISOString();
};

const buildFundingPreview = (rate: number, nextFundingAt: string, timestamp = new Date().toISOString()): FundingPreview => {
    const annualizedRate = annualizeFundingRate(rate, HYPERLIQUID_FUNDING_INTERVAL_HOURS);
    return {
        rate,
        nextFundingAt,
        timestamp,
        direction: fundingDirectionFromRate(rate),
        intervalHours: HYPERLIQUID_FUNDING_INTERVAL_HOURS,
        annualizedRate: annualizedRate ?? undefined,
    };
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
    browseCacheTtlMs?: number;
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

type PerpDexDescriptor = {
    name: string;
};

type L2BookResponse = {
    levels: Array<Array<{ px: string; sz: string; n: number }>>;
};

type AssetContext = {
    dayNtlVlm: string;
    openInterest: string;
    funding: string;
    prevDayPx: string;
    midPx?: string;
    markPx?: string;
};

type PredictedFundingEntry = {
    fundingRate: string | number;
    nextFundingTime: number | string;
};

type DiscoveryMetric = "price" | "volume" | "openInterest";

type HyperliquidDiscoveryContext = {
    ctxMap: Map<string, AssetContext>;
};

type HyperliquidDiscoveryEntry = {
    asset: MetaUniverse;
    index: number;
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

const parseFundingEntry = (data: unknown[], normalizedSymbol: string): PredictedFundingEntry | null => {
    for (const item of data) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const coin = item[0];
        const venues = item[1];
        if (typeof coin !== "string" || coin !== normalizedSymbol || !Array.isArray(venues)) continue;

        for (const venueItem of venues) {
            if (!Array.isArray(venueItem) || venueItem.length < 2) continue;
            const venue = venueItem[0];
            const info = asFundingEntry(venueItem[1]);
            if (!info) continue;
            if (isHyperliquidVenue(venue)) {
                return info;
            }
        }
        return null;
    }

    return null;
};

export class HyperliquidAdapter implements MarketAdapter {
    readonly marketId = "hyperliquid";
    readonly displayName = "Hyperliquid";
    readonly description = "Perpetual futures across Hyperliquid dexes with hourly funding";
    readonly referenceFormat = "Ticker or dex-prefixed ticker (e.g. BTC, xyz:NVDA, vntl:OPENAI)";
    readonly priceRange: [number, number] | null = null;
    readonly browseOptions = HYPERLIQUID_BROWSE_OPTIONS;
    readonly searchSortOptions = HYPERLIQUID_BROWSE_OPTIONS;
    readonly priceHistory = HYPERLIQUID_PRICE_HISTORY;

    private readonly apiUrl: string;
    private readonly cache = new TtlCache();
    private readonly requestTimeoutMs: number;
    private readonly browseCacheTtlMs: number;

    constructor(options: HyperliquidAdapterOptions = {}) {
        this.apiUrl = options.apiUrl ?? DEFAULT_API_URL;
        this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
        this.browseCacheTtlMs = options.browseCacheTtlMs ?? DEFAULT_BROWSE_CACHE_TTL_MS;
    }

    private getDexCacheKey(dex: string | null): string {
        return dex ?? DEFAULT_PERP_DEX_CACHE_KEY;
    }

    private buildDexRequest(type: string, dex: string | null, extra?: Record<string, unknown>): Record<string, unknown> {
        return dex === null ? { type, ...(extra ?? {}) } : { type, dex, ...(extra ?? {}) };
    }

    private async getPerpDexes(): Promise<Array<string | null>> {
        return this.cache.remember("perpDexs", {
            ttlMs: META_TTL_MS,
            load: async () => {
                const data = await postInfo<unknown[]>(this.apiUrl, { type: "perpDexs" }, this.requestTimeoutMs);
                if (!Array.isArray(data)) {
                    throw new MarketAdapterError("UPSTREAM_ERROR", "Invalid perpDexs response from Hyperliquid");
                }

                const dexs: Array<string | null> = [];
                let sawDefaultDex = false;

                for (const entry of data) {
                    if (entry === null) {
                        sawDefaultDex = true;
                        dexs.push(null);
                        continue;
                    }

                    if (typeof entry !== "object" || entry === null || typeof (entry as PerpDexDescriptor).name !== "string") {
                        throw new MarketAdapterError("UPSTREAM_ERROR", "Invalid perpDexs response from Hyperliquid");
                    }

                    const name = (entry as PerpDexDescriptor).name.trim();
                    if (name.length === 0) {
                        throw new MarketAdapterError("UPSTREAM_ERROR", "Invalid perpDexs response from Hyperliquid");
                    }
                    dexs.push(name);
                }

                if (!sawDefaultDex) {
                    dexs.unshift(null);
                }

                return dexs;
            },
        });
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

    private withRequestedReference<T extends { reference: string }>(payload: T, reference: string): T {
        return payload.reference === reference ? payload : { ...payload, reference };
    }

    private compareMetricDesc(left: number | null, right: number | null): number {
        if (left === null && right === null) return 0;
        if (left === null) return 1;
        if (right === null) return -1;
        if (left === right) return 0;
        return right - left;
    }

    private getSearchRelevance(reference: string, query: string): number {
        const normalizedReference = reference.toLowerCase();
        const normalizedQuery = query.toLowerCase().trim();
        const separator = normalizedReference.indexOf(":");
        const symbol = separator >= 0 ? normalizedReference.slice(separator + 1) : normalizedReference;

        if (normalizedReference === normalizedQuery) return 700;
        if (symbol === normalizedQuery) return 650;
        if (normalizedReference.startsWith(normalizedQuery)) return 500;
        if (symbol.startsWith(normalizedQuery)) return 450;
        if (symbol.includes(normalizedQuery)) return 300;
        if (normalizedReference.includes(normalizedQuery)) return 250;
        return 0;
    }

    private findMetaMatches(universe: MetaUniverse[], candidate: string): {
        exact: MetaUniverse | null;
        suffixMatches: MetaUniverse[];
    } {
        const exact = universe.find((asset) => asset.name.toUpperCase() === candidate) ?? null;
        const suffixMatches = universe.filter((asset) => {
            const upperName = asset.name.toUpperCase();
            const separator = upperName.indexOf(":");
            return separator >= 0 && upperName.slice(separator + 1) === candidate;
        });
        return { exact, suffixMatches };
    }

    private async findMetaBySymbol(symbol: string): Promise<MetaUniverse> {
        const candidate = symbol.trim().replace(/[-_\s]*perp$/i, "").toUpperCase();
        const defaultMatches = this.findMetaMatches(await this.getMeta(), candidate);
        if (defaultMatches.exact) {
            return defaultMatches.exact;
        }

        const allMatches = this.findMetaMatches(await this.getAllMeta(), candidate);
        if (allMatches.exact) {
            return allMatches.exact;
        }
        if (allMatches.suffixMatches.length === 1) {
            return allMatches.suffixMatches[0];
        }
        if (allMatches.suffixMatches.length > 1) {
            throw new MarketAdapterError(
                "SYMBOL_NOT_FOUND",
                `Ambiguous Hyperliquid symbol: ${symbol}. Use a dex-prefixed reference such as ${allMatches.suffixMatches[0].name}`,
            );
        }

        throw new MarketAdapterError("SYMBOL_NOT_FOUND", `Unknown Hyperliquid symbol: ${symbol}`);
    }

    private async getMetaForDex(dex: string | null): Promise<MetaUniverse[]> {
        return this.cache.remember(`meta:${this.getDexCacheKey(dex)}`, {
            ttlMs: META_TTL_MS,
            load: async () => {
                const data = await postInfo<MetaResponse>(this.apiUrl, this.buildDexRequest("meta", dex), this.requestTimeoutMs);

                if (!data || !Array.isArray(data.universe)) {
                    throw new MarketAdapterError("UPSTREAM_ERROR", "Invalid meta response from Hyperliquid");
                }

                return data.universe;
            },
        });
    }

    private async getMeta(): Promise<MetaUniverse[]> {
        return this.getMetaForDex(null);
    }

    private async getAllMeta(): Promise<MetaUniverse[]> {
        const dexs = await this.getPerpDexes();
        return (await Promise.all(dexs.map((dex) => this.getMetaForDex(dex)))).flat();
    }

    private async getL2Book(symbol: string): Promise<L2BookResponse> {
        const cacheKey = `l2:${symbol}`;
        return this.cache.remember(cacheKey, {
            ttlMs: ORDERBOOK_TTL_MS,
            load: async () => {
                const data = await postInfo<L2BookResponse>(this.apiUrl, {
                    type: "l2Book",
                    coin: symbol,
                }, this.requestTimeoutMs);

                if (!data || !Array.isArray(data.levels)) {
                    throw new MarketAdapterError("UPSTREAM_ERROR", "Invalid l2Book response from Hyperliquid");
                }

                return data;
            },
        });
    }

    async normalizeReference(reference: string): Promise<string> {
        const raw = reference.trim();
        if (raw.length === 0) {
            throw new MarketAdapterError("SYMBOL_NOT_FOUND", "Reference is required");
        }
        const matched = await this.findMetaBySymbol(raw);
        return matched.name;
    }

    async getTradingConstraints(reference: string): Promise<TradingConstraints> {
        const matched = await this.findMetaBySymbol(reference);
        return this.buildTradingConstraints(matched);
    }

    private async getAssetContextsForDex(dex: string | null): Promise<[MetaResponse, AssetContext[]]> {
        return this.cache.remember(`assetCtxs:${this.getDexCacheKey(dex)}`, {
            ttlMs: QUOTE_TTL_MS,
            load: async () => {
                const data = await postInfo<[MetaResponse, unknown[]]>(
                    this.apiUrl,
                    this.buildDexRequest("metaAndAssetCtxs", dex),
                    this.requestTimeoutMs,
                );

                if (!Array.isArray(data) || data.length < 2 || !Array.isArray(data[1])) {
                    throw new MarketAdapterError("UPSTREAM_ERROR", "Invalid metaAndAssetCtxs response from Hyperliquid");
                }
                if (!data[0] || !Array.isArray((data[0] as MetaResponse).universe)) {
                    throw new MarketAdapterError("UPSTREAM_ERROR", "Invalid metaAndAssetCtxs response from Hyperliquid");
                }

                return [data[0] as MetaResponse, data[1] as AssetContext[]];
            },
        });
    }

    private async getAssetContexts(): Promise<Map<string, AssetContext>> {
        const [meta, ctxs] = await this.getAssetContextsForDex(null);
        const map = new Map<string, AssetContext>();
        for (let i = 0; i < meta.universe.length && i < ctxs.length; i++) {
            map.set(meta.universe[i].name, ctxs[i]);
        }
        return map;
    }

    private async getAllAssetContexts(): Promise<Map<string, AssetContext>> {
        const dexs = await this.getPerpDexes();
        const responses = await Promise.all(dexs.map((dex) => this.getAssetContextsForDex(dex)));
        const map = new Map<string, AssetContext>();

        for (const response of responses) {
            const [meta, ctxs] = response;
            for (let i = 0; i < meta.universe.length && i < ctxs.length; i++) {
                map.set(meta.universe[i].name, ctxs[i]);
            }
        }

        return map;
    }

    private async loadDiscoveryContext(includeAllDexes: boolean): Promise<HyperliquidDiscoveryContext> {
        return { ctxMap: includeAllDexes ? await this.getAllAssetContexts() : await this.getAssetContexts() };
    }

    private getDiscoveryCtxNumber(context: HyperliquidDiscoveryContext, coin: string, field: keyof AssetContext): number | null {
        const ctx = context.ctxMap.get(coin);
        return ctx ? parseNumber(ctx[field]) : null;
    }

    private getDiscoveryPrice(context: HyperliquidDiscoveryContext, coin: string): number | null {
        const ctx = context.ctxMap.get(coin);
        return ctx ? parseNumber(ctx.midPx) ?? parseNumber(ctx.markPx) : null;
    }

    private getDiscoveryMetric(context: HyperliquidDiscoveryContext, asset: MetaUniverse, metric: DiscoveryMetric): number | null {
        if (metric === "price") return this.getDiscoveryPrice(context, asset.name);
        if (metric === "volume") return this.getDiscoveryCtxNumber(context, asset.name, "dayNtlVlm");
        return this.getDiscoveryCtxNumber(context, asset.name, "openInterest");
    }

    private sortBrowseEntries(entries: HyperliquidDiscoveryEntry[], sort: string | undefined, context: HyperliquidDiscoveryContext): void {
        const metric: DiscoveryMetric = sort === "volume" || sort === "openInterest" ? sort : "price";
        entries.sort((left, right) => {
            const comparison = this.compareMetricDesc(
                this.getDiscoveryMetric(context, left.asset, metric),
                this.getDiscoveryMetric(context, right.asset, metric),
            );
            if (comparison !== 0) {
                return comparison;
            }
            return left.index - right.index;
        });
    }

    private sortSearchEntries(
        entries: HyperliquidDiscoveryEntry[],
        query: string,
        sort: string | undefined,
        context: HyperliquidDiscoveryContext,
    ): void {
        const requestedMetric = sort === "price" || sort === "volume" || sort === "openInterest" ? sort : null;

        entries.sort((left, right) => {
            const leftRelevance = this.getSearchRelevance(left.asset.name, query);
            const rightRelevance = this.getSearchRelevance(right.asset.name, query);

            if (requestedMetric) {
                const metricComparison = this.compareMetricDesc(
                    this.getDiscoveryMetric(context, left.asset, requestedMetric),
                    this.getDiscoveryMetric(context, right.asset, requestedMetric),
                );
                if (metricComparison !== 0) {
                    return metricComparison;
                }
            } else {
                if (leftRelevance !== rightRelevance) {
                    return rightRelevance - leftRelevance;
                }

                const volumeComparison = this.compareMetricDesc(
                    this.getDiscoveryMetric(context, left.asset, "volume"),
                    this.getDiscoveryMetric(context, right.asset, "volume"),
                );
                if (volumeComparison !== 0) {
                    return volumeComparison;
                }

                const oiComparison = this.compareMetricDesc(
                    this.getDiscoveryMetric(context, left.asset, "openInterest"),
                    this.getDiscoveryMetric(context, right.asset, "openInterest"),
                );
                if (oiComparison !== 0) {
                    return oiComparison;
                }

                const priceComparison = this.compareMetricDesc(
                    this.getDiscoveryMetric(context, left.asset, "price"),
                    this.getDiscoveryMetric(context, right.asset, "price"),
                );
                if (priceComparison !== 0) {
                    return priceComparison;
                }
            }

            if (leftRelevance !== rightRelevance) {
                return rightRelevance - leftRelevance;
            }

            return left.asset.name.localeCompare(right.asset.name);
        });
    }

    private toDiscoveryReference(context: HyperliquidDiscoveryContext, asset: MetaUniverse): MarketReference {
        const ctx = context.ctxMap.get(asset.name);
        const price = this.getDiscoveryPrice(context, asset.name) ?? undefined;
        const volume = parseNumber(ctx?.dayNtlVlm) ?? undefined;
        const oi = parseNumber(ctx?.openInterest) ?? undefined;
        const funding = parseNumber(ctx?.funding) ?? undefined;
        const fundingPreview = funding === undefined ? undefined : buildFundingPreview(funding, getNextHourlyFundingAt());

        return {
            reference: asset.name,
            name: `${asset.name}-PERP`,
            price,
            volume,
            openInterest: oi,
            fundingPreview,
            metadata: {
                szDecimals: asset.szDecimals,
                ...this.buildTradingConstraints(asset),
                ...(funding !== undefined ? { funding } : {}),
            },
        };
    }

    private async listReferences({ query, sort }: { query?: string; sort?: string }): Promise<MarketReference[]> {
        const lowerQuery = query?.toLowerCase().trim() ?? "";
        const includeAllDexes = lowerQuery.length > 0;
        const universe = includeAllDexes ? await this.getAllMeta() : await this.getMeta();
        const listed = universe.filter((asset) => !asset.isDelisted);
        const filtered = lowerQuery
            ? listed.filter((asset) => asset.name.toLowerCase().includes(lowerQuery))
            : listed;
        const context = await this.loadDiscoveryContext(includeAllDexes);
        const sorted = filtered.map((asset, index) => ({ asset, index }));

        if (lowerQuery) {
            this.sortSearchEntries(sorted, lowerQuery, sort, context);
        } else {
            this.sortBrowseEntries(sorted, sort, context);
        }

        return sorted.map((entry) => this.toDiscoveryReference(context, entry.asset));
    }

    private async buildReferences(
        {
            query,
            sort,
            limit = 20,
            offset = 0,
        }: {
            query?: string;
            sort?: string;
            limit?: number;
            offset?: number;
        },
    ): Promise<MarketReference[]> {
        const isBrowse = !query || query.trim().length === 0;
        const normalizedSort = isBrowse ? (sort ?? "price") : sort;

        if (isBrowse) {
            const cacheKey = `browse-result:${normalizedSort}`;
            const fullResults = await this.cache.remember(cacheKey, {
                ttlMs: this.browseCacheTtlMs,
                load: () => this.listReferences({ sort: normalizedSort }),
            });
            return fullResults.slice(offset, offset + limit);
        }

        const results = await this.listReferences({ query, sort: normalizedSort });
        return results.slice(offset, offset + limit);
    }

    async search(query: string, options?: SearchOptions): Promise<MarketReference[]> {
        return this.buildReferences({
            query,
            sort: options?.sort,
            limit: options?.limit,
            offset: options?.offset,
        });
    }

    async browse(options?: BrowseOptions): Promise<MarketReference[]> {
        return this.buildReferences({
            sort: options?.sort,
            limit: options?.limit,
            offset: options?.offset,
        });
    }

    private async getPredictedFundings(): Promise<unknown[]> {
        return this.cache.remember("predictedFundings", {
            ttlMs: FUNDING_TTL_MS,
            load: async () => {
                const data = await postInfo<unknown>(this.apiUrl, {
                    type: "predictedFundings",
                }, this.requestTimeoutMs);

                if (!Array.isArray(data)) {
                    throw new MarketAdapterError("UPSTREAM_ERROR", "Invalid predictedFundings response from Hyperliquid");
                }

                return data;
            },
        });
    }

    private async getFundingRateFromAssetContext(reference: string, normalizedSymbol: string): Promise<FundingRate> {
        const ctxMap = normalizedSymbol.includes(":") ? await this.getAllAssetContexts() : await this.getAssetContexts();
        const ctx = ctxMap.get(normalizedSymbol);
        const rate = parseNumber(ctx?.funding);
        if (rate === null) {
            throw new MarketAdapterError("SYMBOL_NOT_FOUND", `No funding rate data for ${normalizedSymbol}`);
        }

        // Hyperliquid funding settles hourly. predictedFundings only covers the first
        // perp dex, so builder-deployed perps fall back to the current asset context.
        const nextFundingAt = getNextHourlyFundingAt();
        const preview = buildFundingPreview(rate, nextFundingAt);

        return {
            reference,
            ...preview,
        };
    }

    async getQuote(reference: string): Promise<Quote> {
        const normalizedSymbol = await this.normalizeReference(reference);
        const cacheKey = `quote:${normalizedSymbol}`;
        const cached = this.cache.get<Quote>(cacheKey);
        if (cached) return this.withRequestedReference(cached, reference);

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
            reference,
            price: Number(mid.toFixed(6)),
            bid: bestBid ?? undefined,
            ask: bestAsk ?? undefined,
            timestamp: new Date().toISOString(),
        };

        this.cache.set(cacheKey, quote, QUOTE_TTL_MS);
        return quote;
    }

    async getOrderbook(reference: string): Promise<Orderbook> {
        const normalizedSymbol = await this.normalizeReference(reference);
        const cacheKey = `ob:${normalizedSymbol}`;
        const cached = this.cache.get<Orderbook>(cacheKey);
        if (cached) return this.withRequestedReference(cached, reference);

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
            reference,
            bids,
            asks,
            timestamp: new Date().toISOString(),
        };

        this.cache.set(cacheKey, orderbook, ORDERBOOK_TTL_MS);
        return orderbook;
    }

    async getFundingRate(reference: string): Promise<FundingRate> {
        const normalizedSymbol = await this.normalizeReference(reference);
        const cacheKey = `funding:${normalizedSymbol}`;
        const cached = this.cache.get<FundingRate>(cacheKey);
        if (cached) return this.withRequestedReference(cached, reference);

        if (normalizedSymbol.includes(":")) {
            const fundingRate = await this.getFundingRateFromAssetContext(reference, normalizedSymbol);
            this.cache.set(cacheKey, fundingRate, FUNDING_TTL_MS);
            return fundingRate;
        }

        const data = await this.getPredictedFundings();

        const entry = parseFundingEntry(data, normalizedSymbol);

        if (!entry) {
            throw new MarketAdapterError("SYMBOL_NOT_FOUND", `Funding data not found for ${normalizedSymbol}`);
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
            reference,
            ...buildFundingPreview(rate, new Date(nextFundingTimeMs).toISOString()),
        };

        this.cache.set(cacheKey, fundingRate, FUNDING_TTL_MS);
        return fundingRate;
    }

    async getPriceHistory(reference: string, options?: PriceHistoryOptions): Promise<PriceHistoryResult> {
        const normalizedSymbol = await this.normalizeReference(reference);
        const { interval, range } = resolvePriceHistoryRange(this.priceHistory, options);
        const barMs = PRICE_HISTORY_INTERVAL_MS[interval];
        const endTime = Math.floor(Date.parse(range.endTime) / barMs) * barMs;
        const startTime = Math.floor(Date.parse(range.startTime) / barMs) * barMs;
        const effectiveRange = {
            ...range,
            asOf: new Date(endTime).toISOString(),
            startTime: new Date(startTime).toISOString(),
            endTime: new Date(endTime).toISOString(),
        };

        const cacheKey = `candle:${normalizedSymbol}:${interval}:${startTime}:${endTime}`;
        const ttl = CANDLE_TTL_MS[interval] ?? CANDLE_TTL_MS[this.priceHistory.defaultInterval];

        return this.cache.remember(cacheKey, {
            ttlMs: ttl,
            load: async () => {
                const data = await postInfo<unknown[]>(this.apiUrl, {
                    type: "candleSnapshot",
                    req: {
                        coin: normalizedSymbol,
                        interval,
                        startTime,
                        endTime,
                    },
                }, this.requestTimeoutMs);

                if (!Array.isArray(data)) {
                    throw new MarketAdapterError("UPSTREAM_ERROR", "Invalid candleSnapshot response from Hyperliquid");
                }

                const candles = data.map((candle) => {
                    const c = candle as Record<string, unknown>;
                    return {
                        timestamp: new Date(parseNumber(c.t) ?? 0).toISOString(),
                        open: parseNumber(c.o) ?? 0,
                        high: parseNumber(c.h) ?? 0,
                        low: parseNumber(c.l) ?? 0,
                        close: parseNumber(c.c) ?? 0,
                        volume: parseNumber(c.v) ?? 0,
                    };
                });

                return buildPriceHistoryResult({
                    reference,
                    interval,
                    range: effectiveRange,
                    candles,
                });
            },
        });
    }
}
