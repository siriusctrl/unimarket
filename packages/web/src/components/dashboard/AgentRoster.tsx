import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";

import type { AgentView } from "../../lib/dashboard-api";
import { formatCurrency, formatNumber, formatSignedCurrency } from "../../lib/dashboard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const AGENTS_PER_PAGE = 6;

const AgentRow = ({
  agent,
  color,
  selected,
  onToggle,
  onOpen,
}: {
  agent: AgentView;
  color: string;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) => {
  const largestExposure = [...agent.positions]
    .sort((left, right) => (right.marketValue ?? 0) - (left.marketValue ?? 0))[0];

  return (
    <article className={selected ? "bg-primary/[0.035]" : "bg-card"}>
      <div className="grid grid-cols-2 items-center gap-4 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(13rem,1.35fr)_minmax(8rem,0.8fr)_minmax(8rem,0.8fr)_minmax(8rem,0.8fr)_minmax(12rem,1.2fr)_auto]">
        <div className="col-span-2 flex min-w-0 items-start gap-3 lg:col-span-1">
          <button
            type="button"
            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onToggle}
            aria-pressed={selected}
            aria-label={`${selected ? "Hide" : "Show"} ${agent.userName} on equity chart`}
            title={`${selected ? "Hide" : "Show"} chart series`}
          >
            <span
              className={selected ? "h-2.5 w-2.5 rounded-sm" : "h-2.5 w-2.5 rounded-sm opacity-25"}
              style={{ backgroundColor: color }}
            />
          </button>
          <button
            type="button"
            className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onOpen}
            aria-label={`Open ${agent.userName} review`}
          >
            <h3 className="truncate font-semibold transition-colors hover:text-primary">{agent.userName}</h3>
            <p className="truncate font-mono text-xs text-muted-foreground">{agent.userId}</p>
          </button>
        </div>

        <dl className="contents">
          <div>
            <dt className="text-xs text-muted-foreground">Paper equity</dt>
            <dd className="mt-1 font-mono text-sm font-semibold tabular-nums">{formatCurrency(agent.totals.equity)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Cash reserve</dt>
            <dd className="mt-1 font-mono text-sm font-semibold tabular-nums">{formatCurrency(agent.balance)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Unrealized PnL</dt>
            <dd className={agent.totals.unrealizedPnl === null
              ? "mt-1 font-mono text-sm font-semibold text-muted-foreground"
              : agent.totals.unrealizedPnl >= 0
                ? "mt-1 font-mono text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400"
                : "mt-1 font-mono text-sm font-semibold tabular-nums text-rose-600 dark:text-rose-400"}
            >
              {formatSignedCurrency(agent.totals.unrealizedPnl)}
            </dd>
          </div>
        </dl>

        <div className="col-span-2 min-w-0 lg:col-span-1">
          <p className="text-xs text-muted-foreground">Largest marked value</p>
          {largestExposure ? (
            <div className="mt-1 flex min-w-0 items-center justify-between gap-3">
              <span className="truncate text-xs" title={largestExposure.symbolName ?? largestExposure.symbol}>
                {largestExposure.symbolName ?? largestExposure.symbol}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                {formatCurrency(largestExposure.marketValue)}
              </span>
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">No open positions</p>
          )}
          <p className="mt-1 text-[11px] text-muted-foreground">
            {formatNumber(agent.totals.positions)} positions · {agent.valuation.status === "partial" ? "valuation partial" : "valuation complete"}
          </p>
        </div>

        <Button variant="ghost" size="sm" className="col-span-2 h-8 justify-self-start px-2 text-xs lg:col-span-1 lg:justify-self-end" onClick={onOpen}>
          Review
        </Button>
      </div>
    </article>
  );
};

export const AgentRoster = ({
  agents,
  selectedAgents,
  colors,
  onToggleAgent,
  onSelectAll,
  onClearSelection,
  onOpenAgent,
}: {
  agents: AgentView[];
  selectedAgents: ReadonlySet<string>;
  colors: Record<string, string>;
  onToggleAgent: (name: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onOpenAgent: (userId: string) => void;
}) => {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const filteredAgents = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return agents;
    return agents.filter((agent) => `${agent.userName} ${agent.userId}`.toLowerCase().includes(query));
  }, [agents, search]);
  const totalPages = Math.max(1, Math.ceil(filteredAgents.length / AGENTS_PER_PAGE));
  const currentPage = Math.min(page, totalPages - 1);
  const visibleAgents = filteredAgents.slice(currentPage * AGENTS_PER_PAGE, (currentPage + 1) * AGENTS_PER_PAGE);

  useEffect(() => {
    setPage((current) => Math.min(current, totalPages - 1));
  }, [totalPages]);

  const updateSearch = (value: string) => {
    setSearch(value);
    setPage(0);
  };

  return (
    <section className="space-y-3" aria-labelledby="agent-roster-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 id="agent-roster-title" className="text-lg font-semibold">Agent roster</h2>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onSelectAll}>Show all</Button>
            <span className="text-border">/</span>
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onClearSelection}>Clear</Button>
          </div>
        </div>
        <label className="relative w-64">
          <span className="sr-only">Search agents</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => updateSearch(event.target.value)} placeholder="Search agents..." className="pl-9" />
        </label>
      </div>

      {filteredAgents.length === 0 ? (
        <p className="border-y border-dashed border-border/80 py-12 text-center text-sm text-muted-foreground">
          {search ? "No agents match this filter." : "No agent accounts are visible yet."}
        </p>
      ) : (
        <>
          <div className="overflow-hidden rounded-lg border border-border/70 bg-card shadow-panel divide-y divide-border/60">
            {visibleAgents.map((agent) => (
              <AgentRow
                key={agent.userId}
                agent={agent}
                color={colors[agent.userName] ?? "hsl(var(--border))"}
                selected={selectedAgents.has(agent.userName)}
                onToggle={() => onToggleAgent(agent.userName)}
                onOpen={() => onOpenAgent(agent.userId)}
              />
            ))}
          </div>

          {totalPages > 1 ? (
            <nav className="flex items-center justify-between pt-2" aria-label="Agent roster pages">
              <p className="text-xs text-muted-foreground">
                {currentPage * AGENTS_PER_PAGE + 1}–{Math.min((currentPage + 1) * AGENTS_PER_PAGE, filteredAgents.length)} of {filteredAgents.length}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === 0}
                  onClick={() => setPage((current) => current - 1)}
                  className="h-8 w-8 p-0"
                  aria-label="Previous agent page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="px-2 text-xs tabular-nums">{currentPage + 1} / {totalPages}</span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={currentPage === totalPages - 1}
                  onClick={() => setPage((current) => current + 1)}
                  className="h-8 w-8 p-0"
                  aria-label="Next agent page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </nav>
          ) : null}
        </>
      )}
    </section>
  );
};
