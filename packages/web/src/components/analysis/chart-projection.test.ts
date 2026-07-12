import { describe, expect, it } from "vitest";
import { chartAnalysisDocumentSchema } from "@unimarket/analysis";

import { drawingIntersectsViewport, projectDrawing, projectVolumeProfile } from "./chart-projection";

const document = chartAnalysisDocumentSchema.parse({
  schema: "unimarket.chart-analysis/v1",
  title: "Projection fixture",
  instrument: { market: "hyperliquid", reference: "xyz:MU" },
  data: {
    interval: "1d",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-10T00:00:00.000Z",
    asOf: "2026-01-10T00:00:00.000Z",
    snapshotHash: `sha256:${"a".repeat(64)}`,
  },
  viewport: { priceScale: "auto" },
  thesis: "Projection fixture thesis.",
  invalidation: "Projection fixture invalidation.",
  layers: [],
  metadata: { createdBy: { kind: "system", actorId: "projection-test" }, createdAt: "2026-01-10T00:00:00.000Z" },
});

const style = { color: "support" as const, width: 2, lineStyle: "solid" as const, opacity: 0.9 };
const labelPlacement = { at: "start" as const, offsetX: 8, offsetY: -8 };
const projectors = {
  time: (value: string) => (Date.parse(value) - Date.parse(document.data.from)) / 86_400_000 * 100,
  price: (value: number) => 500 - value,
};

describe("chart drawing projection", () => {
  it("extends a trend line to the right edge", () => {
    const drawing = projectDrawing({
      id: "support",
      type: "trendLine",
      anchors: [
        { time: "2026-01-02T00:00:00.000Z", price: 100 },
        { time: "2026-01-04T00:00:00.000Z", price: 120 },
      ],
      extend: { left: false, right: true },
      rationale: "Fixture",
      visible: true,
      style,
      labelPlacement,
    }, document, projectors, { width: 900, height: 500 });

    expect(drawing?.points[1].x).toBe(900);
    expect(drawing?.points[1].y).toBeLessThan(drawing!.points[0].y);
  });

  it("constructs a parallel channel polygon from three market anchors", () => {
    const drawing = projectDrawing({
      id: "channel",
      type: "channel",
      base: [
        { time: "2026-01-02T00:00:00.000Z", price: 100 },
        { time: "2026-01-04T00:00:00.000Z", price: 120 },
      ],
      parallelAnchor: { time: "2026-01-02T00:00:00.000Z", price: 140 },
      fillOpacity: 0.08,
      rationale: "Fixture",
      visible: true,
      style,
      labelPlacement,
    }, document, projectors, { width: 900, height: 500 });

    expect(drawing?.points).toHaveLength(4);
    if (!drawing) throw new Error("Channel projection was not generated");
    expect(drawing.points[2].x - drawing.points[3].x).toBe(drawing.points[1].x - drawing.points[0].x);
  });

  it("expands rectangle diagonal anchors into four axis-aligned corners", () => {
    const drawing = projectDrawing({
      id: "supply",
      type: "rectangle",
      anchors: [
        { time: "2026-01-02T00:00:00.000Z", price: 100 },
        { time: "2026-01-04T00:00:00.000Z", price: 140 },
      ],
      fillOpacity: 0.08,
      rationale: "Fixture",
      visible: true,
      style,
      labelPlacement,
    }, document, projectors, { width: 900, height: 500 });

    expect(drawing?.points).toEqual([
      { x: 100, y: 400 },
      { x: 300, y: 400 },
      { x: 300, y: 360 },
      { x: 100, y: 360 },
    ]);
  });

  it("distinguishes on-screen drawings and projects volume bins", () => {
    const visible = projectDrawing({
      id: "visible",
      type: "horizontalLine",
      price: 100,
      rationale: "Fixture",
      visible: true,
      style,
      labelPlacement,
    }, document, projectors, { width: 900, height: 500 })!;
    const clipped = { ...visible, points: visible.points.map((point) => ({ ...point, y: -20 })) };
    expect(drawingIntersectsViewport(visible, { width: 900, height: 500 })).toBe(true);
    expect(drawingIntersectsViewport(clipped, { width: 900, height: 500 })).toBe(false);

    expect(projectVolumeProfile({
      method: "ohlcv-range-approximation",
      sourceGranularity: "1d",
      pointOfControl: 100,
      valueAreaLow: 100,
      valueAreaHigh: 110,
      bins: [{ low: 100, high: 110, volume: 50, inValueArea: true }],
    }, (price) => 500 - price, 900)).toEqual([{
      x: 708,
      y: 390,
      width: 120,
      height: 10,
      inValueArea: true,
    }]);
  });
});
