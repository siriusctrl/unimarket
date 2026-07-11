import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChartContext, StoredChartAnalysis } from "@unimarket/analysis";

import { createAnalysisApiClient } from "./analysis-api";

export const useAnalysisWorkspace = ({
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
}) => {
  const client = useMemo(() => createAnalysisApiClient(), []);
  const [context, setContext] = useState<ChartContext | null>(null);
  const [documents, setDocuments] = useState<StoredChartAnalysis[]>([]);
  const [selectedDocument, setSelectedDocument] = useState<StoredChartAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    setLoading(true);
    setError(null);
    setContext(null);
    setDocuments([]);
    setSelectedDocument(null);
    try {
      const listed = await client.listDocuments({ market, reference, interval });
      let selected = documentId
        ? listed.documents.find((document) => document.id === documentId)
        : listed.documents.find((document) => document.status === "published") ?? listed.documents[0];
      if (documentId && !selected) selected = await client.getDocument(documentId);
      if (selected && (
        selected.document.instrument.market !== market || selected.document.instrument.reference !== reference
      )) {
        throw new Error("Requested analysis document does not match this instrument");
      }
      const nextDocuments = selected && !listed.documents.some((document) => document.id === selected.id)
        ? [selected, ...listed.documents]
        : listed.documents;
      const contextInterval = selected?.document.data.interval ?? interval;
      const nextContext = await client.getContext({
        market,
        reference,
        interval: contextInterval,
        lookback,
        documentId: selected?.id,
      });
      if (requestGeneration.current !== generation) return;
      setContext(nextContext);
      setDocuments(nextDocuments);
      setSelectedDocument(selected ?? null);
      setError(null);
    } catch (nextError) {
      if (requestGeneration.current !== generation) return;
      setError(nextError instanceof Error ? nextError.message : "Analysis workspace could not be loaded");
    } finally {
      if (requestGeneration.current === generation) setLoading(false);
    }
  }, [client, documentId, interval, lookback, market, reference]);

  useEffect(() => {
    void refresh();
    return () => {
      requestGeneration.current += 1;
    };
  }, [refresh]);

  return {
    context,
    documents,
    selectedDocument,
    loading,
    error,
    refresh,
  };
};
