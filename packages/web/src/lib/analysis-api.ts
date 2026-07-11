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
  }) => requestJson<ChartContext>(
    `/api/analysis/context?market=${encodeURIComponent(market)}&reference=${encodeURIComponent(reference)}&interval=${encodeURIComponent(interval)}&lookback=${encodeURIComponent(lookback)}${documentId ? `&documentId=${encodeURIComponent(documentId)}` : ""}`,
  ),
  listDocuments: ({ market, reference, interval }: { market: string; reference: string; interval: string }) =>
    requestJson<{ documents: StoredChartAnalysis[] }>(
      `/api/analysis/documents?market=${encodeURIComponent(market)}&reference=${encodeURIComponent(reference)}&interval=${encodeURIComponent(interval)}&limit=20`,
    ),
  getDocument: (id: string) => requestJson<StoredChartAnalysis>(
    `/api/analysis/documents/${encodeURIComponent(id)}`,
  ),
});

export type AnalysisApiClient = ReturnType<typeof createAnalysisApiClient>;
