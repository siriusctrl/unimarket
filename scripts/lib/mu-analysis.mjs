const selectViewportStartIndex = (candles) => {
  const earliest = Math.max(0, candles.length - 90);
  const latest = Math.max(0, candles.length - 55);
  let breakoutIndex = earliest;
  let largestMove = 0;

  for (let index = Math.max(1, earliest); index < candles.length; index += 1) {
    const move = Math.abs((candles[index].close / candles[index - 1].close) - 1);
    if (move > largestMove) {
      largestMove = move;
      breakoutIndex = index;
    }
  }

  return Math.max(earliest, Math.min(latest, breakoutIndex - 8));
};

const countSupportViolations = (candles, first, slope) =>
  candles.slice(first.index).filter((candle, offset) => {
    const support = first.candle.low + slope * offset;
    return candle.low < support * 0.98;
  }).length;

const selectRecentSupport = (candles, viewportStartIndex) => {
  const pivots = candles.flatMap((candle, index) => {
    if (index < viewportStartIndex + 2 || index >= candles.length - 2) return [];
    const neighborhood = candles.slice(index - 2, index + 3);
    return neighborhood.every((candidate) => candle.low <= candidate.low) ? [{ candle, index }] : [];
  });
  const latest = candles.at(-1);
  const candidates = pivots.flatMap((first, firstIndex) => pivots.slice(firstIndex + 1).flatMap((second) => {
    const span = second.index - first.index;
    if (span < 8 || span > 45 || second.candle.low <= first.candle.low) return [];
    const slope = (second.candle.low - first.candle.low) / span;
    const projected = second.candle.low + slope * (candles.length - 1 - second.index);
    if (projected > latest.low * 1.01 || projected < latest.close * 0.65) return [];
    const violations = countSupportViolations(candles, first, slope);
    const distance = (latest.close - projected) / latest.close;
    const age = candles.length - 1 - second.index;
    const score = violations * 100 + distance * 20 + age * 0.04 + Math.abs(span - 22) * 0.03;
    return [{ first, second, slope, projected, violations, score }];
  }));
  if (candidates.length > 0) return candidates.sort((left, right) => left.score - right.score)[0];

  const focused = candles.slice(viewportStartIndex);
  const midpoint = Math.floor(focused.length / 2);
  const lowest = (rows, offset) => rows.reduce((best, candle, index) =>
    candle.low < best.candle.low ? { candle, index: offset + index } : best,
  { candle: rows[0], index: offset });
  const first = lowest(focused.slice(0, midpoint), viewportStartIndex);
  const second = lowest(focused.slice(midpoint), viewportStartIndex + midpoint);
  const slope = (second.candle.low - first.candle.low) / (second.index - first.index);
  const projected = second.candle.low + slope * (candles.length - 1 - second.index);
  return { first, second, slope, projected, violations: countSupportViolations(candles, first, slope) };
};

const quantile = (values, percentile) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))];
};

export const buildMuAnalysis = (context, runId) => {
  const candles = context.data.candles;
  if (candles.length < 40) throw new Error(`MU live history returned only ${candles.length} candles`);

  const viewportStartIndex = selectViewportStartIndex(candles);
  const viewportCandles = candles.slice(viewportStartIndex);
  const support = selectRecentSupport(candles, viewportStartIndex);
  const recent = candles.slice(-35);
  const supplyHigh = Math.max(...recent.map((candle) => candle.high));
  const supplyLow = quantile(recent.map((candle) => candle.high), 0.82);
  const supplyStart = recent.find((candle) => candle.high >= supplyLow) ?? recent[0];
  const invalidation = support.projected * 0.98;

  if (support.slope <= 0 || support.projected > candles.at(-1).low * 1.01 || support.violations > 1) {
    throw new Error("MU live data did not produce a valid, unbroken rising support candidate in the focused window");
  }

  return {
    document: {
      schema: "unimarket.chart-analysis/v1",
      title: "MU live daily structure",
      instrument: { market: "hyperliquid", reference: "xyz:MU", displayName: "MU perpetual on XYZ" },
      data: {
        interval: context.data.interval,
        from: context.data.range.startTime,
        to: context.data.range.endTime,
        asOf: context.data.range.asOf,
        snapshotHash: context.data.snapshotHash,
      },
      viewport: {
        from: viewportCandles[0].timestamp,
        to: context.data.range.endTime,
        priceScale: "auto",
      },
      thesis: "The focused post-breakout window shows a recent sequence of higher pivot lows below an overhead supply zone; the full one-year history remains available as context but does not define the active trend slope.",
      invalidation: `A daily close below ${invalidation.toFixed(2)} invalidates the focused rising-support candidate.`,
      layers: [
        {
          id: "live-rising-support",
          type: "trendLine",
          anchors: [
            { time: support.first.candle.timestamp, price: support.first.candle.low },
            { time: support.second.candle.timestamp, price: support.second.candle.low },
          ],
          extend: { left: false, right: true },
          label: "Recent pivot support",
          rationale: `Connects two higher local lows inside the focused ${viewportCandles.length}-session regime; projected support remains below the latest candle.`,
          confidence: 0.74,
          style: { color: "support", width: 2, lineStyle: "solid", opacity: 0.92 },
        },
        {
          id: "live-supply-zone",
          type: "rectangle",
          anchors: [
            { time: supplyStart.timestamp, price: supplyLow },
            { time: context.data.range.endTime, price: supplyHigh },
          ],
          fillOpacity: 0.08,
          label: "Recent supply",
          labelPlacement: { at: "middle", offsetX: -30, offsetY: -6 },
          rationale: "Marks the upper distribution of highs from the latest thirty-five sessions instead of forcing a parallel channel through an explosive repricing.",
          confidence: 0.7,
          style: { color: "resistance", width: 1, lineStyle: "solid", opacity: 0.72 },
        },
        {
          id: "live-invalidation",
          type: "horizontalLine",
          price: invalidation,
          label: "Structure invalidation",
          rationale: "Places invalidation just below the projected recent support rather than below an unrelated annual low.",
          confidence: 0.76,
          style: { color: "warning", width: 1, lineStyle: "dotted", opacity: 0.8 },
        },
        { id: "sma-20", type: "sma", period: 20 },
        { id: "ema-50", type: "ema", period: 50 },
        { id: "rsi-14", type: "rsi", period: 14 },
        {
          id: "volume-profile",
          type: "volumeProfile",
          from: viewportCandles[0].timestamp,
          to: context.data.range.endTime,
          bins: 48,
          valueAreaPercent: 70,
          method: "ohlcv-range-approximation",
        },
      ],
      metadata: {
        createdBy: { kind: "system", actorId: "mu-live-verifier" },
        runId,
        createdAt: new Date().toISOString(),
      },
    },
    viewportCandles,
    support,
  };
};
