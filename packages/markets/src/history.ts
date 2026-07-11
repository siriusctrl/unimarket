import {
  MarketAdapterError,
  type CandleData,
  type PriceHistoryInterval,
  type PriceHistoryLookback,
  type PriceHistoryOptions,
  type PriceHistoryRange,
  type PriceHistoryResult,
  type PriceHistorySummary,
  type PriceHistorySupport,
} from "./types.js";

export const PRICE_HISTORY_INTERVAL_MS: Record<PriceHistoryInterval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
  "1mo": 30 * 24 * 60 * 60_000,
};

export const DEFAULT_PRICE_HISTORY_SUPPORTED_LOOKBACKS: readonly PriceHistoryLookback[] = [
  "1h", "4h", "1d", "7d", "30d", "90d", "1y", "5y",
];
export const DEFAULT_PRICE_HISTORY_LOOKBACKS_BY_INTERVAL: Readonly<Partial<Record<PriceHistoryInterval, PriceHistoryLookback>>> = {
  "1m": "4h",
  "5m": "1d",
  "15m": "1d",
  "1h": "7d",
  "4h": "30d",
  "1d": "1y",
  "1w": "5y",
  "1mo": "5y",
};
export const DEFAULT_PRICE_HISTORY_MAX_CANDLES = 2_000;

export const PRICE_HISTORY_LOOKBACK_MS: Record<PriceHistoryLookback, number> = {
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
  "90d": 90 * 24 * 60 * 60_000,
  "1y": 365 * 24 * 60 * 60_000,
  "5y": 5 * 365 * 24 * 60 * 60_000,
};

export const floorTimestampToInterval = (timestampMs: number, interval: PriceHistoryInterval): number => {
  const date = new Date(timestampMs);
  if (interval === "1mo") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  if (interval === "1w") {
    const dayOffset = (date.getUTCDay() + 6) % 7;
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - dayOffset);
  }
  return Math.floor(timestampMs / PRICE_HISTORY_INTERVAL_MS[interval]) * PRICE_HISTORY_INTERVAL_MS[interval];
};

const parseDateTime = (value: string, field: "asOf" | "startTime" | "endTime"): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new MarketAdapterError("INVALID_INPUT", `${field} must be a valid datetime`);
  }
  return parsed;
};

const assertSupportedInterval = (config: PriceHistorySupport, interval: PriceHistoryInterval): void => {
  if (config.supportedIntervals.includes(interval)) {
    return;
  }

  throw new MarketAdapterError("INVALID_INPUT", `Unsupported interval: ${interval}`);
};

const assertSupportedLookback = (config: PriceHistorySupport, lookback: PriceHistoryLookback): void => {
  if (config.supportedLookbacks.includes(lookback)) {
    return;
  }

  throw new MarketAdapterError("INVALID_INPUT", `Unsupported lookback: ${lookback}`);
};

const assertMaxCandles = (config: PriceHistorySupport, interval: PriceHistoryInterval, startMs: number, endMs: number): void => {
  const intervalMs = PRICE_HISTORY_INTERVAL_MS[interval];
  const candleEstimate = Math.ceil((endMs - startMs) / intervalMs);

  if (candleEstimate > config.maxCandles) {
    throw new MarketAdapterError(
      "INVALID_INPUT",
      `Requested range exceeds max ${config.maxCandles} candles for interval ${interval}`,
    );
  }
};

export const resolvePriceHistoryRange = (
  config: PriceHistorySupport,
  options?: PriceHistoryOptions,
): { interval: PriceHistoryInterval; range: PriceHistoryRange } => {
  const interval = options?.interval ?? config.defaultInterval;
  assertSupportedInterval(config, interval);

  const usesCustomRange = options?.startTime !== undefined || options?.endTime !== undefined;
  if (usesCustomRange) {
    if (!config.supportsCustomRange) {
      throw new MarketAdapterError("INVALID_INPUT", "Custom startTime/endTime ranges are not supported");
    }
    if (!options?.startTime || !options?.endTime) {
      throw new MarketAdapterError("INVALID_INPUT", "startTime and endTime must be provided together");
    }

    const startMs = parseDateTime(options.startTime, "startTime");
    const endMs = parseDateTime(options.endTime, "endTime");
    if (endMs <= startMs) {
      throw new MarketAdapterError("INVALID_INPUT", "endTime must be greater than startTime");
    }

    assertMaxCandles(config, interval, startMs, endMs);
    return {
      interval,
      range: {
        mode: "custom",
        lookback: null,
        asOf: new Date(endMs).toISOString(),
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
      },
    };
  }

  const lookback = options?.lookback ?? config.defaultLookbacks[interval] ?? config.defaultLookbacks[config.defaultInterval];
  if (!lookback) {
    throw new MarketAdapterError("INVALID_INPUT", `No default lookback configured for interval ${interval}`);
  }

  assertSupportedLookback(config, lookback);
  const asOfMs = options?.asOf ? parseDateTime(options.asOf, "asOf") : Date.now();
  const startMs = asOfMs - PRICE_HISTORY_LOOKBACK_MS[lookback];

  assertMaxCandles(config, interval, startMs, asOfMs);
  return {
    interval,
    range: {
      mode: "lookback",
      lookback,
      asOf: new Date(asOfMs).toISOString(),
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(asOfMs).toISOString(),
    },
  };
};

export const resampleCandles = (candles: CandleData[], interval: PriceHistoryInterval): CandleData[] => {
  if (candles.length <= 1) {
    return candles;
  }

  const buckets = new Map<number, CandleData>();
  const sorted = [...candles].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));

  for (const candle of sorted) {
    const timestampMs = Date.parse(candle.timestamp);
    if (!Number.isFinite(timestampMs)) {
      continue;
    }

    const bucketStart = floorTimestampToInterval(timestampMs, interval);
    const current = buckets.get(bucketStart);
    if (!current) {
      buckets.set(bucketStart, { ...candle, timestamp: new Date(bucketStart).toISOString() });
      continue;
    }

    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
  }

  return Array.from(buckets.entries())
    .sort(([left], [right]) => left - right)
    .map(([, candle]) => candle);
};

export const summarizeCandles = (candles: CandleData[]): PriceHistorySummary => {
  if (candles.length === 0) {
    return {
      open: null,
      close: null,
      change: null,
      changePct: null,
      high: null,
      low: null,
      volume: null,
      candleCount: 0,
    };
  }

  const first = candles[0];
  const last = candles[candles.length - 1];
  const high = candles.reduce((max, candle) => Math.max(max, candle.high), first.high);
  const low = candles.reduce((min, candle) => Math.min(min, candle.low), first.low);
  const volume = candles.reduce((sum, candle) => sum + candle.volume, 0);
  const change = last.close - first.open;

  return {
    open: first.open,
    close: last.close,
    change,
    changePct: first.open === 0 ? null : (change / first.open) * 100,
    high,
    low,
    volume,
    candleCount: candles.length,
  };
};

export const buildPriceHistoryResult = (input: {
  reference: string;
  interval: PriceHistoryInterval;
  range: PriceHistoryRange;
  candles: CandleData[];
  resampledFrom?: PriceHistoryInterval | null;
}): PriceHistoryResult => {
  return {
    reference: input.reference,
    interval: input.interval,
    resampledFrom: input.resampledFrom ?? null,
    range: input.range,
    candles: input.candles,
    summary: summarizeCandles(input.candles),
  };
};
