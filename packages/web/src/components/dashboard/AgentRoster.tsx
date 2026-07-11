import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";

import type { AgentView } from "../../lib/dashboard-api";
import { formatCurrency, formatNumber, formatSignedCurrency } from "../../lib/dashboard";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const AGENTS_PER_PAGE = 6;

const AgentCard = ({
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
}) => (
  <article
    className={`overflow-hidden rounded-lg border bg-card transition-colors ${selected
      ? "border-primary/35"
      : "border-border/45 opacity-65"}`}
  >
    <div className="flex">
      <div
        className="w-1 shrink-0 transition-opacity duration-200"
        style={{ backgroundColor: color, opacity: selected ? 1 : 0.3 }}
      />
      <div className="min-w-0 flex-1 p-5">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onToggle}
            aria-pressed={selected}
          >
            <h3 className="truncate text-lg font-semibold">{agent.userName}</h3>
            <p className="font-mono text-xs text-muted-foreground">{agent.userId}</p>
          </button>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant="outline">{formatNumber(agent.totals.positions)} pos</Badge>
            {agent.valuation.status === "partial" ? (
              <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300">
                Partial
              </Badge>
            ) : null}
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onOpen}>
              Review
            </Button>
          </div>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3">
          <div>
            <dt className="text-xs text-muted-foreground">Paper equity</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatCurrency(agent.totals.equity)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Cash reserve</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatCurrency(agent.balance)}</dd>
          </div>
          <div className="col-span-2 flex items-center justify-between border-t border-border/50 pt-2">
            <dt className="text-xs text-muted-foreground">Unrealized PnL</dt>
            <dd className={agent.totals.unrealizedPnl === null
              ? "font-medium text-muted-foreground"
              : agent.totals.unrealizedPnl >= 0
                ? "font-medium tabular-nums text-emerald-600 dark:text-emerald-400"
                : "font-medium tabular-nums text-rose-600 dark:text-rose-400"}
            >
              {formatSignedCurrency(agent.totals.unrealizedPnl)}
            </dd>
          </div>
        </dl>

        {agent.positions.length > 0 ? (
          <div className="mt-3 space-y-1 border-t border-border/50 pt-3">
            <p className="text-xs font-medium text-muted-foreground">Largest exposure</p>
            {agent.positions.slice(0, 3).map((position) => (
              <div key={`${position.market}:${position.symbol}`} className="flex items-center justify-between gap-3 text-xs">
                <span className="max-w-[14rem] truncate font-mono text-muted-foreground">
                  {position.symbolName ?? position.symbol}
                </span>
                <span className="shrink-0 font-medium tabular-nums">{formatCurrency(position.marketValue)}</span>
              </div>
            ))}
            {agent.positions.length > 3 ? (
              <p className="text-xs text-muted-foreground">{agent.positions.length - 3} more positions</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  </article>
);

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
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visibleAgents.map((agent) => (
              <AgentCard
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
