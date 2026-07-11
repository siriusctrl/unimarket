const generatedAt = "2026-07-11T08:00:00.000Z";

const agents = [
  {
    userId: "agent-atlas",
    userName: "Atlas Alpha",
    createdAt: "2026-05-04T09:00:00.000Z",
    accountId: "acct-atlas",
    accountName: "macro-book",
    balance: 128_420,
    positions: [
      {
        market: "polymarket",
        symbol: "fed-cuts-september-2026",
        symbolName: "Federal Reserve cuts rates by September 2026",
        side: "Yes",
        quantity: 18_500,
        avgCost: 0.54,
        currentPrice: 0.63,
        marketValue: 11_655,
        unrealizedPnl: 1_665,
        quoteTimestamp: generatedAt,
      },
      {
        market: "hyperliquid",
        symbol: "BTC",
        symbolName: "Bitcoin perpetual",
        side: "Long",
        quantity: 0.24,
        avgCost: 108_400,
        currentPrice: 112_750,
        marketValue: 27_060,
        unrealizedPnl: 1_044,
        quoteTimestamp: generatedAt,
      },
    ],
    totals: {
      positions: 2,
      marketValue: 38_715,
      knownMarketValue: 38_715,
      unrealizedPnl: 2_709,
      knownUnrealizedPnl: 2_709,
      equity: 167_135,
    },
    valuation: {
      status: "complete",
      issueCount: 0,
      pricedPositions: 2,
      unpricedPositions: 0,
      knownMarketValue: 38_715,
      knownUnrealizedPnl: 2_709,
    },
  },
  {
    userId: "agent-sable",
    userName: "Sable Quant",
    createdAt: "2026-05-18T10:30:00.000Z",
    accountId: "acct-sable",
    accountName: "relative-value",
    balance: 101_980,
    positions: [
      {
        market: "polymarket",
        symbol: "us-recession-2026",
        symbolName: "US recession begins in 2026",
        side: "No",
        quantity: 12_000,
        avgCost: 0.66,
        currentPrice: 0.71,
        marketValue: 8_520,
        unrealizedPnl: 600,
        quoteTimestamp: generatedAt,
      },
    ],
    totals: {
      positions: 1,
      marketValue: 8_520,
      knownMarketValue: 8_520,
      unrealizedPnl: 600,
      knownUnrealizedPnl: 600,
      equity: 110_500,
    },
    valuation: {
      status: "complete",
      issueCount: 0,
      pricedPositions: 1,
      unpricedPositions: 0,
      knownMarketValue: 8_520,
      knownUnrealizedPnl: 600,
    },
  },
  {
    userId: "agent-northstar",
    userName: "Northstar Event",
    createdAt: "2026-06-02T14:15:00.000Z",
    accountId: "acct-northstar",
    accountName: "event-driven",
    balance: 86_300,
    positions: [
      {
        market: "polymarket",
        symbol: "mars-launch-2026",
        symbolName: "Orbital Mars mission launches in 2026",
        side: "Yes",
        quantity: 9_000,
        avgCost: 0.42,
        currentPrice: 0.39,
        marketValue: 3_510,
        unrealizedPnl: -270,
        quoteTimestamp: generatedAt,
      },
    ],
    totals: {
      positions: 1,
      marketValue: 3_510,
      knownMarketValue: 3_510,
      unrealizedPnl: -270,
      knownUnrealizedPnl: -270,
      equity: 89_810,
    },
    valuation: {
      status: "complete",
      issueCount: 0,
      pricedPositions: 1,
      unpricedPositions: 0,
      knownMarketValue: 3_510,
      knownUnrealizedPnl: -270,
    },
  },
  {
    userId: "agent-meridian",
    userName: "Meridian Risk",
    createdAt: "2026-06-12T07:40:00.000Z",
    accountId: "acct-meridian",
    accountName: "hedged-book",
    balance: 94_700,
    positions: [],
    totals: {
      positions: 0,
      marketValue: 0,
      knownMarketValue: 0,
      unrealizedPnl: 0,
      knownUnrealizedPnl: 0,
      equity: 94_700,
    },
    valuation: {
      status: "complete",
      issueCount: 0,
      pricedPositions: 0,
      unpricedPositions: 0,
      knownMarketValue: 0,
      knownUnrealizedPnl: 0,
    },
  },
];

export const overviewFixture = {
  generatedAt,
  totals: {
    users: 4,
    positions: 4,
    balance: 411_400,
    marketValue: 50_745,
    knownMarketValue: 50_745,
    unrealizedPnl: 3_039,
    knownUnrealizedPnl: 3_039,
    equity: 462_145,
  },
  valuation: {
    status: "complete",
    completeAgents: 4,
    partialAgents: 0,
    issueCount: 0,
    pricedPositions: 4,
    unpricedPositions: 0,
  },
  markets: [
    {
      marketId: "polymarket",
      marketName: "Polymarket",
      users: 3,
      positions: 3,
      totalQuantity: 39_500,
      totalMarketValue: 23_685,
      knownMarketValue: 23_685,
      totalUnrealizedPnl: 1_995,
      knownUnrealizedPnl: 1_995,
      quotedPositions: 3,
      unpricedPositions: 0,
      valuationStatus: "complete",
    },
    {
      marketId: "hyperliquid",
      marketName: "Hyperliquid",
      users: 1,
      positions: 1,
      totalQuantity: 0.24,
      totalMarketValue: 27_060,
      knownMarketValue: 27_060,
      totalUnrealizedPnl: 1_044,
      knownUnrealizedPnl: 1_044,
      quotedPositions: 1,
      unpricedPositions: 0,
      valuationStatus: "complete",
    },
  ],
  agents,
  predictionLeaderboard: [
    {
      userId: "agent-atlas",
      userName: "Atlas Alpha",
      predictions: 42,
      settledPredictions: 31,
      avgBrier: 0.1184,
      avgEdge: 0.074,
      avgConviction: 0.71,
      avgTimeToResolutionHours: 42.5,
    },
    {
      userId: "agent-sable",
      userName: "Sable Quant",
      predictions: 37,
      settledPredictions: 29,
      avgBrier: 0.1461,
      avgEdge: 0.052,
      avgConviction: 0.64,
      avgTimeToResolutionHours: 58.2,
    },
    {
      userId: "agent-northstar",
      userName: "Northstar Event",
      predictions: 24,
      settledPredictions: 18,
      avgBrier: 0.1713,
      avgEdge: -0.012,
      avgConviction: 0.59,
      avgTimeToResolutionHours: 76.8,
    },
  ],
};

const historyPoints = [
  "2026-06-12T08:00:00.000Z",
  "2026-06-19T08:00:00.000Z",
  "2026-06-26T08:00:00.000Z",
  "2026-07-03T08:00:00.000Z",
  generatedAt,
];

const equityPaths = {
  "agent-atlas": [151_200, 154_880, 157_450, 162_900, 167_135],
  "agent-sable": [104_100, 103_700, 106_250, 108_980, 110_500],
  "agent-northstar": [92_300, 91_450, 90_820, 90_100, 89_810],
  "agent-meridian": [93_600, 94_200, 93_950, 94_300, 94_700],
};

export const equityHistoryFixture = (range = "1m") => ({
  range,
  series: agents.map((agent) => ({
    userId: agent.userId,
    userName: agent.userName,
    snapshots: historyPoints.map((snapshotAt, index) => {
      const equity = equityPaths[agent.userId][index];
      const marketValue = Math.max(0, equity - agent.balance);
      return {
        snapshotAt,
        equity,
        balance: agent.balance,
        marketValue,
        unrealizedPnl: equity - (agent.balance + marketValue * 0.94),
      };
    }),
  })),
});

export const timelineFixture = {
  events: [
    {
      type: "order",
      data: {
        id: "ord-proof-1",
        market: "polymarket",
        symbol: "fed-cuts-september-2026",
        symbolName: "Federal Reserve cuts rates by September 2026",
        side: "buy",
        quantity: 4_000,
        status: "filled",
        filledPrice: 0.61,
        filledAt: "2026-07-11T07:45:00.000Z",
      },
      reasoning: "Inflation momentum softened while the contract still priced a slower policy response.",
      createdAt: "2026-07-11T07:45:00.000Z",
    },
    {
      type: "funding.applied",
      data: {
        id: "fund-proof-1",
        market: "hyperliquid",
        symbol: "BTC",
        symbolName: "Bitcoin perpetual",
        fundingRate: -0.000012,
        payment: 3.24,
        appliedAt: "2026-07-11T04:00:00.000Z",
      },
      reasoning: "Funding receipt reduced the carry cost of the directional hedge.",
      createdAt: "2026-07-11T04:00:00.000Z",
    },
    {
      type: "journal",
      data: {
        id: "journal-proof-1",
        content: "Kept gross exposure below the weekly risk budget; next review follows the CPI release.",
        tags: ["risk-review", "macro"],
      },
      reasoning: null,
      createdAt: "2026-07-10T17:20:00.000Z",
    },
  ],
};

const muCandles = Array.from({ length: 120 }, (_, index) => {
  const timestamp = new Date(Date.UTC(2026, 2, 14 + index)).toISOString();
  const trend = 520 + index * 3.65;
  const cycle = Math.sin(index / 7) * 24 + Math.sin(index / 19) * 13;
  const open = Number((trend + cycle).toFixed(2));
  const close = Number((open + Math.sin(index * 1.7) * 11).toFixed(2));
  return {
    timestamp,
    open,
    high: Number((Math.max(open, close) + 8 + (index % 5)).toFixed(2)),
    low: Number((Math.min(open, close) - 7 - (index % 4)).toFixed(2)),
    close,
    volume: Number((4_800 + index * 51 + Math.abs(Math.sin(index / 4)) * 3_600).toFixed(3)),
  };
});

const movingAverage = (period) => muCandles.map((candle, index) => ({
  timestamp: candle.timestamp,
  values: {
    value: index + 1 < period
      ? null
      : Number((muCandles.slice(index - period + 1, index + 1).reduce((sum, row) => sum + row.close, 0) / period).toFixed(4)),
  },
}));

export const analysisContextFixture = {
  schema: "unimarket.chart-context/v1",
  instrument: { market: "hyperliquid", reference: "xyz:MU", displayName: "MU perpetual on XYZ" },
  data: {
    interval: "1d",
    range: {
      mode: "lookback",
      lookback: "1y",
      asOf: muCandles.at(-1).timestamp,
      startTime: muCandles[0].timestamp,
      endTime: muCandles.at(-1).timestamp,
    },
    snapshotHash: `sha256:${"b".repeat(64)}`,
    candles: muCandles,
    summary: {
      open: muCandles[0].open,
      close: muCandles.at(-1).close,
      change: Number((muCandles.at(-1).close - muCandles[0].open).toFixed(2)),
      changePct: Number((((muCandles.at(-1).close - muCandles[0].open) / muCandles[0].open) * 100).toFixed(2)),
      high: Math.max(...muCandles.map((candle) => candle.high)),
      low: Math.min(...muCandles.map((candle) => candle.low)),
      volume: muCandles.reduce((sum, candle) => sum + candle.volume, 0),
      candleCount: muCandles.length,
    },
  },
  indicators: [
    { id: "sma-20", type: "sma", pane: "price", points: movingAverage(20) },
    { id: "ema-50", type: "ema", pane: "price", points: movingAverage(50) },
    {
      id: "rsi-14",
      type: "rsi",
      pane: "oscillator",
      points: muCandles.map((candle, index) => ({
        timestamp: candle.timestamp,
        values: { rsi: index < 14 ? null : Number((54 + Math.sin(index / 6) * 16).toFixed(3)) },
      })),
    },
    {
      id: "volume-profile",
      type: "volumeProfile",
      pane: "volumeProfile",
      points: [],
      profile: {
        method: "ohlcv-range-approximation",
        sourceGranularity: "1d",
        pointOfControl: 742.5,
        valueAreaLow: 665,
        valueAreaHigh: 852,
        bins: Array.from({ length: 24 }, (_, index) => ({
          low: 480 + index * 24,
          high: 504 + index * 24,
          volume: 10_000 + Math.sin(index / 3) * 4_000 + index * 350,
          inValueArea: index >= 6 && index <= 17,
        })),
      },
    },
  ],
  dataQuality: { candleCount: muCandles.length, missingIntervals: 0, volumeAvailable: true, source: "market-adapter" },
  drawingCapabilities: ["horizontalLine", "verticalLine", "trendLine", "ray", "channel", "rectangle", "marker", "text"],
};

const analysisDocument = {
  schema: "unimarket.chart-analysis/v1",
  title: "MU daily trend structure",
  instrument: { market: "hyperliquid", reference: "xyz:MU", displayName: "MU perpetual on XYZ" },
  data: {
    interval: "1d",
    from: muCandles[0].timestamp,
    to: muCandles.at(-1).timestamp,
    asOf: muCandles.at(-1).timestamp,
    snapshotHash: analysisContextFixture.data.snapshotHash,
  },
  viewport: {
    from: muCandles[45].timestamp,
    to: muCandles.at(-1).timestamp,
    priceScale: "auto",
  },
  thesis: "MU remains inside an ascending daily channel while repeated closes hold above the medium-term support slope.",
  invalidation: "A daily close below 795 and outside the lower channel boundary invalidates the constructive structure.",
  layers: [
    {
      id: "primary-support",
      type: "trendLine",
      anchors: [
        { time: muCandles[52].timestamp, price: muCandles[52].low },
        { time: muCandles[78].timestamp, price: muCandles[78].low },
      ],
      extend: { left: false, right: true },
      label: "Rising support",
      labelPlacement: { at: "start", offsetX: 8, offsetY: -8 },
      rationale: "Connects two reaction lows inside the focused post-breakout window.",
      confidence: 0.78,
      visible: true,
      style: { color: "support", width: 2, lineStyle: "solid", opacity: 0.92 },
    },
    {
      id: "ascending-channel",
      type: "channel",
      base: [
        { time: muCandles[52].timestamp, price: muCandles[52].low },
        { time: muCandles[82].timestamp, price: muCandles[82].low },
      ],
      parallelAnchor: { time: muCandles[58].timestamp, price: muCandles[58].high + 54 },
      fillOpacity: 0.06,
      label: "Daily channel",
      labelPlacement: { at: "middle", offsetX: -24, offsetY: -10 },
      rationale: "Local parallel envelope describes the focused regime without extrapolating across the full history.",
      confidence: 0.69,
      visible: true,
      style: { color: "accent", width: 1, lineStyle: "dashed", opacity: 0.74 },
    },
    {
      id: "resistance-980",
      type: "horizontalLine",
      price: 980,
      label: "980 resistance",
      labelPlacement: { at: "start", offsetX: 8, offsetY: -8 },
      rationale: "Recent expansion stalled below this round-number supply area.",
      confidence: 0.65,
      visible: true,
      style: { color: "resistance", width: 2, lineStyle: "dotted", opacity: 0.86 },
    },
    {
      id: "earnings-window",
      type: "verticalLine",
      time: muCandles[101].timestamp,
      label: "Catalyst window",
      labelPlacement: { at: "end", offsetX: 8, offsetY: -18 },
      rationale: "Separates the latest volatility regime from the prior trend segment.",
      confidence: 0.58,
      visible: true,
      style: { color: "muted", width: 1, lineStyle: "dashed", opacity: 0.7 },
    },
    { id: "sma-20", type: "sma", period: 20, visible: true },
    { id: "ema-50", type: "ema", period: 50, visible: true },
    { id: "rsi-14", type: "rsi", period: 14, visible: true },
  ],
  metadata: {
    createdBy: { kind: "agent", actorId: "agent-atlas" },
    runId: "fixture-mu-structure-v1",
    createdAt: muCandles.at(-1).timestamp,
  },
};

export const analysisDocumentsFixture = {
  documents: [{
    id: "ana-mu-draft",
    supersedesId: "ana-mu-proof",
    version: 2,
    status: "draft",
    document: {
      ...analysisDocument,
      title: "MU supply revision",
      thesis: "Draft revision isolates the current supply boundary before publication.",
      layers: [
        analysisDocument.layers[2],
        {
          id: "draft-rejection",
          type: "marker",
          point: { time: muCandles[108].timestamp, price: muCandles[108].high },
          shape: "arrowDown",
          label: "Rejection",
          rationale: "Marks the latest rejected push into the draft supply level.",
          visible: true,
          style: { color: "resistance", width: 2, lineStyle: "solid", opacity: 0.9 },
          labelPlacement: { at: "start", offsetX: 9, offsetY: -10 },
        },
        {
          id: "draft-offscreen",
          type: "horizontalLine",
          price: 1_000_000,
          label: "Offscreen scenario",
          rationale: "Exercises clipped-layer metadata without treating DOM presence as visual success.",
          visible: true,
          style: { color: "warning", width: 1, lineStyle: "dotted", opacity: 0.8 },
          labelPlacement: { at: "start", offsetX: 8, offsetY: -8 },
        },
      ],
      metadata: { ...analysisDocument.metadata, runId: "fixture-mu-draft-v2" },
    },
    createdBy: "agent-atlas",
    reasoning: "Draft awaits browser review.",
    createdAt: muCandles.at(-1).timestamp,
    updatedAt: muCandles.at(-1).timestamp,
    publishedAt: null,
  }, {
    id: "ana-mu-proof",
    supersedesId: null,
    version: 1,
    status: "published",
    document: analysisDocument,
    createdBy: "agent-atlas",
    reasoning: "Visual verification confirmed the channel and support projection.",
    createdAt: muCandles.at(-1).timestamp,
    updatedAt: muCandles.at(-1).timestamp,
    publishedAt: muCandles.at(-1).timestamp,
  }],
};

export async function mockDashboardApi(page, calls = []) {
  await page.route("**/api/dashboard/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(`${url.pathname}${url.search}`);

    if (url.pathname === "/api/dashboard/overview") {
      await route.fulfill({ json: overviewFixture });
      return;
    }

    if (url.pathname === "/api/dashboard/equity-history") {
      await route.fulfill({ json: equityHistoryFixture(url.searchParams.get("range") ?? "1m") });
      return;
    }

    if (/^\/api\/dashboard\/users\/[^/]+\/timeline$/.test(url.pathname)) {
      await route.fulfill({ json: timelineFixture });
      return;
    }

    await route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: `No browser fixture for ${url.pathname}` } },
    });
  });

  await page.route("**/api/analysis/**", async (route) => {
    const url = new URL(route.request().url());
    calls.push(`${url.pathname}${url.search}`);

    if (url.pathname === "/api/analysis/context") {
      await route.fulfill({ json: analysisContextFixture });
      return;
    }
    if (url.pathname === "/api/analysis/documents") {
      await route.fulfill({ json: analysisDocumentsFixture });
      return;
    }
    const documentMatch = url.pathname.match(/^\/api\/analysis\/documents\/([^/]+)$/);
    if (documentMatch) {
      const document = analysisDocumentsFixture.documents.find((candidate) => candidate.id === documentMatch[1]);
      await route.fulfill(document
        ? { json: document }
        : { status: 404, json: { error: { code: "ANALYSIS_NOT_FOUND", message: "Analysis not found" } } });
      return;
    }

    await route.fulfill({
      status: 404,
      json: { error: { code: "NOT_FOUND", message: `No analysis fixture for ${url.pathname}` } },
    });
  });
}
