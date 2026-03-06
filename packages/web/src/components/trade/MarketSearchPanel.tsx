import { BarChart3, Clock, DollarSign, Droplets, Loader2, Search } from "lucide-react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import type { BrowseOption, MarketInfo, MarketReferenceResult } from "../../lib/admin-api";

const compactNumber = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const formatMetric = (value: number | undefined): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return compactNumber.format(value);
};

const formatEndDate = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
};

export const MarketSearchPanel = ({
  markets,
  selectedMarket,
  selectedAsset,
  searchQuery,
  searchResults,
  searchLoading,
  browseSort,
  browseOptions,
  hasMoreResults,
  loadingMore,
  onSelectMarket,
  onSearchQueryChange,
  onSearch,
  onBrowseSortChange,
  onLoadMore,
  onSelectAsset,
}: {
  markets: MarketInfo[];
  selectedMarket: string;
  selectedAsset: MarketReferenceResult | null;
  searchQuery: string;
  searchResults: MarketReferenceResult[];
  searchLoading: boolean;
  browseSort: string;
  browseOptions: BrowseOption[];
  hasMoreResults: boolean;
  loadingMore: boolean;
  onSelectMarket: (marketId: string) => void;
  onSearchQueryChange: (value: string) => void;
  onSearch: () => void;
  onBrowseSortChange: (sort: string) => void;
  onLoadMore: () => void;
  onSelectAsset: (asset: MarketReferenceResult) => void;
}) => {
  const selectedMarketInfo = markets.find((market) => market.id === selectedMarket) ?? null;
  const selectedMarketName = selectedMarketInfo?.name ?? "market";
  const discoveryMode = searchQuery.trim().length > 0 ? "search" : "browse";
  const selectedBrowseLabel = browseOptions.find((option) => option.value === browseSort)?.label ?? browseSort;

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-border/50 bg-card/35 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Discovery</p>
            <p className="text-xs text-muted-foreground">
              {discoveryMode === "search"
                ? `Searching ${selectedMarketName} previews by reference.`
                : `Browsing active ${selectedMarketName} markets${selectedBrowseLabel ? ` by ${selectedBrowseLabel}.` : "."}`}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="asset-search"
              value={searchQuery}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              placeholder={`Search ${selectedMarketName}...`}
              className="pl-9"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onSearch();
                }
              }}
            />
            {searchLoading ? (
              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            ) : null}
          </div>
          <Button
            id="btn-search"
            variant="outline"
            className="shrink-0 gap-1.5"
            onClick={onSearch}
            disabled={searchLoading}
          >
            <Search className="h-4 w-4" />
            {discoveryMode === "search" ? "Search" : "Refresh"}
          </Button>
        </div>

        <div className="flex flex-wrap gap-1.5 rounded-lg border border-border/40 bg-muted/35 p-1">
          {browseOptions.map((option) => (
            <Button
              key={option.value}
              variant={browseSort === option.value ? "default" : "ghost"}
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => onBrowseSortChange(option.value)}
              disabled={searchQuery.trim().length > 0}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {searchResults.length === 0 && !searchLoading ? (
          <Card className="bg-card/30">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {discoveryMode === "search" ? "No markets matched this query." : "No browse results available."}
            </CardContent>
          </Card>
        ) : null}
        {searchResults.map((asset) => {
          const isSelected = selectedAsset?.reference === asset.reference;
          const priceLabel = typeof asset.price === "number" ? asset.price.toFixed(asset.price < 1 ? 4 : 2) : null;
          const volumeLabel = formatMetric(asset.volume);
          const liquidityLabel = formatMetric(asset.liquidity);
          const endDateLabel = formatEndDate(asset.endDate);

          const stats = [
            priceLabel && { icon: DollarSign, label: "Price", value: priceLabel, color: "text-cyan-400" },
            volumeLabel && { icon: BarChart3, label: "Vol", value: volumeLabel, color: "text-emerald-400" },
            liquidityLabel && { icon: Droplets, label: "Liq", value: liquidityLabel, color: "text-amber-400" },
            endDateLabel && { icon: Clock, label: "Ends", value: endDateLabel, color: "text-muted-foreground" },
          ].filter(Boolean) as Array<{ icon: typeof DollarSign; label: string; value: string; color: string }>;

          return (
            <div
              key={asset.reference}
              className={cn(
                "market-card group cursor-pointer overflow-hidden rounded-xl border",
                isSelected
                  ? "market-card--selected border-primary/40 bg-primary/5"
                  : "border-border/40 bg-gradient-to-br from-card/80 to-muted/10 hover:border-border/70",
              )}
              onClick={() => onSelectAsset(asset)}
            >
              <div className="flex flex-col gap-3 px-4 py-3.5 sm:px-5">
                {/* Header: title + selected badge */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold leading-snug text-foreground/95 group-hover:text-primary transition-colors duration-200">
                      {asset.name}
                    </p>
                    <p className="mt-1 max-w-[340px] truncate font-mono text-[10px] text-muted-foreground/55">
                      {asset.reference}
                    </p>
                  </div>
                  {isSelected ? (
                    <Badge variant="default" className="shrink-0 text-[10px] px-2 py-0.5 shadow-sm">
                      Selected
                    </Badge>
                  ) : null}
                </div>

                {/* Stat grid */}
                {stats.length > 0 ? (
                  <div className="stat-grid">
                    {stats.map((stat) => (
                      <div key={stat.label} className="stat-cell">
                        <stat.icon className={cn("h-3 w-3", stat.color)} />
                        <span className="text-[10px] text-muted-foreground/70 leading-none">{stat.label}</span>
                        <span className="text-xs font-semibold tabular-nums leading-none">{stat.value}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}

        {hasMoreResults ? (
          <div className="flex justify-center pt-1">
            <Button variant="outline" onClick={onLoadMore} disabled={searchLoading || loadingMore}>
              {loadingMore ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Load more
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
};
