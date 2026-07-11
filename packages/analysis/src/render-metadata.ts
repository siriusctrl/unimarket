import type { ChartAnalysisDocument, ChartPoint, DrawingLayer } from "./schema.js";

export type DrawingRenderMetadata = {
  id: string;
  type: DrawingLayer["type"];
  anchors: ChartPoint[];
  anchorsInsideTimeViewport: boolean;
  timeClipped: boolean;
};

const drawingAnchors = (layer: DrawingLayer, document: ChartAnalysisDocument): ChartPoint[] => {
  if (layer.type === "horizontalLine") {
    return [
      { time: document.data.from, price: layer.price },
      { time: document.data.to, price: layer.price },
    ];
  }
  if (layer.type === "verticalLine") return [{ time: layer.time, price: 0 }];
  if (layer.type === "channel") return [...layer.base, layer.parallelAnchor];
  if (layer.type === "marker" || layer.type === "text") return [layer.point];
  return [...layer.anchors];
};

export const buildDrawingRenderMetadata = (
  document: ChartAnalysisDocument,
): DrawingRenderMetadata[] => {
  const from = Date.parse(document.viewport.from ?? document.data.from);
  const to = Date.parse(document.viewport.to ?? document.data.to);
  return document.layers.flatMap((layer) => {
    if (!("rationale" in layer)) return [];
    const anchors = drawingAnchors(layer, document);
    const anchorsInsideTimeViewport = anchors.every((anchor) => {
      const timestamp = Date.parse(anchor.time);
      return timestamp >= from && timestamp <= to;
    });
    return [{
      id: layer.id,
      type: layer.type,
      anchors,
      anchorsInsideTimeViewport,
      timeClipped: !anchorsInsideTimeViewport,
    }];
  });
};
