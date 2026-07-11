import type { ChartAnalysisDocument, ChartPoint, DrawingLayer } from "@unimarket/analysis";

export type ScreenPoint = { x: number; y: number };
export type ProjectedDrawing = {
  id: string;
  type: DrawingLayer["type"];
  points: ScreenPoint[];
  label?: string;
  text?: string;
  color: DrawingLayer["style"]["color"];
  width: number;
  lineStyle: DrawingLayer["style"]["lineStyle"];
  opacity: number;
  fillOpacity?: number;
  shape?: "circle" | "diamond" | "arrowUp" | "arrowDown";
  labelPlacement: DrawingLayer["labelPlacement"];
};

type Projectors = {
  time: (value: string) => number | null;
  price: (value: number) => number | null;
};

const projectPoint = (point: ChartPoint, projectors: Projectors): ScreenPoint | null => {
  const x = projectors.time(point.time);
  const y = projectors.price(point.price);
  return x === null || y === null ? null : { x, y };
};

export const projectDrawing = (
  layer: DrawingLayer,
  document: ChartAnalysisDocument,
  projectors: Projectors,
  size: { width: number; height: number },
): ProjectedDrawing | null => {
  const common = {
    id: layer.id,
    type: layer.type,
    label: layer.label,
    color: layer.style.color,
    width: layer.style.width,
    lineStyle: layer.style.lineStyle,
    opacity: layer.style.opacity,
    labelPlacement: layer.labelPlacement,
  };

  if (layer.type === "horizontalLine") {
    const y = projectors.price(layer.price);
    return y === null ? null : { ...common, points: [{ x: 0, y }, { x: size.width, y }] };
  }
  if (layer.type === "verticalLine") {
    const x = projectors.time(layer.time);
    return x === null ? null : { ...common, points: [{ x, y: 0 }, { x, y: size.height }] };
  }
  if (layer.type === "marker" || layer.type === "text") {
    const point = projectPoint(layer.point, projectors);
    if (!point) return null;
    return {
      ...common,
      points: [point],
      ...(layer.type === "marker" ? { shape: layer.shape } : { text: layer.text }),
    };
  }
  if (layer.type === "channel") {
    const points = [...layer.base, layer.parallelAnchor].map((point) => projectPoint(point, projectors));
    if (points.some((point) => point === null)) return null;
    const [first, second, parallel] = points as [ScreenPoint, ScreenPoint, ScreenPoint];
    const parallelEnd = { x: parallel.x + (second.x - first.x), y: parallel.y + (second.y - first.y) };
    return { ...common, points: [first, second, parallelEnd, parallel], fillOpacity: layer.fillOpacity };
  }

  const points = layer.anchors.map((point) => projectPoint(point, projectors));
  if (points.some((point) => point === null)) return null;
  const projected = points as [ScreenPoint, ScreenPoint];
  if (layer.type === "rectangle") {
    const [first, second] = projected;
    return {
      ...common,
      points: [
        first,
        { x: second.x, y: first.y },
        second,
        { x: first.x, y: second.y },
      ],
      fillOpacity: layer.fillOpacity,
    };
  }
  if (layer.type === "ray" || (layer.type === "trendLine" && layer.extend.right)) {
    const [first, second] = projected;
    const dx = second.x - first.x;
    if (dx !== 0) {
      const factor = (size.width - second.x) / dx;
      projected[1] = { x: size.width, y: second.y + (second.y - first.y) * factor };
    }
  }
  if (layer.type === "trendLine" && layer.extend.left) {
    const [first, second] = projected;
    const dx = second.x - first.x;
    if (dx !== 0) {
      const factor = first.x / dx;
      projected[0] = { x: 0, y: first.y - (second.y - first.y) * factor };
    }
  }
  return {
    ...common,
    points: projected,
  };
};
