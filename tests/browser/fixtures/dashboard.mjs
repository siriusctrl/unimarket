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
}
