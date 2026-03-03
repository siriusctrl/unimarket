import { TtlCache } from "./cache.js";
import {
  MarketAdapterError,
  type Asset,
  type MarketAdapter,
  type Orderbook,
  type OrderbookLevel,
  type Quote,
  type Resolution,
} from "./types.js";

type UnknownObject = Record<string, unknown>;

const QUOTE_TTL_MS = 10_000;
const ORDERBOOK_TTL_MS = 10_000;
const SEARCH_TTL_MS = 300_000;
const RESOLVE_TTL_MS = 60_000;

const DEFAULT_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const DEFAULT_CLOB_BASE_URL = "https://clob.polymarket.com";

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

  async search(query: string): Promise<Asset[]> {
    const cacheKey = `search:${query.toLowerCase()}`;
    const cached = this.cache.get<Asset[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const url = new URL("/markets", this.gammaBaseUrl);
    url.searchParams.set("search", query);
    url.searchParams.set("limit", "20");
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
        const symbol =
          typeof market.conditionId === "string"
            ? market.conditionId
            : typeof market.slug === "string"
              ? market.slug
              : null;

        const name =
          typeof market.question === "string"
            ? market.question
            : typeof market.title === "string"
              ? market.title
              : null;

        if (!symbol || !name) {
          continue;
        }

        results.push({
          symbol,
          name,
          price: parseNumber(market.lastTradePrice) ?? parseNumber(market.outcomePrice) ?? undefined,
          volume: parseNumber(market.volume24hr) ?? parseNumber(market.volume) ?? undefined,
        });
      }
    }

    this.cache.set(cacheKey, results, SEARCH_TTL_MS);
    return results;
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

    const url = new URL("/book", this.clobBaseUrl);
    url.searchParams.set("token_id", symbol);

    const raw = await fetchJson<unknown>(url.toString());
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

    const url = new URL("/markets", this.gammaBaseUrl);
    url.searchParams.set("conditionId", symbol);
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
}
