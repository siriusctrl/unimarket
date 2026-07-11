import { useEffect, useMemo, useState } from "react";
import { Activity, CircleAlert, Database, FileJson2, RefreshCw, ScanLine } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { FinancialChart } from "../components/analysis/FinancialChart";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { formatCompactNumber } from "../lib/dashboard";
import { useAnalysisWorkspace } from "../lib/useAnalysisWorkspace";

const RANGE_OPTIONS = ["7d", "30d", "90d", "1y", "5y"] as const;
const INTERVAL_OPTIONS = ["1h", "4h", "1d", "1w", "1mo"] as const;
const DEFAULT_RANGE: Record<string, string> = { "1h": "7d", "4h": "30d", "1d": "1y", "1w": "5y", "1mo": "5y" };
const VALID_RANGES: Record<string, readonly string[]> = {
  "1h": ["7d", "30d"],
  "4h": ["7d", "30d", "90d"],
  "1d": RANGE_OPTIONS,
  "1w": ["30d", "90d", "1y", "5y"],
  "1mo": ["90d", "1y", "5y"],
};

const formatPrice = (value: number | null) => value === null
  ? "—"
  : value.toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 2 : 4 });

const formatViewportDate = (value: string) => new Date(value).toLocaleDateString("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export const AnalysisPage = () => {
  const params = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const market = params.market ?? "hyperliquid";
  const reference = params.reference ?? "xyz:MU";
  const documentId = searchParams.get("documentId")?.trim() || undefined;
  const [marketInput, setMarketInput] = useState(market);
  const [referenceInput, setReferenceInput] = useState(reference);
  const [interval, setInterval] = useState("1d");
  const [lookback, setLookback] = useState("1y");
  const { context, selectedDocument, documents, loading, error, refresh } = useAnalysisWorkspace({
    market,
    reference,
    interval,
    lookback,
    documentId,
  });

  useEffect(() => {
    setMarketInput(market);
    setReferenceInput(reference);
  }, [market, reference]);

  useEffect(() => {
    const documentInterval = selectedDocument?.document.data.interval;
    if (documentId && documentInterval && documentInterval !== interval) {
      setInterval(documentInterval);
      setLookback(DEFAULT_RANGE[documentInterval]);
    }
  }, [documentId, interval, selectedDocument]);

  const drawingCount = useMemo(
    () => selectedDocument?.document.layers.filter((layer) => "rationale" in layer).length ?? 0,
    [selectedDocument],
  );

  const openInstrument = () => {
    const nextMarket = marketInput.trim();
    const nextReference = referenceInput.trim();
    if (!nextMarket || !nextReference) return;
    navigate(`/analysis/${encodeURIComponent(nextMarket)}/${encodeURIComponent(nextReference)}`);
  };

  const chooseInterval = (nextInterval: string) => {
    setInterval(nextInterval);
    setLookback(DEFAULT_RANGE[nextInterval]);
  };

  return (
    <div className="space-y-5">
      <header className="grid gap-5 border-b border-border/70 pb-5 xl:grid-cols-[1fr_auto] xl:items-end">
        <div className="max-w-3xl space-y-2">
          <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-primary">
            <ScanLine className="h-4 w-4" /> Analysis workspace
          </p>
          <h1 className="text-3xl font-bold tracking-[-0.035em] sm:text-4xl">Market structure, stored as data</h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Model-neutral candles, deterministic indicators, and time-price drawings rendered from versioned JSON.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-[9rem_13rem_auto]">
          <Input value={marketInput} onChange={(event) => setMarketInput(event.target.value)} aria-label="Market adapter" />
          <Input value={referenceInput} onChange={(event) => setReferenceInput(event.target.value)} aria-label="Ticker or reference" />
          <Button onClick={openInstrument}>Open market</Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-mono text-xs text-muted-foreground">{market}</p>
          <h2 className="text-2xl font-semibold tracking-tight">{reference}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="mr-2 text-xs font-medium text-primary underline-offset-4 hover:underline"
            onClick={() => navigate("/analysis/hyperliquid/xyz%3AMU")}
          >
            Load MU example
          </button>
          <div className="flex rounded-md border border-border/70 p-0.5" aria-label="Candle interval">
            {INTERVAL_OPTIONS.map((option) => (
              <Button key={option} variant={interval === option ? "default" : "ghost"} size="sm" className="h-7 px-2.5 text-xs" onClick={() => chooseInterval(option)}>
                {option}
              </Button>
            ))}
          </div>
          <div className="flex rounded-md border border-border/70 p-0.5" aria-label="History range">
            {RANGE_OPTIONS.map((option) => (
              <Button
                key={option}
                variant={lookback === option ? "default" : "ghost"}
                size="sm"
                className="h-7 px-2.5 text-xs"
                onClick={() => setLookback(option)}
                disabled={!VALID_RANGES[interval].includes(option)}
              >
                {option}
              </Button>
            ))}
          </div>
          <Button variant="outline" size="icon" onClick={() => void refresh()} disabled={loading} aria-label="Refresh analysis">
            <RefreshCw className={loading ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          </Button>
        </div>
      </div>

      {error ? (
        <p className="flex items-center gap-2 border-l-2 border-destructive px-4 py-2 text-sm text-destructive">
          <CircleAlert className="h-4 w-4" /> {error}
        </p>
      ) : null}

      {context ? (
        <>
          <dl className="grid border-y border-border/70 sm:grid-cols-2 xl:grid-cols-5">
            {[
              ["Last", formatPrice(context.data.summary.close)],
              ["Range high", formatPrice(context.data.summary.high)],
              ["Range low", formatPrice(context.data.summary.low)],
              ["Volume", formatCompactNumber(context.data.summary.volume ?? 0)],
              ["Candles", String(context.dataQuality.candleCount)],
            ].map(([label, value], index) => (
              <div key={label} className={`px-4 py-3 ${index > 0 ? "border-t border-border/60 sm:border-l sm:border-t-0" : ""}`}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 font-mono text-lg font-semibold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_21rem]">
            <section className="overflow-hidden rounded-lg border border-border/70 bg-card shadow-panel" aria-label="Candlestick analysis chart">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
                <div>
                  <h3 className="font-semibold">{context.data.interval} candles</h3>
                  <p className="text-xs text-muted-foreground">
                    {selectedDocument?.document.viewport.from && selectedDocument.document.viewport.to
                      ? `Focused view · ${formatViewportDate(selectedDocument.document.viewport.from)} – ${formatViewportDate(selectedDocument.document.viewport.to)}`
                      : "Full loaded range · OHLCV with deterministic overlays"}
                  </p>
                </div>
                <p className="font-mono text-[11px] text-muted-foreground">{context.data.snapshotHash.slice(0, 20)}…</p>
              </div>
              <FinancialChart context={context} document={selectedDocument?.document ?? null} />
            </section>

            <aside className="space-y-5 border-l border-border/70 pl-5">
              <section>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 font-semibold"><FileJson2 className="h-4 w-4 text-primary" /> Analysis document</h3>
                  {selectedDocument ? <span className="font-mono text-[11px] text-muted-foreground">v{selectedDocument.version} · {selectedDocument.status}</span> : null}
                </div>
                {selectedDocument ? (
                  <div className="mt-3 space-y-4 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Thesis</p>
                      <p className="mt-1 leading-relaxed">{selectedDocument.document.thesis}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Invalidation</p>
                      <p className="mt-1 leading-relaxed text-resistance">{selectedDocument.document.invalidation}</p>
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    No model has published analysis for this snapshot. The chart context is ready for any provider-neutral agent.
                  </p>
                )}
              </section>

              <section className="border-t border-border/60 pt-4">
                <h3 className="flex items-center gap-2 text-sm font-semibold"><Activity className="h-4 w-4 text-primary" /> Layers</h3>
                <div className="mt-3 space-y-2">
                  {selectedDocument?.document.layers.map((layer) => (
                    <article key={layer.id} className="border-l border-border/80 pl-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-mono text-xs">{layer.type}</p>
                        <span className="text-[11px] text-muted-foreground">{layer.id}</span>
                      </div>
                      {"rationale" in layer ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{layer.rationale}</p> : null}
                    </article>
                  )) ?? <p className="text-xs text-muted-foreground">Default indicators only.</p>}
                </div>
              </section>

              <section className="border-t border-border/60 pt-4 text-xs text-muted-foreground">
                <p className="flex items-center gap-2"><Database className="h-4 w-4" /> {documents.length} stored revisions · {drawingCount} drawings</p>
                <p className="mt-2">Volume profile uses an OHLCV range approximation unless finer trade data is available.</p>
              </section>
            </aside>
          </div>
        </>
      ) : loading ? (
        <div className="grid h-[36rem] animate-pulse place-items-center rounded-lg border border-border/70 bg-card text-sm text-muted-foreground">
          Loading chart context…
        </div>
      ) : null}
    </div>
  );
};
