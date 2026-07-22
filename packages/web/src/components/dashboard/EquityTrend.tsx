import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { formatCompactNumber, formatCurrency } from "../../lib/dashboard";
import type { ChartMode, ChartRow } from "../../lib/equity-chart";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

const RANGE_LABELS = {
  "1w": "1W",
  "1m": "1M",
  "3m": "3M",
  "6m": "6M",
  "1y": "1Y",
} as const;

type EquityTrendProps = {
  mode: ChartMode;
  onModeChange: (mode: ChartMode) => void;
  range: string;
  onRangeChange: (range: string) => void;
  loading: boolean;
  rows: ChartRow[];
  domain: [number, number] | undefined;
  agentNames: string[];
  selectedAgents: ReadonlySet<string>;
  colors: Record<string, string>;
};

const tickStyle = {
  fill: "hsl(var(--muted-foreground))",
  fontSize: 11,
  fontFamily: "IBM Plex Mono, monospace",
};

const tooltipStyle = {
  backgroundColor: "hsl(var(--popover) / 0.97)",
  border: "1px solid hsl(var(--border))",
  borderRadius: "8px",
  color: "hsl(var(--popover-foreground))",
  boxShadow: "var(--shadow-panel)",
} as const;

export const EquityTrend = ({
  mode,
  onModeChange,
  range,
  onRangeChange,
  loading,
  rows,
  domain,
  agentNames,
  selectedAgents,
  colors,
}: EquityTrendProps) => (
  <Card>
    <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between md:space-y-0">
      <div>
        <CardTitle>{mode === "equity" ? "Equity trend" : "Return trend"}</CardTitle>
        <CardDescription>
          {mode === "equity"
            ? "Paper portfolio equity by agent across review snapshots"
            : "Percentage return since the start of the selected period"}
        </CardDescription>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-border/60 bg-background/50 p-0.5" aria-label="Chart metric">
          {(["equity", "return"] as const).map((option) => (
            <Button
              key={option}
              variant={mode === option ? "default" : "ghost"}
              size="sm"
              className="h-7 text-xs"
              onClick={() => onModeChange(option)}
            >
              {option === "equity" ? "Equity" : "Return %"}
            </Button>
          ))}
        </div>
        <div className="flex rounded-md border border-border/60 bg-background/50 p-0.5" aria-label="History range">
          {Object.entries(RANGE_LABELS).map(([value, label]) => (
            <Button
              key={value}
              variant={range === value ? "default" : "ghost"}
              size="sm"
              className="h-7 w-9 p-0 text-xs"
              onClick={() => onRangeChange(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
    </CardHeader>
    <CardContent className="h-[300px]">
      {loading ? (
        <div className="grid h-full content-end gap-3" aria-label="Loading equity history">
          {["h-9", "h-14", "h-20", "h-28"].map((heightClass) => (
            <div key={heightClass} className={`${heightClass} animate-pulse rounded-md bg-muted/60`} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex h-full items-center justify-center border-y border-dashed border-border/80 px-4 text-center text-sm text-muted-foreground">
          No review history yet. Refresh records the next snapshot for comparison.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 10, right: 56, left: 0, bottom: 10 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
            <XAxis dataKey="time" tick={tickStyle} axisLine={false} tickLine={false} interval="preserveStartEnd" />
            <YAxis
              domain={domain}
              padding={{ top: 10, bottom: 10 }}
              tickFormatter={(value) => {
                if (mode === "return") return `${value.toFixed(1)}%`;
                if (domain && domain[1] - domain[0] < 1000) {
                  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
                }
                return formatCompactNumber(value);
              }}
              tick={tickStyle}
              axisLine={false}
              tickLine={false}
              width={64}
            />
            <Tooltip
              formatter={(value) => typeof value === "number"
                ? mode === "return" ? `${value.toFixed(2)}%` : formatCurrency(value)
                : "—"}
              contentStyle={tooltipStyle}
              labelStyle={{ color: "hsl(var(--muted-foreground))" }}
            />
            {agentNames.filter((name) => selectedAgents.has(name)).map((name) => (
              <Line
                key={name}
                type="monotone"
                dataKey={name}
                stroke={colors[name]}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </CardContent>
  </Card>
);
