import type { AnalysisCandle, ChartAnalysisDocument, DrawingLayer } from "./schema.js";
import type { ComputedIndicator } from "./indicators.js";

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

export const DRAWING_CAPABILITIES: readonly DrawingLayer["type"][] = [
  "horizontalLine",
  "verticalLine",
  "trendLine",
  "ray",
  "channel",
  "rectangle",
  "marker",
  "text",
];

export type ChartContext = {
  schema: "unimarket.chart-context/v1";
  instrument: {
    market: string;
    reference: string;
    displayName: string | null;
  };
  data: {
    interval: string;
    range: {
      mode: "lookback" | "custom";
      lookback: string | null;
      asOf: string;
      startTime: string;
      endTime: string;
    };
    snapshotHash: string;
    candles: AnalysisCandle[];
    summary: PriceHistorySummary;
  };
  indicators: ComputedIndicator[];
  dataQuality: {
    candleCount: number;
    missingIntervals: number;
    volumeAvailable: boolean;
    source: "market-adapter";
  };
  drawingCapabilities: readonly DrawingLayer["type"][];
};

export type StoredChartAnalysis = {
  id: string;
  supersedesId: string | null;
  version: number;
  status: "draft" | "published";
  document: ChartAnalysisDocument;
  createdBy: string;
  reasoning: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};
