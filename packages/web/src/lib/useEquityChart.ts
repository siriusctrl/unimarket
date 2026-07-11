import { useMemo, useState } from "react";

import { chartPalette } from "./dashboard";
import type { EquityHistoryResponse, OverviewResponse } from "./dashboard-api";
import { buildChartRows, calculateChartDomain, mergeEquitySeries, type ChartMode } from "./equity-chart";

export const useEquityChart = (
  overview: OverviewResponse | null,
  history: EquityHistoryResponse | null,
) => {
  const [mode, setMode] = useState<ChartMode>("equity");
  const [selectionOverride, setSelectionOverride] = useState<Set<string> | null>(null);
  const series = useMemo(() => mergeEquitySeries(overview, history), [history, overview]);
  const agentNames = useMemo(() => series.map((agent) => agent.userName), [series]);
  const selectedAgents = useMemo(
    () => selectionOverride ?? new Set(overview?.agents.slice(0, 5).map((agent) => agent.userName) ?? []),
    [overview, selectionOverride],
  );
  const colors = useMemo(
    () => Object.fromEntries(agentNames.map((name, index) => [name, chartPalette[index % chartPalette.length]])),
    [agentNames],
  );
  const rows = useMemo(() => buildChartRows(series, mode), [mode, series]);
  const domain = useMemo(() => calculateChartDomain(rows, selectedAgents), [rows, selectedAgents]);

  const toggleAgent = (name: string) => {
    setSelectionOverride((currentOverride) => {
      const next = new Set(currentOverride ?? selectedAgents);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return {
    mode,
    setMode,
    rows,
    domain,
    agentNames,
    colors,
    selectedAgents,
    toggleAgent,
    selectAll: () => setSelectionOverride(new Set(overview?.agents.map((agent) => agent.userName) ?? [])),
    clearSelection: () => setSelectionOverride(new Set()),
  };
};
