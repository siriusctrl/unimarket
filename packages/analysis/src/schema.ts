import { z } from "zod";

export const CHART_ANALYSIS_SCHEMA = "unimarket.chart-analysis/v1" as const;

const finiteNumberSchema = z.number().finite();
const isoDateTimeSchema = z.string().datetime({ offset: true });
const identifierSchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const analysisCandleSchema = z.object({
  timestamp: isoDateTimeSchema,
  open: finiteNumberSchema,
  high: finiteNumberSchema,
  low: finiteNumberSchema,
  close: finiteNumberSchema,
  volume: finiteNumberSchema.nonnegative(),
}).strict().superRefine((candle, ctx) => {
  if (candle.low > candle.high) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["low"], message: "low cannot exceed high" });
  }
  if (candle.open < candle.low || candle.open > candle.high) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["open"], message: "open must be inside the candle range" });
  }
  if (candle.close < candle.low || candle.close > candle.high) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["close"], message: "close must be inside the candle range" });
  }
});

export const chartPointSchema = z.object({
  time: isoDateTimeSchema,
  price: finiteNumberSchema,
}).strict();

const drawingStyleSchema = z.object({
  color: z.enum(["support", "resistance", "accent", "muted", "warning"]).default("accent"),
  width: z.number().int().min(1).max(4).default(2),
  lineStyle: z.enum(["solid", "dashed", "dotted"]).default("solid"),
  opacity: z.number().min(0.1).max(1).default(0.9),
}).strict().default({});

const labelPlacementSchema = z.object({
  at: z.enum(["start", "middle", "end"]).default("start"),
  offsetX: z.number().min(-120).max(120).default(8),
  offsetY: z.number().min(-80).max(80).default(-8),
}).strict().default({});

const drawingMetadataShape = {
  id: identifierSchema,
  label: z.string().trim().min(1).max(160).optional(),
  rationale: z.string().trim().min(1).max(2_000),
  confidence: z.number().min(0).max(1).optional(),
  visible: z.boolean().default(true),
  style: drawingStyleSchema,
  labelPlacement: labelPlacementSchema,
};

const distinctAnchors = <T extends { time: string; price: number }[]>(anchors: T): boolean =>
  new Set(anchors.map((anchor) => `${anchor.time}:${anchor.price}`)).size === anchors.length;

const horizontalLineSchema = z.object({
  ...drawingMetadataShape,
  type: z.literal("horizontalLine"),
  price: finiteNumberSchema,
}).strict();

const verticalLineSchema = z.object({
  ...drawingMetadataShape,
  type: z.literal("verticalLine"),
  time: isoDateTimeSchema,
}).strict();

const twoAnchorDrawing = {
  ...drawingMetadataShape,
  anchors: z.tuple([chartPointSchema, chartPointSchema]).refine(distinctAnchors, "anchors must be distinct"),
};

const trendLineSchema = z.object({
  ...twoAnchorDrawing,
  type: z.literal("trendLine"),
  extend: z.object({ left: z.boolean().default(false), right: z.boolean().default(false) }).strict().default({}),
}).strict();

const raySchema = z.object({
  ...twoAnchorDrawing,
  type: z.literal("ray"),
}).strict();

const channelSchema = z.object({
  ...drawingMetadataShape,
  type: z.literal("channel"),
  base: z.tuple([chartPointSchema, chartPointSchema]).refine(distinctAnchors, "base anchors must be distinct"),
  parallelAnchor: chartPointSchema,
  fillOpacity: z.number().min(0).max(0.35).default(0.08),
}).strict();

const rectangleSchema = z.object({
  ...twoAnchorDrawing,
  type: z.literal("rectangle"),
  fillOpacity: z.number().min(0).max(0.35).default(0.08),
}).strict();

const markerSchema = z.object({
  ...drawingMetadataShape,
  type: z.literal("marker"),
  point: chartPointSchema,
  shape: z.enum(["circle", "diamond", "arrowUp", "arrowDown"]).default("circle"),
}).strict();

const textSchema = z.object({
  ...drawingMetadataShape,
  type: z.literal("text"),
  point: chartPointSchema,
  text: z.string().trim().min(1).max(500),
}).strict();

export const drawingLayerSchema = z.discriminatedUnion("type", [
  horizontalLineSchema,
  verticalLineSchema,
  trendLineSchema,
  raySchema,
  channelSchema,
  rectangleSchema,
  markerSchema,
  textSchema,
]);

const periodIndicator = {
  id: identifierSchema,
  visible: z.boolean().default(true),
  period: z.number().int().min(2).max(500),
};

export const indicatorLayerSchema = z.union([
  z.object({ ...periodIndicator, type: z.literal("sma") }).strict(),
  z.object({ ...periodIndicator, type: z.literal("ema") }).strict(),
  z.object({ ...periodIndicator, type: z.literal("rsi") }).strict(),
  z.object({ ...periodIndicator, type: z.literal("atr") }).strict(),
  z.object({
    id: identifierSchema,
    visible: z.boolean().default(true),
    type: z.literal("macd"),
    fastPeriod: z.number().int().min(2).max(200).default(12),
    slowPeriod: z.number().int().min(3).max(500).default(26),
    signalPeriod: z.number().int().min(2).max(200).default(9),
  }).strict().refine((value) => value.fastPeriod < value.slowPeriod, {
    path: ["fastPeriod"],
    message: "fastPeriod must be less than slowPeriod",
  }),
  z.object({
    ...periodIndicator,
    type: z.literal("bollingerBands"),
    standardDeviations: z.number().positive().max(6).default(2),
  }).strict(),
  z.object({
    id: identifierSchema,
    visible: z.boolean().default(true),
    type: z.literal("volumeProfile"),
    from: isoDateTimeSchema,
    to: isoDateTimeSchema,
    bins: z.number().int().min(8).max(200).default(48),
    valueAreaPercent: z.number().min(50).max(99).default(70),
    method: z.literal("ohlcv-range-approximation").default("ohlcv-range-approximation"),
  }).strict().refine((value) => Date.parse(value.from) < Date.parse(value.to), {
    path: ["to"],
    message: "to must be later than from",
  }),
]);

export const chartLayerSchema = z.union([drawingLayerSchema, indicatorLayerSchema]);

const chartViewportSchema = z.object({
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  priceScale: z.enum(["auto", "logarithmic"]).default("auto"),
}).strict().superRefine((viewport, ctx) => {
  if ((viewport.from === undefined) !== (viewport.to === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "viewport from and to must be provided together" });
  }
  if (viewport.from && viewport.to && Date.parse(viewport.from) >= Date.parse(viewport.to)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "viewport to must be later than from" });
  }
}).default({});

export const chartAnalysisDocumentSchema = z.object({
  schema: z.literal(CHART_ANALYSIS_SCHEMA),
  title: z.string().trim().min(1).max(160),
  instrument: z.object({
    market: identifierSchema,
    reference: z.string().trim().min(1).max(200),
    displayName: z.string().trim().min(1).max(200).optional(),
  }).strict(),
  data: z.object({
    interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1mo"]),
    from: isoDateTimeSchema,
    to: isoDateTimeSchema,
    asOf: isoDateTimeSchema,
    snapshotHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict().superRefine((value, ctx) => {
    if (Date.parse(value.from) >= Date.parse(value.to)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be later than from" });
    }
    if (value.asOf !== value.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["asOf"], message: "asOf must equal the snapshot range end" });
    }
  }),
  viewport: chartViewportSchema,
  thesis: z.string().trim().min(1).max(4_000),
  invalidation: z.string().trim().min(1).max(2_000),
  layers: z.array(chartLayerSchema).max(100),
  metadata: z.object({
    createdBy: z.object({
      kind: z.enum(["agent", "human", "system"]),
      actorId: identifierSchema,
    }).strict(),
    runId: z.string().trim().min(1).max(200).optional(),
    createdAt: isoDateTimeSchema,
  }).strict(),
}).strict().superRefine((document, ctx) => {
  const ids = new Set<string>();
  document.layers.forEach((layer, index) => {
    if (ids.has(layer.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["layers", index, "id"], message: "layer ids must be unique" });
    }
    ids.add(layer.id);
  });
  if (document.viewport.from && Date.parse(document.viewport.from) < Date.parse(document.data.from)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["viewport", "from"], message: "viewport must stay inside the candle snapshot" });
  }
  if (document.viewport.to && Date.parse(document.viewport.to) > Date.parse(document.data.to)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["viewport", "to"], message: "viewport must stay inside the candle snapshot" });
  }
});

export const createAnalysisDocumentSchema = z.object({
  document: chartAnalysisDocumentSchema,
  reasoning: z.string().trim().min(1).max(2_000),
  supersedesId: identifierSchema.optional(),
}).strict();

export const updateAnalysisDocumentSchema = createAnalysisDocumentSchema;

export const publishAnalysisDocumentSchema = z.object({
  reasoning: z.string().trim().min(1).max(2_000),
}).strict();

export type AnalysisCandle = z.infer<typeof analysisCandleSchema>;
export type ChartPoint = z.infer<typeof chartPointSchema>;
export type DrawingLayer = z.infer<typeof drawingLayerSchema>;
export type IndicatorLayer = z.infer<typeof indicatorLayerSchema>;
export type ChartLayer = z.infer<typeof chartLayerSchema>;
export type ChartAnalysisDocument = z.infer<typeof chartAnalysisDocumentSchema>;
export type CreateAnalysisDocumentInput = z.infer<typeof createAnalysisDocumentSchema>;
