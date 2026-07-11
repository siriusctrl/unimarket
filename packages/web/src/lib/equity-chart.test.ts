import { describe, expect, it } from "vitest";

import type { EquityHistoryResponse, OverviewResponse } from "./dashboard-api";
import { buildChartRows, calculateChartDomain, mergeEquitySeries } from "./equity-chart";

const history: EquityHistoryResponse = {
  range: "1m",
  series: [{
    userId: "usr_1",
    userName: "Atlas",
    snapshots: [{ snapshotAt: "2026-07-01T00:00:00.000Z", equity: 100, balance: 80, marketValue: 20, unrealizedPnl: 0 }],
  }],
};

const overview = {
  generatedAt: "2026-07-02T00:00:00.000Z",
  agents: [{
    userId: "usr_1",
    userName: "Atlas",
    balance: 80,
    totals: { equity: 110, marketValue: 30, unrealizedPnl: 10 },
  }],
} as OverviewResponse;

describe("equity chart model", () => {
  it("merges the latest live valuation without duplicating historical values", () => {
    const merged = mergeEquitySeries(overview, history);
    expect(merged[0]?.snapshots).toHaveLength(2);
    expect(merged[0]?.snapshots.at(-1)?.equity).toBe(110);

    const sameValueOverview = {
      ...overview,
      agents: [{ ...overview.agents[0], totals: { equity: 100, marketValue: 20, unrealizedPnl: 0 } }],
    } as OverviewResponse;
    expect(mergeEquitySeries(sameValueOverview, history)[0]?.snapshots).toHaveLength(1);
  });

  it("builds return rows and a padded domain for selected agents", () => {
    const rows = buildChartRows(mergeEquitySeries(overview, history), "return");
    expect(rows.map((row) => row.Atlas)).toEqual([0, 10]);
    expect(calculateChartDomain(rows, new Set(["Atlas"]))).toEqual([-1.5, 11.5]);
  });
});
