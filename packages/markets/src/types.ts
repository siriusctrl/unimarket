export type MarketCapability = "search" | "quote" | "orderbook" | "resolve";

export type Asset = {
  symbol: string;
  name: string;
  price?: number;
  volume?: number;
  metadata?: Record<string, unknown>;
};

export type Quote = {
  symbol: string;
  price: number;
  bid?: number;
  ask?: number;
  volume?: number;
  timestamp: string;
};

export type OrderbookLevel = {
  price: number;
  size: number;
};

export type Orderbook = {
  symbol: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp: string;
};

export type Resolution = {
  symbol: string;
  resolved: boolean;
  outcome: string | null;
  settlementPrice: number | null;
  timestamp: string;
};

export type MarketDescriptor = {
  id: string;
  name: string;
  description: string;
  symbolFormat: string;
  priceRange: [number, number] | null;
  capabilities: readonly MarketCapability[];
};

export type SearchOptions = {
  limit?: number;
  offset?: number;
};

export type SymbolResolution = {
  names: Map<string, string>;
  outcomes: Map<string, string>;
};

export interface MarketAdapter {
  readonly marketId: string;
  readonly displayName: string;
  readonly description: string;
  readonly symbolFormat: string;
  readonly priceRange: [number, number] | null;
  readonly capabilities: readonly MarketCapability[];

  search(query: string, options?: SearchOptions): Promise<Asset[]>;
  normalizeSymbol?(symbol: string): Promise<string>;
  getQuote(symbol: string): Promise<Quote>;
  getOrderbook?(symbol: string): Promise<Orderbook>;
  resolve?(symbol: string): Promise<Resolution | null>;
  resolveSymbolNames?(symbols: Iterable<string>): Promise<SymbolResolution>;
}

export class MarketAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
