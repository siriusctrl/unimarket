import { describe, expect, it } from "vitest";

import {
  CHART_ANALYSIS_SCHEMA,
  analysisCandleSchema,
  buildDrawingRenderMetadata,
  chartAnalysisDocumentSchema,
  computeIndicators,
  updateAnalysisDocumentSchema,
  type AnalysisCandle,
} from "../src/index.js";

const candles: AnalysisCandle[] = Array.from({ length: 40 }, (_, index) => {
  const open = 100 + index;
  const close = open + (index % 2 === 0 ? 2 : -1);
  return {
    timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    open,
    high: Math.max(open, close) + 2,
    low: Math.min(open, close) - 2,
    close,
    volume: 1_000 + index * 25,
  };
});

const document = {
  schema: CHART_ANALYSIS_SCHEMA,
  title: "MU structure review",
  instrument: { market: "hyperliquid", reference: "xyz:MU", displayName: "Micron Technology proxy" },
  data: {
    interval: "1d",
    from: candles[0].timestamp,
    to: candles.at(-1)!.timestamp,
    asOf: candles.at(-1)!.timestamp,
    snapshotHash: `sha256:${"a".repeat(64)}`,
  },
  viewport: { priceScale: "auto" },
  thesis: "Higher lows keep the medium-term structure constructive.",
  invalidation: "A daily close below the rising support invalidates the setup.",
  layers: [
    {
      id: "support",
      type: "trendLine",
      anchors: [
        { time: candles[4].timestamp, price: candles[4].low },
        { time: candles[24].timestamp, price: candles[24].low },
      ],
      extend: { right: true },
      rationale: "Connects two swing lows.",
      style: { color: "support" },
    },
    { id: "sma-20", type: "sma", period: 20 },
  ],
  metadata: {
    createdBy: { kind: "agent", actorId: "agent-atlas" },
    createdAt: candles.at(-1)!.timestamp,
  },
};

describe("chart analysis protocol", () => {
  it("parses a provider-neutral document and rejects duplicate layer ids", () => {
    expect(chartAnalysisDocumentSchema.parse(document).layers).toHaveLength(2);
    expect(chartAnalysisDocumentSchema.safeParse({
      ...document,
      layers: [...document.layers, { ...document.layers[1] }],
    }).success).toBe(false);
    expect(updateAnalysisDocumentSchema.safeParse({
      document,
      reasoning: "Update the draft",
      supersedesId: "ana_previous",
    }).success).toBe(false);
  });

  it("computes deterministic indicators and an explicitly approximate volume profile", () => {
    const indicators = computeIndicators(candles, [
      { id: "sma", type: "sma", period: 20, visible: true },
      { id: "rsi", type: "rsi", period: 14, visible: true },
      {
        id: "profile",
        type: "volumeProfile",
        from: candles[5].timestamp,
        to: candles[35].timestamp,
        bins: 16,
        valueAreaPercent: 70,
        method: "ohlcv-range-approximation",
        visible: true,
      },
    ], "1d");

    expect(indicators[0].points[18].values.value).toBeNull();
    expect(indicators[0].points[19].values.value).toBeTypeOf("number");
    expect(indicators[1].points[14].values.rsi).toBeTypeOf("number");
    expect(indicators[2].profile).toMatchObject({
      method: "ohlcv-range-approximation",
      sourceGranularity: "1d",
      bins: expect.any(Array),
    });
    expect(indicators[2].profile?.bins).toHaveLength(16);
  });

  it("starts the MACD signal only after enough real MACD values exist", () => {
    const indicator = computeIndicators(candles, [{
      id: "macd",
      type: "macd",
      fastPeriod: 5,
      slowPeriod: 10,
      signalPeriod: 4,
      visible: true,
    }], "1d")[0];

    expect(indicator.points[8].values.macd).toBeNull();
    expect(indicator.points[9].values.macd).toBeTypeOf("number");
    expect(indicator.points[11].values.signal).toBeNull();
    expect(indicator.points[12].values.signal).toBeTypeOf("number");
  });

  it("computes the remaining price and volatility indicators and skips hidden layers", () => {
    const indicators = computeIndicators(candles, [
      { id: "ema", type: "ema", period: 8, visible: true },
      { id: "atr", type: "atr", period: 5, visible: true },
      { id: "bands", type: "bollingerBands", period: 10, standardDeviations: 2, visible: true },
      { id: "hidden", type: "sma", period: 5, visible: false },
    ], "1d");

    expect(indicators.map((indicator) => indicator.id)).toEqual(["ema", "atr", "bands"]);
    expect(indicators[0].points[7].values.value).toBeTypeOf("number");
    expect(indicators[1].points[4].values.atr).toBeTypeOf("number");
    expect(indicators[2].points[8].values.middle).toBeNull();
    expect(indicators[2].points[9].values).toMatchObject({
      lower: expect.any(Number),
      middle: expect.any(Number),
      upper: expect.any(Number),
    });
  });

  it("handles insufficient samples and empty or flat volume-profile ranges", () => {
    const tooShort = computeIndicators(candles.slice(0, 3), [
      { id: "ema", type: "ema", period: 10, visible: true },
      { id: "rsi", type: "rsi", period: 10, visible: true },
      { id: "atr", type: "atr", period: 10, visible: true },
      { id: "macd", type: "macd", fastPeriod: 3, slowPeriod: 8, signalPeriod: 3, visible: true },
    ], "1d");
    expect(tooShort.every((indicator) => indicator.points.every((point) => Object.values(point.values).every((value) => value === null))))
      .toBe(true);

    const emptyProfile = computeIndicators(candles, [{
      id: "empty-profile",
      type: "volumeProfile",
      from: "2030-01-01T00:00:00.000Z",
      to: "2030-02-01T00:00:00.000Z",
      bins: 8,
      valueAreaPercent: 70,
      method: "ohlcv-range-approximation",
      visible: true,
    }], "1d")[0];
    expect(emptyProfile.profile).toMatchObject({ pointOfControl: null, bins: [] });

    const flat = candles.slice(0, 2).map((candle) => ({ ...candle, open: 100, high: 100, low: 100, close: 100 }));
    const flatProfile = computeIndicators(flat, [{
      id: "flat-profile",
      type: "volumeProfile",
      from: flat[0].timestamp,
      to: flat[1].timestamp,
      bins: 8,
      valueAreaPercent: 70,
      method: "ohlcv-range-approximation",
      visible: true,
    }], "1d")[0];
    expect(flatProfile.profile?.bins).toEqual([{
      low: 100,
      high: 100,
      volume: flat.reduce((sum, candle) => sum + candle.volume, 0),
      inValueArea: true,
    }]);
    expect(flatProfile.profile?.pointOfControl).toBe(100);

    const flatRsi = computeIndicators(Array.from({ length: 20 }, (_, index) => ({
      ...candles[index],
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 0,
    })), [{ id: "flat-rsi", type: "rsi", period: 14, visible: true }], "1d")[0];
    expect(flatRsi.points[14].values.rsi).toBe(50);

    const zeroVolumeProfile = computeIndicators(candles.map((candle) => ({ ...candle, volume: 0 })), [{
      id: "zero-volume",
      type: "volumeProfile",
      from: candles[0].timestamp,
      to: candles.at(-1)!.timestamp,
      bins: 8,
      valueAreaPercent: 70,
      method: "ohlcv-range-approximation",
      visible: true,
    }], "1d")[0];
    expect(zeroVolumeProfile.profile).toMatchObject({
      pointOfControl: null,
      valueAreaLow: null,
      valueAreaHigh: null,
    });
    expect(zeroVolumeProfile.profile?.bins.every((bin) => !bin.inValueArea)).toBe(true);
  });

  it("rejects unknown executable-looking fields and mismatched snapshot times", () => {
    expect(chartAnalysisDocumentSchema.safeParse({ ...document, script: "alert(1)" }).success).toBe(false);
    expect(chartAnalysisDocumentSchema.safeParse({
      ...document,
      data: { ...document.data, asOf: candles[20].timestamp },
    }).success).toBe(false);

    expect(analysisCandleSchema.safeParse({ ...candles[0], low: 120, high: 110 }).success).toBe(false);
    expect(analysisCandleSchema.safeParse({ ...candles[0], open: 200 }).success).toBe(false);
    expect(analysisCandleSchema.safeParse({ ...candles[0], close: 50 }).success).toBe(false);
    expect(chartAnalysisDocumentSchema.safeParse({
      ...document,
      data: { ...document.data, from: document.data.to },
    }).success).toBe(false);
    expect(chartAnalysisDocumentSchema.safeParse({
      ...document,
      layers: [{ id: "bad-macd", type: "macd", fastPeriod: 20, slowPeriod: 10, signalPeriod: 4 }],
    }).success).toBe(false);
    expect(chartAnalysisDocumentSchema.safeParse({
      ...document,
      viewport: { from: candles[10].timestamp, priceScale: "auto" },
    }).success).toBe(false);
    expect(chartAnalysisDocumentSchema.safeParse({
      ...document,
      viewport: { from: candles[20].timestamp, to: candles[10].timestamp, priceScale: "auto" },
    }).success).toBe(false);
    expect(chartAnalysisDocumentSchema.safeParse({
      ...document,
      viewport: {
        from: new Date(Date.parse(candles[0].timestamp) - 86_400_000).toISOString(),
        to: candles[10].timestamp,
      },
    }).success).toBe(false);
    expect(chartAnalysisDocumentSchema.safeParse({
      ...document,
      layers: [{
        id: "vertical-ray",
        type: "ray",
        anchors: [
          { time: candles[10].timestamp, price: 100 },
          { time: candles[10].timestamp, price: 110 },
        ],
        rationale: "Degenerate ray",
      }],
    }).success).toBe(false);
    expect(chartAnalysisDocumentSchema.safeParse({
      ...document,
      layers: [{
        id: "flat-rectangle",
        type: "rectangle",
        anchors: [
          { time: candles[10].timestamp, price: 100 },
          { time: candles[20].timestamp, price: 100 },
        ],
        rationale: "Degenerate rectangle",
      }],
    }).success).toBe(false);
    expect(chartAnalysisDocumentSchema.safeParse({
      ...document,
      layers: [{
        id: "zero-width-channel",
        type: "channel",
        base: [
          { time: candles[10].timestamp, price: 100 },
          { time: candles[20].timestamp, price: 120 },
        ],
        parallelAnchor: { time: candles[15].timestamp, price: 110 },
        rationale: "Degenerate channel",
      }],
    }).success).toBe(false);
  });

  it("reports drawings outside the declared viewport as clipped", () => {
    const parsed = chartAnalysisDocumentSchema.parse({
      ...document,
      viewport: { from: candles[10].timestamp, to: candles.at(-1)!.timestamp, priceScale: "auto" },
    });
    expect(buildDrawingRenderMetadata(parsed)).toEqual([
      expect.objectContaining({ id: "support", anchorsInsideTimeViewport: false, timeClipped: true }),
    ]);
  });

  it("describes anchors for every drawing primitive and ignores indicators", () => {
    const point = { time: candles[15].timestamp, price: candles[15].close };
    const parsed = chartAnalysisDocumentSchema.parse({
      ...document,
      layers: [
        { id: "h", type: "horizontalLine", price: 120, rationale: "Range resistance." },
        { id: "v", type: "verticalLine", time: point.time, rationale: "Event session." },
        { id: "ray", type: "ray", anchors: [point, { time: candles[20].timestamp, price: 130 }], rationale: "Projected slope." },
        { id: "channel", type: "channel", base: [point, { time: candles[20].timestamp, price: 130 }], parallelAnchor: { ...point, price: 140 }, rationale: "Parallel structure." },
        { id: "rectangle", type: "rectangle", anchors: [point, { time: candles[20].timestamp, price: 130 }], rationale: "Consolidation zone." },
        { id: "marker", type: "marker", point, rationale: "Pivot." },
        { id: "text", type: "text", point, text: "Earnings", rationale: "Catalyst label." },
        { id: "sma", type: "sma", period: 10 },
      ],
    });
    const metadata = buildDrawingRenderMetadata(parsed);
    expect(metadata).toHaveLength(7);
    expect(metadata.find((entry) => entry.id === "h")?.anchors).toHaveLength(2);
    expect(metadata.find((entry) => entry.id === "v")?.anchors).toEqual([{ time: point.time, price: 0 }]);
    expect(metadata.find((entry) => entry.id === "channel")?.anchors).toHaveLength(3);
    expect(metadata.find((entry) => entry.id === "marker")?.anchors).toEqual([point]);
    expect(metadata.every((entry) => entry.anchorsInsideTimeViewport)).toBe(true);
  });
});
