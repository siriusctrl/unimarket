import type { ChartContext, StoredChartAnalysis } from "@unimarket/analysis";

import { requestJson } from "./dashboard-api";

export const createAnalysisApiClient = () => ({
  getContext: ({
    market,
    reference,
    interval,
    lookback,
    documentId,
  }: {
    market: string;
    reference: string;
    interval: string;
    lookback: string;
    documentId?: string;
  }, signal?: AbortSignal) => requestJson<ChartContext>(
    `/api/analysis/context?market=${encodeURIComponent(market)}&reference=${encodeURIComponent(reference)}&interval=${encodeURIComponent(interval)}&lookback=${encodeURIComponent(lookback)}${documentId ? `&documentId=${encodeURIComponent(documentId)}` : ""}`,
    { init: { signal } },
  ),
  listDocuments: ({ market, reference, interval }: { market: string; reference: string; interval: string }, signal?: AbortSignal) =>
    requestJson<{ documents: StoredChartAnalysis[] }>(
      `/api/analysis/documents?market=${encodeURIComponent(market)}&reference=${encodeURIComponent(reference)}&interval=${encodeURIComponent(interval)}&limit=20`,
      { init: { signal } },
    ),
  getDocument: (id: string, signal?: AbortSignal) => requestJson<StoredChartAnalysis>(
    `/api/analysis/documents/${encodeURIComponent(id)}`,
    { init: { signal } },
  ),
});

export type AnalysisApiClient = ReturnType<typeof createAnalysisApiClient>;
