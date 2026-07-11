import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartAnalysisDocument, ChartContext, DrawingLayer } from "@unimarket/analysis";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
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
            <polygon points={points} fill={stroke} fillOpacity={drawing.fillOpacity} stroke="none" />
            <polyline
              points={points}
              fill="none"
              stroke={stroke}
              strokeWidth={drawing.width}
              strokeDasharray={lineDash(drawing.lineStyle)}
              opacity={drawing.opacity}
            />
            {drawing.label ? <text x={drawing.points[0].x + 8} y={drawing.points[0].y - 8} fill={stroke} fontSize="11">{drawing.label}</text> : null}
          </g>
        );
      }
      if (drawing.type === "marker" || drawing.type === "text") {
        const point = drawing.points[0];
        return (
          <g key={drawing.id} data-drawing-id={drawing.id}>
            {drawing.type === "marker" ? <circle cx={point.x} cy={point.y} r="5" fill={stroke} /> : null}
            <text x={point.x + 8} y={point.y - 8} fill={stroke} fontSize="11">{drawing.text ?? drawing.label}</text>
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
          {drawing.label ? <text x={first.x + 8} y={first.y - 8} fill={stroke} fontSize="11">{drawing.label}</text> : null}
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
      rightPriceScale: { borderColor: dark ? "#34383e" : "#d8d5cc" },
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
      if (!document || !candleSeriesRef.current || !containerRef.current) {
        setDrawings([]);
        return;
      }
      const next = drawingLayers.flatMap((layer) => {
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
      });
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

    chart.timeScale().fitContent();
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
    >
      <DrawingOverlay drawings={drawings} profileBars={profileBars} />
    </div>
  );
};
