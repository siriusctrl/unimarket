export type MarketCapability = "search" | "browse" | "quote" | "orderbook" | "resolve" | "funding" | "priceHistory";

export type CandleData = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type PriceHistoryInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

export type PriceHistoryLookback = "1h" | "4h" | "1d" | "7d" | "30d";

export type PriceHistorySupport = {
  nativeIntervals: readonly PriceHistoryInterval[];
  supportedIntervals: readonly PriceHistoryInterval[];
  defaultInterval: PriceHistoryInterval;
  supportedLookbacks: readonly PriceHistoryLookback[];
  defaultLookbacks: Readonly<Partial<Record<PriceHistoryInterval, PriceHistoryLookback>>>;
  maxCandles: number;
  supportsCustomRange: boolean;
  supportsResampling: boolean;
};

export type PriceHistoryOptions = {
  interval?: PriceHistoryInterval;
  lookback?: PriceHistoryLookback;
  asOf?: string;
  startTime?: string;
  endTime?: string;
};

export type PriceHistoryRange = {
  mode: "lookback" | "custom";
  lookback: PriceHistoryLookback | null;
  asOf: string;
  startTime: string;
  endTime: string;
};

export type PriceHistorySummary = {
  open: number | null;
  close: number | null;
  change: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  candleCount: number;
};

export type PriceHistoryResult = {
  reference: string;
  interval: PriceHistoryInterval;
  resampledFrom: PriceHistoryInterval | null;
  range: PriceHistoryRange;
  candles: CandleData[];
  summary: PriceHistorySummary;
};

export type MarketReference = {
  reference: string;
  name: string;
  price?: number;
  volume?: number;
  openInterest?: number;
  liquidity?: number;
  endDate?: string | null;
  fundingPreview?: FundingPreview;
  metadata?: Record<string, unknown>;
};

export type FundingDirection = "long_pays_short" | "short_pays_long" | "neutral";

export type FundingPreview = {
  rate: number;
  nextFundingAt: string;
  timestamp: string;
  direction: FundingDirection;
  intervalHours?: number;
  annualizedRate?: number;
};

export type Quote = {
  reference: string;
  price: number;
  bid?: number;
  ask?: number;
  volume?: number;
  timestamp: string;
  fundingPreview?: FundingPreview;
};

export type OrderbookLevel = {
  price: number;
  size: number;
};

export type Orderbook = {
  reference: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp: string;
};

export type Resolution = {
  reference: string;
  resolved: boolean;
  outcome: string | null;
  settlementPrice: number | null;
  timestamp: string;
};

export type FundingRate = {
  reference: string;
  rate: number;
  nextFundingAt: string;
  timestamp: string;
  direction: FundingDirection;
  intervalHours?: number;
  annualizedRate?: number;
};

export type MarketDescriptor = {
  id: string;
  name: string;
  description: string;
  referenceFormat: string;
  priceRange: [number, number] | null;
  capabilities: readonly MarketCapability[];
  browseOptions: readonly BrowseOption[];
  searchSortOptions: readonly BrowseOption[];
  priceHistory: PriceHistorySupport | null;
};

export type SearchOptions = {
  limit?: number;
  offset?: number;
  sort?: string;
};

export type BrowseOption = {
  value: string;
  label: string;
};

export type BrowseOptions = {
  limit?: number;
  offset?: number;
  sort?: string;
};

export type TradingConstraints = {
  minQuantity: number;
  quantityStep: number;
  supportsFractional: boolean;
  maxLeverage: number | null;
};

export type SymbolResolution = {
  names: Map<string, string>;
  outcomes: Map<string, string>;
};

export interface MarketAdapter {
  readonly marketId: string;
  readonly displayName: string;
  readonly description: string;
  readonly referenceFormat: string;
  readonly priceRange: [number, number] | null;
  readonly browseOptions?: readonly BrowseOption[];
  readonly searchSortOptions?: readonly BrowseOption[];
  readonly priceHistory?: PriceHistorySupport | null;

  search(query: string, options?: SearchOptions): Promise<MarketReference[]>;
  browse?(options?: BrowseOptions): Promise<MarketReference[]>;
  normalizeReference(reference: string): Promise<string>;
  getQuote(reference: string): Promise<Quote>;
  getOrderbook?(reference: string): Promise<Orderbook>;
  resolve?(reference: string): Promise<Resolution | null>;
  resolveSymbolNames?(symbols: Iterable<string>): Promise<SymbolResolution>;
  getFundingRate?(reference: string): Promise<FundingRate>;
  getTradingConstraints(reference: string): Promise<TradingConstraints>;
  getPriceHistory?(reference: string, options?: PriceHistoryOptions): Promise<PriceHistoryResult>;
}

export const getMarketCapabilities = (adapter: MarketAdapter): MarketCapability[] => {
  const capabilities: MarketCapability[] = ["search", "quote"];
  if (adapter.browse) capabilities.push("browse");
  if (adapter.getOrderbook) capabilities.push("orderbook");
  if (adapter.resolve) capabilities.push("resolve");
  if (adapter.getFundingRate) capabilities.push("funding");
  if (adapter.getPriceHistory) capabilities.push("priceHistory");
  return capabilities;
};

export class MarketAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const fundingDirectionFromRate = (rate: number): FundingDirection => {
  if (rate > 0) return "long_pays_short";
  if (rate < 0) return "short_pays_long";
  return "neutral";
};

export const annualizeFundingRate = (rate: number, intervalHours: number): number | null => {
  if (!Number.isFinite(rate) || !Number.isFinite(intervalHours) || intervalHours <= 0) {
    return null;
  }

  const periodsPerYear = (24 / intervalHours) * 365;
  return Number((rate * periodsPerYear).toFixed(6));
};
