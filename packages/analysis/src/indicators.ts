import type { AnalysisCandle, IndicatorLayer } from "./schema.js";

export type IndicatorPoint = {
  timestamp: string;
  values: Record<string, number | null>;
};

export type VolumeProfileBin = {
  low: number;
  high: number;
  volume: number;
  inValueArea: boolean;
};

export type ComputedIndicator = {
  id: string;
  type: IndicatorLayer["type"];
  pane: "price" | "oscillator" | "volumeProfile";
  points: IndicatorPoint[];
  profile?: {
    method: "ohlcv-range-approximation";
    sourceGranularity: string;
    pointOfControl: number | null;
    valueAreaLow: number | null;
    valueAreaHigh: number | null;
    bins: VolumeProfileBin[];
  };
};

const round = (value: number): number => Number(value.toFixed(8));

const simpleMovingAverage = (values: number[], period: number): Array<number | null> => {
  const output: Array<number | null> = [];
  let sum = 0;
  values.forEach((value, index) => {
    sum += value;
    if (index >= period) sum -= values[index - period];
    output.push(index + 1 < period ? null : round(sum / period));
  });
  return output;
};

const exponentialMovingAverage = (values: number[], period: number): Array<number | null> => {
  if (values.length === 0) return [];
  const seed = simpleMovingAverage(values, period);
  const output: Array<number | null> = Array(values.length).fill(null);
  const seedIndex = period - 1;
  const seedValue = seed[seedIndex];
  if (seedValue === null || seedValue === undefined) return output;
  output[seedIndex] = seedValue;
  const multiplier = 2 / (period + 1);
  for (let index = seedIndex + 1; index < values.length; index += 1) {
    output[index] = round((values[index] - output[index - 1]!) * multiplier + output[index - 1]!);
  }
  return output;
};

const exponentialMovingAverageFromAvailable = (
  values: Array<number | null>,
  period: number,
): Array<number | null> => {
  const firstValueIndex = values.findIndex((value) => value !== null);
  const output: Array<number | null> = Array(values.length).fill(null);
  if (firstValueIndex === -1) return output;

  const available = values.slice(firstValueIndex);
  if (available.some((value) => value === null)) {
    throw new Error("EMA input must be contiguous after its first available value");
  }
  exponentialMovingAverage(available as number[], period).forEach((value, index) => {
    output[firstValueIndex + index] = value;
  });
  return output;
};

const relativeStrengthIndex = (values: number[], period: number): Array<number | null> => {
  const output: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return output;

  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1];
    gain += Math.max(delta, 0);
    loss += Math.max(-delta, 0);
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;
  const calculate = () => {
    if (averageGain === 0 && averageLoss === 0) return 50;
    if (averageLoss === 0) return 100;
    return 100 - (100 / (1 + averageGain / averageLoss));
  };
  output[period] = round(calculate());

  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    averageGain = ((averageGain * (period - 1)) + Math.max(delta, 0)) / period;
    averageLoss = ((averageLoss * (period - 1)) + Math.max(-delta, 0)) / period;
    output[index] = round(calculate());
  }
  return output;
};

const trueRanges = (candles: AnalysisCandle[]): number[] => candles.map((candle, index) => {
  const previousClose = candles[index - 1]?.close ?? candle.close;
  return Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose),
  );
});

const averageTrueRange = (candles: AnalysisCandle[], period: number): Array<number | null> => {
  const ranges = trueRanges(candles);
  const output: Array<number | null> = Array(ranges.length).fill(null);
  if (ranges.length < period) return output;
  let value = ranges.slice(0, period).reduce((sum, range) => sum + range, 0) / period;
  output[period - 1] = round(value);
  for (let index = period; index < ranges.length; index += 1) {
    value = ((value * (period - 1)) + ranges[index]) / period;
    output[index] = round(value);
  }
  return output;
};

const toPoints = (
  candles: AnalysisCandle[],
  values: Array<Record<string, number | null>>,
): IndicatorPoint[] => candles.map((candle, index) => ({ timestamp: candle.timestamp, values: values[index] }));

const calculateVolumeProfile = (
  candles: AnalysisCandle[],
  layer: Extract<IndicatorLayer, { type: "volumeProfile" }>,
  interval: string,
): ComputedIndicator => {
  const from = Date.parse(layer.from);
  const to = Date.parse(layer.to);
  const selected = candles.filter((candle) => {
    const time = Date.parse(candle.timestamp);
    return time >= from && time <= to;
  });
  if (selected.length === 0) {
    return {
      id: layer.id,
      type: layer.type,
      pane: "volumeProfile",
      points: [],
      profile: {
        method: "ohlcv-range-approximation",
        sourceGranularity: interval,
        pointOfControl: null,
        valueAreaLow: null,
        valueAreaHigh: null,
        bins: [],
      },
    };
  }

  const min = Math.min(...selected.map((candle) => candle.low));
  const max = Math.max(...selected.map((candle) => candle.high));
  const totalSelectedVolume = selected.reduce((sum, candle) => sum + candle.volume, 0);
  if (max === min) {
    const hasVolume = totalSelectedVolume > 0;
    return {
      id: layer.id,
      type: layer.type,
      pane: "volumeProfile",
      points: [],
      profile: {
        method: "ohlcv-range-approximation",
        sourceGranularity: interval,
        pointOfControl: hasVolume ? min : null,
        valueAreaLow: hasVolume ? min : null,
        valueAreaHigh: hasVolume ? min : null,
        bins: [{ low: min, high: min, volume: round(totalSelectedVolume), inValueArea: hasVolume }],
      },
    };
  }
  const binSize = (max - min) / layer.bins;
  const volumes = Array(layer.bins).fill(0) as number[];

  selected.forEach((candle) => {
    const lowIndex = Math.max(0, Math.min(layer.bins - 1, Math.floor((candle.low - min) / binSize)));
    const highIndex = Math.max(lowIndex, Math.min(layer.bins - 1, Math.floor((candle.high - min) / binSize)));
    const sharedVolume = candle.volume / (highIndex - lowIndex + 1);
    for (let index = lowIndex; index <= highIndex; index += 1) volumes[index] += sharedVolume;
  });

  const totalVolume = volumes.reduce((sum, volume) => sum + volume, 0);
  if (totalVolume === 0) {
    return {
      id: layer.id,
      type: layer.type,
      pane: "volumeProfile",
      points: [],
      profile: {
        method: "ohlcv-range-approximation",
        sourceGranularity: interval,
        pointOfControl: null,
        valueAreaLow: null,
        valueAreaHigh: null,
        bins: volumes.map((volume, index) => ({
          low: round(min + index * binSize),
          high: round(min + (index + 1) * binSize),
          volume,
          inValueArea: false,
        })),
      },
    };
  }
  const targetVolume = totalVolume * (layer.valueAreaPercent / 100);
  const pointOfControlIndex = volumes.reduce((best, volume, index) => volume > volumes[best] ? index : best, 0);
  const selectedBins = new Set([pointOfControlIndex]);
  let selectedVolume = volumes[pointOfControlIndex];
  let left = pointOfControlIndex - 1;
  let right = pointOfControlIndex + 1;
  while (selectedVolume < targetVolume && (left >= 0 || right < volumes.length)) {
    const leftVolume = left >= 0 ? volumes[left] : -1;
    const rightVolume = right < volumes.length ? volumes[right] : -1;
    if (rightVolume > leftVolume) {
      selectedBins.add(right);
      selectedVolume += rightVolume;
      right += 1;
    } else {
      selectedBins.add(left);
      selectedVolume += leftVolume;
      left -= 1;
    }
  }

  const bins = volumes.map((volume, index) => ({
    low: round(min + index * binSize),
    high: round(min + (index + 1) * binSize),
    volume: round(volume),
    inValueArea: selectedBins.has(index),
  }));
  const valueAreaIndices = [...selectedBins].sort((a, b) => a - b);

  return {
    id: layer.id,
    type: layer.type,
    pane: "volumeProfile",
    points: [],
    profile: {
      method: "ohlcv-range-approximation",
      sourceGranularity: interval,
      pointOfControl: round((bins[pointOfControlIndex].low + bins[pointOfControlIndex].high) / 2),
      valueAreaLow: bins[valueAreaIndices[0]].low,
      valueAreaHigh: bins[valueAreaIndices.at(-1)!].high,
      bins,
    },
  };
};

export const computeIndicator = (
  candles: AnalysisCandle[],
  layer: IndicatorLayer,
  interval: string,
): ComputedIndicator => {
  const closes = candles.map((candle) => candle.close);
  if (layer.type === "volumeProfile") return calculateVolumeProfile(candles, layer, interval);

  if (layer.type === "sma" || layer.type === "ema") {
    const values = layer.type === "sma"
      ? simpleMovingAverage(closes, layer.period)
      : exponentialMovingAverage(closes, layer.period);
    return {
      id: layer.id,
      type: layer.type,
      pane: "price",
      points: toPoints(candles, values.map((value) => ({ value }))),
    };
  }

  if (layer.type === "rsi") {
    const values = relativeStrengthIndex(closes, layer.period);
    return {
      id: layer.id,
      type: layer.type,
      pane: "oscillator",
      points: toPoints(candles, values.map((value) => ({ rsi: value }))),
    };
  }

  if (layer.type === "atr") {
    const values = averageTrueRange(candles, layer.period);
    return {
      id: layer.id,
      type: layer.type,
      pane: "oscillator",
      points: toPoints(candles, values.map((value) => ({ atr: value }))),
    };
  }

  if (layer.type === "bollingerBands") {
    const middle = simpleMovingAverage(closes, layer.period);
    const values = closes.map((_, index) => {
      if (index + 1 < layer.period || middle[index] === null) return { lower: null, middle: null, upper: null };
      const window = closes.slice(index - layer.period + 1, index + 1);
      const variance = window.reduce((sum, value) => sum + ((value - middle[index]!) ** 2), 0) / layer.period;
      const offset = Math.sqrt(variance) * layer.standardDeviations;
      return { lower: round(middle[index]! - offset), middle: middle[index], upper: round(middle[index]! + offset) };
    });
    return { id: layer.id, type: layer.type, pane: "price", points: toPoints(candles, values) };
  }

  const fast = exponentialMovingAverage(closes, layer.fastPeriod);
  const slow = exponentialMovingAverage(closes, layer.slowPeriod);
  const macd = closes.map((_, index) => fast[index] === null || slow[index] === null ? null : round(fast[index]! - slow[index]!));
  const signal = exponentialMovingAverageFromAvailable(macd, layer.signalPeriod);
  const values = macd.map((value, index) => ({
    histogram: value === null || signal[index] === null ? null : round(value - signal[index]!),
    macd: value,
    signal: signal[index],
  }));
  return { id: layer.id, type: layer.type, pane: "oscillator", points: toPoints(candles, values) };
};

export const computeIndicators = (
  candles: AnalysisCandle[],
  layers: IndicatorLayer[],
  interval: string,
): ComputedIndicator[] => layers.filter((layer) => layer.visible).map((layer) => computeIndicator(candles, layer, interval));
