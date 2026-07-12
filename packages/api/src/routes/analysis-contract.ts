import {
  CHART_ANALYSIS_SCHEMA,
  DRAWING_CAPABILITIES,
  chartAnalysisDocumentSchema,
} from "@unimarket/analysis";
import { priceHistoryIntervalSchema, priceHistoryLookbackSchema } from "@unimarket/core";
import { z } from "zod";

export const contextQuerySchema = z.object({
  market: z.string().trim().min(1),
  reference: z.string().trim().min(1),
  interval: priceHistoryIntervalSchema.default("1d"),
  lookback: priceHistoryLookbackSchema.default("1y"),
  asOf: z.string().datetime({ offset: true }).optional(),
  documentId: z.string().trim().min(1).optional(),
});

export const analysisListQuerySchema = z.object({
  market: z.string().trim().min(1).optional(),
  reference: z.string().trim().min(1).optional(),
  interval: priceHistoryIntervalSchema.optional(),
  status: z.enum(["draft", "published"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const analysisValidationSchema = z.object({ document: chartAnalysisDocumentSchema });

export const analysisSchemaResponse = {
  schema: CHART_ANALYSIS_SCHEMA,
  documentFormat: "versioned JSON",
  drawingCapabilities: DRAWING_CAPABILITIES,
  indicatorCapabilities: ["sma", "ema", "rsi", "atr", "macd", "bollingerBands", "volumeProfile"],
  documentFields: {
    required: ["schema", "title", "instrument", "data", "thesis", "invalidation", "layers", "metadata"],
    instrument: ["market", "reference", "displayName?"],
    data: ["interval", "from", "to", "asOf", "snapshotHash"],
    viewport: ["from?", "to?", "priceScale=auto|logarithmic"],
    metadata: ["createdBy.kind", "createdBy.actorId", "runId?", "createdAt"],
    drawingCommon: ["id", "type", "rationale", "label?", "labelPlacement?", "confidence?", "visible?", "style?"],
    indicatorCommon: ["id", "type", "visible?"],
  },
  drawingContracts: {
    horizontalLine: { coordinates: ["price"] },
    verticalLine: { coordinates: ["time"] },
    trendLine: { coordinates: ["anchors[2]", "extend.left", "extend.right"] },
    ray: { coordinates: ["anchors[2]"] },
    channel: { coordinates: ["base[2]", "parallelAnchor"] },
    rectangle: { coordinates: ["anchors[2]"] },
    marker: { coordinates: ["point", "shape"] },
    text: { coordinates: ["point", "text"] },
  },
  indicatorContracts: {
    sma: { parameters: ["period"] },
    ema: { parameters: ["period"] },
    rsi: { parameters: ["period"] },
    atr: { parameters: ["period"] },
    macd: { parameters: ["fastPeriod", "slowPeriod", "signalPeriod"] },
    bollingerBands: { parameters: ["period", "standardDeviations"] },
    volumeProfile: { parameters: ["from", "to", "bins", "valueAreaPercent", "method=ohlcv-range-approximation"] },
  },
  coordinateSystem: "time-price",
  arbitraryCodeAllowed: false,
} as const;
