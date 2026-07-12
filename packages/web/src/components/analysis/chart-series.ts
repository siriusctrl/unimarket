import type { ChartContext } from "@unimarket/analysis";
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";

const SERIES_COLORS = ["#69b892", "#d7b86b", "#c37c93", "#73a3b8", "#ad8fd0"];

export const chartTimestamp = (value: string): UTCTimestamp =>
  Math.floor(Date.parse(value) / 1_000) as UTCTimestamp;

export const populateFinancialChart = (
  chart: IChartApi,
  context: ChartContext,
): ISeriesApi<"Candlestick"> => {
  const candleSeries = chart.addSeries(CandlestickSeries, {
    upColor: "#69b892",
    downColor: "#d47c68",
    borderVisible: false,
    wickUpColor: "#69b892",
    wickDownColor: "#d47c68",
    priceLineVisible: true,
  });
  candleSeries.setData(context.data.candles.map((candle) => ({
    time: chartTimestamp(candle.timestamp),
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
    time: chartTimestamp(candle.timestamp),
    value: candle.volume,
    color: candle.close >= candle.open ? "rgba(105,184,146,0.32)" : "rgba(212,124,104,0.3)",
  })));

  let colorIndex = 0;
  const oscillatorPanes = new Map<string, number>();
  context.indicators.filter((indicator) => indicator.pane !== "volumeProfile").forEach((indicator) => {
    let paneIndex = 0;
    if (indicator.pane === "oscillator") {
      paneIndex = oscillatorPanes.get(indicator.type) ?? oscillatorPanes.size + 1;
      oscillatorPanes.set(indicator.type, paneIndex);
    }
    const populatedPoint = indicator.points.find((point) => Object.values(point.values).some((value) => value !== null));
    Object.keys(populatedPoint?.values ?? {}).forEach((key) => {
      const series = chart.addSeries(LineSeries, {
        color: SERIES_COLORS[colorIndex % SERIES_COLORS.length],
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
      }, paneIndex);
      colorIndex += 1;
      series.setData(indicator.points.flatMap((point) => {
        const value = point.values[key];
        return value === null ? [] : [{ time: chartTimestamp(point.timestamp), value }];
      }));
    });
  });

  return candleSeries;
};
