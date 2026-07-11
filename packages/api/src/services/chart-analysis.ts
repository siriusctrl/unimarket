import {
  DRAWING_CAPABILITIES,
  chartAnalysisDocumentSchema,
  computeIndicators,
  type ChartContext,
  type ChartAnalysisDocument,
  type IndicatorLayer,
  type StoredChartAnalysis,
} from "@unimarket/analysis";
import type { MarketRegistry, PriceHistoryInterval, PriceHistoryLookback } from "@unimarket/markets";
import { createHash } from "node:crypto";

import type { chartAnalyses } from "../db/schema.js";

type ChartAnalysisRow = typeof chartAnalyses.$inferSelect;

const countMissingIntervals = (timestamps: string[], expectedIntervalMs: number): number => {
  if (timestamps.length < 2 || expectedIntervalMs <= 0) return 0;
  let missing = 0;
  for (let index = 1; index < timestamps.length; index += 1) {
    const gap = Date.parse(timestamps[index]) - Date.parse(timestamps[index - 1]);
    if (gap > expectedIntervalMs * 1.5) missing += Math.max(0, Math.round(gap / expectedIntervalMs) - 1);
  }
  return missing;
};

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
  "1mo": 2_592_000_000,
};

export const defaultIndicatorLayers = (from: string, to: string): IndicatorLayer[] => [
  { id: "sma-20", type: "sma", period: 20, visible: true },
  { id: "ema-50", type: "ema", period: 50, visible: true },
  { id: "rsi-14", type: "rsi", period: 14, visible: true },
  {
    id: "volume-profile",
    type: "volumeProfile",
    from,
    to,
    bins: 48,
    valueAreaPercent: 70,
    method: "ohlcv-range-approximation",
    visible: true,
  },
];

export const buildChartContext = async ({
  registry,
  market,
  reference,
  interval,
  lookback,
  asOf,
  startTime,
  endTime,
  indicatorLayers,
}: {
  registry: MarketRegistry;
  market: string;
  reference: string;
  interval: PriceHistoryInterval;
  lookback: PriceHistoryLookback;
  asOf?: string;
  startTime?: string;
  endTime?: string;
  indicatorLayers?: IndicatorLayer[];
}): Promise<ChartContext> => {
  const adapter = registry.get(market);
  if (!adapter) throw new Error(`Market not found: ${market}`);
  if (!adapter.getPriceHistory) throw new Error(`Market does not support price history: ${market}`);

  const history = await adapter.getPriceHistory(reference, startTime && endTime
    ? { interval, startTime, endTime }
    : { interval, lookback, asOf });
  const candles = history.candles.map((candle) => ({ ...candle }));
  const snapshotHash = `sha256:${createHash("sha256").update(JSON.stringify(candles)).digest("hex")}`;
  const indicators = computeIndicators(
    candles,
    indicatorLayers ?? defaultIndicatorLayers(history.range.startTime, history.range.endTime),
    history.interval,
  );

  return {
    schema: "unimarket.chart-context/v1",
    instrument: { market, reference: history.reference, displayName: null },
    data: {
      interval: history.interval,
      range: history.range,
      snapshotHash,
      candles,
      summary: history.summary,
    },
    indicators,
    dataQuality: {
      candleCount: candles.length,
      missingIntervals: countMissingIntervals(candles.map((candle) => candle.timestamp), INTERVAL_MS[history.interval]),
      volumeAvailable: candles.some((candle) => candle.volume > 0),
      source: "market-adapter",
    },
    drawingCapabilities: DRAWING_CAPABILITIES,
  };
};

export const validateChartAnalysisSnapshot = async (
  registry: MarketRegistry,
  document: ChartAnalysisDocument,
): Promise<{ valid: boolean; expectedHash: string; candleCount: number }> => {
  const adapter = registry.get(document.instrument.market);
  if (!adapter) throw new Error(`Market not found: ${document.instrument.market}`);
  if (!adapter.getPriceHistory) throw new Error(`Market does not support price history: ${document.instrument.market}`);
  const history = await adapter.getPriceHistory(document.instrument.reference, {
    interval: document.data.interval,
    startTime: document.data.from,
    endTime: document.data.to,
  });
  const expectedHash = `sha256:${createHash("sha256").update(JSON.stringify(history.candles)).digest("hex")}`;
  return { valid: expectedHash === document.data.snapshotHash, expectedHash, candleCount: history.candles.length };
};

export const parseStoredChartAnalysis = (row: ChartAnalysisRow): StoredChartAnalysis => {
  if (row.status !== "draft" && row.status !== "published") {
    throw new Error(`Invalid chart analysis status: ${row.status}`);
  }

  return {
    id: row.id,
    supersedesId: row.supersedesId,
    version: row.version,
    status: row.status,
    document: chartAnalysisDocumentSchema.parse(JSON.parse(row.document)),
    createdBy: row.createdBy,
    reasoning: row.reasoning,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
  };
};
