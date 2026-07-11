import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartAnalysisDocument, ChartContext, DrawingLayer } from "@unimarket/analysis";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  PriceScaleMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

import { projectDrawing, type ProjectedDrawing } from "./chart-projection";

const COLOR_MAP = {
  support: "#69b892",
  resistance: "#d47c68",
  accent: "#d7b86b",
  muted: "#8b929b",
  warning: "#d9a05b",
} as const;

const SERIES_COLORS = ["#69b892", "#d7b86b", "#c37c93", "#73a3b8", "#ad8fd0"];
type ProfileBar = { x: number; y: number; width: number; height: number; inValueArea: boolean };

const timestamp = (value: string): UTCTimestamp => Math.floor(Date.parse(value) / 1_000) as UTCTimestamp;

const lineDash = (style: ProjectedDrawing["lineStyle"]): string | undefined => {
  if (style === "dashed") return "8 6";
  if (style === "dotted") return "2 5";
  return undefined;
};

const labelAnchor = (drawing: ProjectedDrawing) => {
  if (drawing.labelPlacement.at === "middle") {
    return drawing.points.reduce(
      (center, point) => ({ x: center.x + point.x / drawing.points.length, y: center.y + point.y / drawing.points.length }),
      { x: 0, y: 0 },
    );
  }
  if (drawing.labelPlacement.at === "end") return drawing.points.at(-1)!;
  return drawing.points[0];
};

const DrawingLabel = ({ drawing, color, text }: { drawing: ProjectedDrawing; color: string; text?: string }) => {
  if (!text) return null;
  const anchor = labelAnchor(drawing);
  return (
    <text
      x={anchor.x + drawing.labelPlacement.offsetX}
      y={anchor.y + drawing.labelPlacement.offsetY}
      fill={color}
      fontSize="11"
    >
      {text}
    </text>
  );
};

const MarkerGlyph = ({ drawing, color }: { drawing: ProjectedDrawing; color: string }) => {
  const point = drawing.points[0];
  if (drawing.shape === "diamond") {
    return <polygon points={`${point.x},${point.y - 6} ${point.x + 6},${point.y} ${point.x},${point.y + 6} ${point.x - 6},${point.y}`} fill={color} />;
  }
  if (drawing.shape === "arrowUp") {
    return <path d={`M ${point.x} ${point.y - 7} L ${point.x + 6} ${point.y + 2} H ${point.x + 2} V ${point.y + 7} H ${point.x - 2} V ${point.y + 2} H ${point.x - 6} Z`} fill={color} />;
  }
  if (drawing.shape === "arrowDown") {
    return <path d={`M ${point.x} ${point.y + 7} L ${point.x + 6} ${point.y - 2} H ${point.x + 2} V ${point.y - 7} H ${point.x - 2} V ${point.y - 2} H ${point.x - 6} Z`} fill={color} />;
  }
  return <circle cx={point.x} cy={point.y} r="5" fill={color} />;
};

const DrawingOverlay = ({ drawings, profileBars }: { drawings: ProjectedDrawing[]; profileBars: ProfileBar[] }) => (
  <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-hidden" aria-label="Technical analysis drawings">
    <g aria-label="Approximate volume profile" data-volume-profile-bins={profileBars.length}>
      {profileBars.map((bar, index) => (
        <rect
          key={index}
          data-profile-bin={index}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={bar.height}
          fill={bar.inValueArea ? "#d7b86b" : "#8b929b"}
          fillOpacity={bar.inValueArea ? 0.2 : 0.1}
        />
      ))}
    </g>
    {drawings.map((drawing) => {
      const stroke = COLOR_MAP[drawing.color];
      if (drawing.type === "channel" || drawing.type === "rectangle") {
        const points = drawing.points.map((point) => `${point.x},${point.y}`).join(" ");
        return (
          <g key={drawing.id} data-drawing-id={drawing.id}>
            <polygon
              points={points}
              fill={stroke}
              fillOpacity={drawing.fillOpacity}
              stroke={stroke}
              strokeWidth={drawing.width}
              strokeDasharray={lineDash(drawing.lineStyle)}
              opacity={drawing.opacity}
            />
            <DrawingLabel drawing={drawing} color={stroke} text={drawing.label} />
          </g>
        );
      }
      if (drawing.type === "marker" || drawing.type === "text") {
        return (
          <g key={drawing.id} data-drawing-id={drawing.id}>
            {drawing.type === "marker" ? <MarkerGlyph drawing={drawing} color={stroke} /> : null}
            <DrawingLabel drawing={drawing} color={stroke} text={drawing.text ?? drawing.label} />
          </g>
        );
      }
      const [first, second] = drawing.points;
      return (
        <g key={drawing.id} data-drawing-id={drawing.id}>
          <line
            x1={first.x}
            y1={first.y}
            x2={second.x}
            y2={second.y}
            stroke={stroke}
            strokeWidth={drawing.width}
            strokeDasharray={lineDash(drawing.lineStyle)}
            opacity={drawing.opacity}
          />
          <DrawingLabel drawing={drawing} color={stroke} text={drawing.label} />
        </g>
      );
    })}
  </svg>
);

export const FinancialChart = ({
  context,
  document,
}: {
  context: ChartContext;
  document: ChartAnalysisDocument | null;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [drawings, setDrawings] = useState<ProjectedDrawing[]>([]);
  const [profileBars, setProfileBars] = useState<ProfileBar[]>([]);
  const [dark, setDark] = useState(() => window.document.documentElement.classList.contains("dark"));
  const drawingLayers = useMemo(
    () => document?.layers.filter((layer): layer is DrawingLayer => "rationale" in layer && layer.visible) ?? [],
    [document],
  );

  useEffect(() => {
    const root = window.document.documentElement;
    const observer = new MutationObserver(() => setDark(root.classList.contains("dark")));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: dark ? "#17191c" : "#ffffff" },
        textColor: dark ? "#b9b7b0" : "#5b5d61",
        fontFamily: "IBM Plex Mono, monospace",
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: dark ? "#25282d" : "#eceae4" },
        horzLines: { color: dark ? "#25282d" : "#eceae4" },
      },
      rightPriceScale: {
        borderColor: dark ? "#34383e" : "#d8d5cc",
        mode: document?.viewport.priceScale === "logarithmic" ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      },
      timeScale: { borderColor: dark ? "#34383e" : "#d8d5cc", timeVisible: context.data.interval !== "1d" },
      crosshair: {
        vertLine: { color: dark ? "#717780" : "#8b8e92", labelBackgroundColor: "#315e48" },
        horzLine: { color: dark ? "#717780" : "#8b8e92", labelBackgroundColor: "#315e48" },
      },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#69b892",
      downColor: "#d47c68",
      borderVisible: false,
      wickUpColor: "#69b892",
      wickDownColor: "#d47c68",
      priceLineVisible: true,
    });
    candleSeriesRef.current = candleSeries;
    candleSeries.setData(context.data.candles.map((candle) => ({
      time: timestamp(candle.timestamp),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })));

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volumeSeries.setData(context.data.candles.map((candle) => ({
      time: timestamp(candle.timestamp),
      value: candle.volume,
      color: candle.close >= candle.open ? "rgba(105,184,146,0.32)" : "rgba(212,124,104,0.3)",
    })));

    let colorIndex = 0;
    context.indicators.filter((indicator) => indicator.pane !== "volumeProfile").forEach((indicator) => {
      const keys = Object.keys(indicator.points.find((point) => Object.values(point.values).some((value) => value !== null))?.values ?? {});
      keys.forEach((key) => {
        const series = chart.addSeries(LineSeries, {
          color: SERIES_COLORS[colorIndex % SERIES_COLORS.length],
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
        }, indicator.pane === "oscillator" ? 1 : 0);
        colorIndex += 1;
        series.setData(indicator.points.flatMap((point) => {
          const value = point.values[key];
          return value === null ? [] : [{ time: timestamp(point.timestamp), value }];
        }));
      });
    });

    const project = () => {
      if (!candleSeriesRef.current || !containerRef.current) return;
      const next = document ? drawingLayers.flatMap((layer) => {
        const projected = projectDrawing(
          layer,
          document,
          {
            time: (value) => chart.timeScale().timeToCoordinate(timestamp(value) as Time),
            price: (value) => candleSeries.priceToCoordinate(value),
          },
          { width: container.clientWidth, height: container.clientHeight },
        );
        return projected ? [projected] : [];
      }) : [];
      setDrawings(next);

      const profile = context.indicators.find((indicator) => indicator.type === "volumeProfile")?.profile;
      const maxVolume = Math.max(0, ...(profile?.bins.map((bin) => bin.volume) ?? []));
      if (!profile || maxVolume === 0) {
        setProfileBars([]);
        return;
      }
      const maxWidth = Math.min(120, container.clientWidth * 0.14);
      const rightEdge = container.clientWidth - 72;
      setProfileBars(profile.bins.flatMap((bin) => {
        const top = candleSeries.priceToCoordinate(bin.high);
        const bottom = candleSeries.priceToCoordinate(bin.low);
        if (top === null || bottom === null) return [];
        const width = maxWidth * (bin.volume / maxVolume);
        return [{
          x: rightEdge - width,
          y: Math.min(top, bottom),
          width,
          height: Math.max(1, Math.abs(bottom - top)),
          inValueArea: bin.inValueArea,
        }];
      }));
    };

    if (document?.viewport.from && document.viewport.to) {
      chart.timeScale().setVisibleRange({
        from: timestamp(document.viewport.from),
        to: timestamp(document.viewport.to),
      });
    } else {
      chart.timeScale().fitContent();
    }
    chart.timeScale().subscribeVisibleTimeRangeChange(project);
    const resizeObserver = new ResizeObserver(() => {
      chart.resize(container.clientWidth, container.clientHeight);
      project();
    });
    resizeObserver.observe(container);
    requestAnimationFrame(project);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
    };
  }, [context, dark, document, drawingLayers]);

  return (
    <div
      ref={containerRef}
      className="relative h-[34rem] min-h-[28rem] overflow-hidden rounded-md bg-card"
      data-analysis-ready="true"
      data-candle-hash={context.data.snapshotHash}
      data-annotation-count={drawingLayers.length}
      data-viewport-from={document?.viewport.from ?? context.data.range.startTime}
      data-viewport-to={document?.viewport.to ?? context.data.range.endTime}
      data-price-scale={document?.viewport.priceScale ?? "auto"}
    >
      <DrawingOverlay drawings={drawings} profileBars={profileBars} />
    </div>
  );
};
