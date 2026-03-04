import { TtlCache } from "./cache.js";
import {
  MarketAdapterError,
  type Asset,
  type MarketAdapter,
  type Orderbook,
  type OrderbookLevel,
  type Quote,
  type Resolution,
  type SearchOptions,
  type SymbolResolution,
} from "./types.js";

type UnknownObject = Record<string, unknown>;

const BATCH_SIZE = 50;
const QUOTE_TTL_MS = 10_000;
const ORDERBOOK_TTL_MS = 10_000;
const SEARCH_TTL_MS = 300_000;
const RESOLVE_TTL_MS = 60_000;

const DEFAULT_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const DEFAULT_CLOB_BASE_URL = "https://clob.polymarket.com";
const CONDITION_ID_PATTERN = /^0x[a-fA-F0-9]{64}$/;

const parseNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
};

const parseStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }

  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0)
        : [];
    } catch {
      return [];
    }
  }

  return [];
};

const parseNumberArray = (value: unknown): number[] => {
  return parseStringArray(value)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item));
};

const parseOrderbookSide = (value: unknown): OrderbookLevel[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const levels: OrderbookLevel[] = [];
  for (const row of value) {
    if (Array.isArray(row) && row.length >= 2) {
      const tuplePrice = parseNumber(row[0]);
      const tupleSize = parseNumber(row[1]);
      if (tuplePrice !== null && tupleSize !== null) {
        levels.push({ price: tuplePrice, size: tupleSize });
        continue;
      }
    }

    if (typeof row !== "object" || row === null) {
      continue;
    }

    const level = row as UnknownObject;
    const price = parseNumber(level.price);
    const size = parseNumber(level.size);
    if (price === null || size === null) {
      continue;
    }

    levels.push({ price, size });
  }

  return levels;
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new MarketAdapterError("UPSTREAM_ERROR", `Upstream request failed (${response.status}): ${url}`);
  }

  return (await response.json()) as T;
};

export type PolymarketAdapterOptions = {
  gammaBaseUrl?: string;
  clobBaseUrl?: string;
};

export class PolymarketAdapter implements MarketAdapter {
  readonly marketId = "polymarket";
  readonly displayName = "Polymarket";
  readonly description = "Prediction markets - contracts typically settle to 0 or 1";
  readonly symbolFormat = "Condition ID or token ID";
  readonly priceRange: [number, number] = [0.01, 0.99];
  readonly capabilities = ["search", "quote", "orderbook", "resolve"] as const;

  private readonly cache = new TtlCache();
  private readonly gammaBaseUrl: string;
  private readonly clobBaseUrl: string;

  constructor(options: PolymarketAdapterOptions = {}) {
    this.gammaBaseUrl = options.gammaBaseUrl ?? DEFAULT_GAMMA_BASE_URL;
    this.clobBaseUrl = options.clobBaseUrl ?? DEFAULT_CLOB_BASE_URL;
  }

  private async resolveTokenId(symbol: string): Promise<string> {
    if (!CONDITION_ID_PATTERN.test(symbol)) {
      return symbol;
    }

    const cacheKey = `condition-token:${symbol}`;
    const cached = this.cache.get<string>(cacheKey);
    if (cached) {
      return cached;
    }

    const url = new URL("/markets", this.gammaBaseUrl);
    url.searchParams.set("conditionId", symbol);
    url.searchParams.set("limit", "1");

    const raw = await fetchJson<unknown>(url.toString());
    if (!Array.isArray(raw) || raw.length === 0 || typeof raw[0] !== "object" || raw[0] === null) {
      throw new MarketAdapterError("SYMBOL_NOT_FOUND", `No token available for symbol: ${symbol}`);
    }

    const tokenIds = parseStringArray((raw[0] as UnknownObject).clobTokenIds);
    const tokenId = tokenIds[0];
    if (!tokenId) {
      throw new MarketAdapterError("SYMBOL_NOT_FOUND", `No token available for symbol: ${symbol}`);
    }

    for (const candidate of tokenIds) {
      this.cache.set(`token-condition:${candidate}`, symbol, SEARCH_TTL_MS);
    }
    this.cache.set(cacheKey, tokenId, SEARCH_TTL_MS);
    return tokenId;
  }

  private async resolveConditionId(symbol: string): Promise<string> {
    if (CONDITION_ID_PATTERN.test(symbol)) {
      return symbol;
    }

    const cacheKey = `token-condition:${symbol}`;
    const cached = this.cache.get<string>(cacheKey);
    if (cached) {
      return cached;
    }

    const url = new URL("/markets", this.gammaBaseUrl);
    url.searchParams.set("clob_token_ids", symbol);
    url.searchParams.set("limit", "1");

    const raw = await fetchJson<unknown>(url.toString());
    if (!Array.isArray(raw) || raw.length === 0 || typeof raw[0] !== "object" || raw[0] === null) {
      throw new MarketAdapterError("SYMBOL_NOT_FOUND", `No market available for symbol: ${symbol}`);
    }

    const market = raw[0] as UnknownObject;
    const conditionId = typeof market.conditionId === "string" ? market.conditionId : null;
    if (!conditionId) {
      throw new MarketAdapterError("SYMBOL_NOT_FOUND", `No market available for symbol: ${symbol}`);
    }

    this.cache.set(cacheKey, conditionId, SEARCH_TTL_MS);

    const tokenIds = parseStringArray(market.clobTokenIds);
    const tokenId = tokenIds[0];
    if (tokenId) {
      this.cache.set(`condition-token:${conditionId}`, tokenId, SEARCH_TTL_MS);
    }
    for (const token of tokenIds) {
      this.cache.set(`token-condition:${token}`, conditionId, SEARCH_TTL_MS);
    }

    return conditionId;
  }

  async search(query: string, options?: SearchOptions): Promise<Asset[]> {
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const cacheKey = `search:${query.toLowerCase()}:${limit}:${offset}`;
    const cached = this.cache.get<Asset[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const url = new URL("/markets", this.gammaBaseUrl);
    if (query.length > 0) {
      url.searchParams.set("search", query);
    }
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");

    const raw = await fetchJson<unknown>(url.toString());
    const results: Asset[] = [];

    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item !== "object" || item === null) {
          continue;
        }

        const market = item as UnknownObject;
        const conditionId = typeof market.conditionId === "string" ? market.conditionId : null;
        const tokenIds = parseStringArray(market.clobTokenIds);
        const outcomes = parseStringArray(market.outcomes);
        const outcomePrices = parseNumberArray(market.outcomePrices);

        if (conditionId) {
          const tokenId = tokenIds[0];
          if (tokenId) {
            this.cache.set(`condition-token:${conditionId}`, tokenId, SEARCH_TTL_MS);
          }
          for (const token of tokenIds) {
            this.cache.set(`token-condition:${token}`, conditionId, SEARCH_TTL_MS);
          }
        }

        const symbol = conditionId ?? (typeof market.slug === "string" ? market.slug : null);

        const name =
          typeof market.question === "string"
            ? market.question
            : typeof market.title === "string"
              ? market.title
              : null;

        if (!symbol || !name) {
          continue;
        }

        const metadata =
          tokenIds.length > 0 || outcomes.length > 0 || outcomePrices.length > 0
            ? {
              conditionId,
              tokenIds,
              outcomes,
              outcomePrices,
              defaultTokenId: tokenIds[0] ?? null,
            }
            : null;

        results.push({
          symbol,
          name,
          price: parseNumber(market.lastTradePrice) ?? parseNumber(market.outcomePrice) ?? undefined,
          volume: parseNumber(market.volume24hr) ?? parseNumber(market.volume) ?? undefined,
          ...(metadata ? { metadata } : {}),
        });
      }
    }

    this.cache.set(cacheKey, results, SEARCH_TTL_MS);
    return results;
  }

  async normalizeSymbol(symbol: string): Promise<string> {
    return this.resolveTokenId(symbol);
  }

  async getQuote(symbol: string): Promise<Quote> {
    const cacheKey = `quote:${symbol}`;
    const cached = this.cache.get<Quote>(cacheKey);
    if (cached) {
      return cached;
    }

    const orderbook = await this.getOrderbook(symbol);
    const bestBid = orderbook.bids[0]?.price;
    const bestAsk = orderbook.asks[0]?.price;

    if (typeof bestBid !== "number" && typeof bestAsk !== "number") {
      throw new MarketAdapterError("SYMBOL_NOT_FOUND", `No quote available for symbol: ${symbol}`);
    }

    const price =
      typeof bestBid === "number" && typeof bestAsk === "number"
        ? (bestBid + bestAsk) / 2
        : (bestBid ?? bestAsk) as number;

    const quote: Quote = {
      symbol,
      price: Number(price.toFixed(6)),
      bid: bestBid,
      ask: bestAsk,
      timestamp: orderbook.timestamp,
    };

    this.cache.set(cacheKey, quote, QUOTE_TTL_MS);
    return quote;
  }

  async getOrderbook(symbol: string): Promise<Orderbook> {
    const cacheKey = `book:${symbol}`;
    const cached = this.cache.get<Orderbook>(cacheKey);
    if (cached) {
      return cached;
    }

    const tokenId = await this.resolveTokenId(symbol);
    const url = new URL("/book", this.clobBaseUrl);
    url.searchParams.set("token_id", tokenId);

    let raw: unknown;
    try {
      raw = await fetchJson<unknown>(url.toString());
    } catch (error) {
      if (error instanceof MarketAdapterError && error.code === "UPSTREAM_ERROR" && error.message.includes("(404)")) {
        throw new MarketAdapterError("SYMBOL_NOT_FOUND", `No orderbook available for symbol: ${symbol}`);
      }
      throw error;
    }
    if (typeof raw !== "object" || raw === null) {
      throw new MarketAdapterError("UPSTREAM_ERROR", "Invalid orderbook response from Polymarket CLOB API");
    }

    const book = raw as UnknownObject;
    const orderbook: Orderbook = {
      symbol,
      bids: parseOrderbookSide(book.bids).sort((a, b) => b.price - a.price),
      asks: parseOrderbookSide(book.asks).sort((a, b) => a.price - b.price),
      timestamp: new Date().toISOString(),
    };

    this.cache.set(cacheKey, orderbook, ORDERBOOK_TTL_MS);
    return orderbook;
  }

  async resolve(symbol: string): Promise<Resolution | null> {
    const cacheKey = `resolve:${symbol}`;
    const cached = this.cache.get<Resolution | null>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    let conditionId: string;
    try {
      conditionId = await this.resolveConditionId(symbol);
    } catch (error) {
      if (error instanceof MarketAdapterError && error.code === "SYMBOL_NOT_FOUND") {
        this.cache.set(cacheKey, null, RESOLVE_TTL_MS);
        return null;
      }
      throw error;
    }

    const url = new URL("/markets", this.gammaBaseUrl);
    url.searchParams.set("conditionId", conditionId);
    url.searchParams.set("limit", "1");

    const raw = await fetchJson<unknown>(url.toString());
    if (!Array.isArray(raw) || raw.length === 0 || typeof raw[0] !== "object" || raw[0] === null) {
      this.cache.set(cacheKey, null, RESOLVE_TTL_MS);
      return null;
    }

    const market = raw[0] as UnknownObject;
    const resolvedFlag = Boolean(market.resolved);
    if (!resolvedFlag) {
      const unresolved: Resolution = {
        symbol,
        resolved: false,
        outcome: null,
        settlementPrice: null,
        timestamp: new Date().toISOString(),
      };
      this.cache.set(cacheKey, unresolved, RESOLVE_TTL_MS);
      return unresolved;
    }

    const outcome = typeof market.outcome === "string" ? market.outcome : null;
    const settlementPrice = parseNumber(market.settlementPrice);

    const resolved: Resolution = {
      symbol,
      resolved: true,
      outcome,
      settlementPrice,
      timestamp: new Date().toISOString(),
    };
    this.cache.set(cacheKey, resolved, RESOLVE_TTL_MS);
    return resolved;
  }

  async resolveSymbolNames(symbols: Iterable<string>): Promise<SymbolResolution> {
    const names = new Map<string, string>();
    const outcomes = new Map<string, string>();
    const conditionIds: string[] = [];
    const tokenIds: string[] = [];

    for (const symbol of symbols) {
      if (CONDITION_ID_PATTERN.test(symbol)) {
        conditionIds.push(symbol);
      } else {
        tokenIds.push(symbol);
      }
    }

    if (conditionIds.length === 0 && tokenIds.length === 0) return { names, outcomes };

    const processMarket = (market: UnknownObject) => {
      const question = typeof market.question === "string" ? market.question : null;
      const condId = typeof market.conditionId === "string" ? market.conditionId : null;

      if (condId && question) names.set(condId, question);

      const tokens = Array.isArray(market.tokens) ? market.tokens : [];
      for (const token of tokens) {
        if (typeof token !== "object" || token === null || !question) continue;
        const rec = token as UnknownObject;
        const tid = typeof rec.token_id === "string" ? rec.token_id : null;
        const out = typeof rec.outcome === "string" ? rec.outcome : null;
        if (!tid) continue;
        names.set(tid, question);
        if (out) outcomes.set(tid, out);
      }

      // Fallback: match clobTokenIds ↔ outcomes by index
      if (question) {
        const tids = parseStringArray(market.clobTokenIds);
        const outs = parseStringArray(market.outcomes);
        for (let i = 0; i < tids.length; i++) {
          if (!names.has(tids[i]!)) names.set(tids[i]!, question);
          if (!outcomes.has(tids[i]!) && outs[i]) outcomes.set(tids[i]!, outs[i]!);
        }
      }
    };

    const fetchBatch = async (queryKey: string, batch: string[]) => {
      for (let i = 0; i < batch.length; i += BATCH_SIZE) {
        const chunk = batch.slice(i, i + BATCH_SIZE);
        const url = new URL("/markets", this.gammaBaseUrl);
        url.searchParams.set(queryKey, chunk.join(","));
        url.searchParams.set("limit", String(Math.max(BATCH_SIZE, chunk.length)));

        let raw: unknown;
        try {
          raw = await fetchJson<unknown>(url.toString());
        } catch {
          continue;
        }
        if (!Array.isArray(raw)) continue;
        for (const m of raw) {
          if (typeof m === "object" && m !== null) processMarket(m as UnknownObject);
        }
      }
    };

    try {
      if (conditionIds.length > 0) await fetchBatch("conditionId", conditionIds);
      if (tokenIds.length > 0) await fetchBatch("clob_token_ids", tokenIds);
    } catch {
      // Non-critical
    }

    return { names, outcomes };
  }
}
