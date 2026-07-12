import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartAnalysisDocument, ChartContext, DrawingLayer } from "@unimarket/analysis";
import {
  ColorType,
  PriceScaleMode,
  createChart,
  type Time,
} from "lightweight-charts";

import { chartTimestamp, populateFinancialChart } from "./chart-series";
import {
  drawingIntersectsViewport,
  projectDrawing,
  projectVolumeProfile,
  type ProfileBar,
  type ProjectedDrawing,
} from "./chart-projection";
import { DrawingOverlay } from "./drawing-overlay";

export const FinancialChart = ({
  context,
  document,
}: {
  context: ChartContext;
  document: ChartAnalysisDocument | null;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drawings, setDrawings] = useState<ProjectedDrawing[]>([]);
  const [profileBars, setProfileBars] = useState<ProfileBar[]>([]);
  const [visibleDrawingIds, setVisibleDrawingIds] = useState<string[]>([]);
  const [projectionReady, setProjectionReady] = useState(false);
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
    setProjectionReady(false);
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
    const candleSeries = populateFinancialChart(chart, context);

    const project = () => {
      const size = { width: container.clientWidth, height: container.clientHeight };
      const next = document ? drawingLayers.flatMap((layer) => {
        const projected = projectDrawing(
          layer,
          document,
          {
            time: (value) => chart.timeScale().timeToCoordinate(chartTimestamp(value) as Time),
            price: (value) => candleSeries.priceToCoordinate(value),
          },
          size,
        );
        return projected ? [projected] : [];
      }) : [];
      setDrawings(next);
      setVisibleDrawingIds(next.filter((drawing) => drawingIntersectsViewport(drawing, size)).map((drawing) => drawing.id));

      const profile = context.indicators.find((indicator) => indicator.type === "volumeProfile")?.profile;
      setProfileBars(projectVolumeProfile(profile, (price) => candleSeries.priceToCoordinate(price), size.width));
      setProjectionReady(true);
    };

    if (document?.viewport.from && document.viewport.to) {
      chart.timeScale().setVisibleRange({
        from: chartTimestamp(document.viewport.from),
        to: chartTimestamp(document.viewport.to),
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
      data-projection-ready={projectionReady ? "true" : "false"}
      data-rendered-annotation-count={drawings.length}
      data-visible-drawing-ids={JSON.stringify(visibleDrawingIds)}
      data-clipped-drawing-ids={JSON.stringify(drawings.filter((drawing) => !visibleDrawingIds.includes(drawing.id)).map((drawing) => drawing.id))}
      data-oscillator-pane-count={new Set(context.indicators.filter((indicator) => indicator.pane === "oscillator").map((indicator) => indicator.type)).size}
    >
      <DrawingOverlay drawings={drawings} profileBars={profileBars} />
    </div>
  );
};
