import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import {
  type AgentMixRow,
  type MarketChartRow,
  chartPalette,
  formatCompactNumber,
  formatTooltipCurrency,
} from "../lib/dashboard";

export const MarketCharts = ({
  marketChartData,
  agentMixData,
}: {
  marketChartData: MarketChartRow[];
  agentMixData: AgentMixRow[];
}) => {
  const tickStyle = {
    fill: "hsl(var(--muted-foreground))",
    fontSize: 12,
    fontFamily: "IBM Plex Mono, monospace",
  };

  const tooltipStyle = {
    backgroundColor: "hsl(var(--popover) / 0.97)",
    border: "1px solid hsl(var(--border))",
    borderRadius: "12px",
    color: "hsl(var(--popover-foreground))",
    boxShadow: "var(--shadow-panel)",
  } as const;

  return (
    <section className="grid gap-4 xl:grid-cols-2">
      <Card className="border-border/75 hover:border-primary/35">
        <CardHeader>
          <CardTitle>Exposure by venue</CardTitle>
          <CardDescription>Top markets by current marked paper value</CardDescription>
        </CardHeader>
        <CardContent className="h-[310px]">
          {marketChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={marketChartData} margin={{ top: 10, right: 8, left: 0, bottom: 10 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                <XAxis dataKey="name" tick={tickStyle} axisLine={false} tickLine={false} />
                <YAxis
                  tickFormatter={(value) => formatCompactNumber(value)}
                  tick={tickStyle}
                  axisLine={false}
                  tickLine={false}
                  width={64}
                />
                <Tooltip
                  formatter={formatTooltipCurrency}
                  cursor={{ fill: "hsl(var(--accent) / 0.35)" }}
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                />
                <Bar dataKey="value" radius={[10, 10, 0, 0]}>
                  {marketChartData.map((entry, index) => (
                    <Cell key={`${entry.name}-cell`} fill={chartPalette[index % chartPalette.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border/80 bg-muted/30 px-4 text-center text-sm text-muted-foreground">
              No priced market exposure yet.
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/75 hover:border-primary/35">
        <CardHeader>
          <CardTitle>Agent equity mix</CardTitle>
          <CardDescription>Paper equity concentration across agents</CardDescription>
        </CardHeader>
        <CardContent className="h-[310px]">
          {agentMixData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={agentMixData} dataKey="value" nameKey="name" innerRadius={72} outerRadius={112} paddingAngle={2}>
                  {agentMixData.map((entry, index) => (
                    <Cell
                      key={`${entry.name}-slice`}
                      fill={chartPalette[index % chartPalette.length]}
                      stroke="hsl(var(--background))"
                      strokeWidth={2}
                    />
                  ))}
                </Pie>
                <Tooltip
                  formatter={formatTooltipCurrency}
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center rounded-md border border-dashed border-border/80 bg-muted/30 px-4 text-center text-sm text-muted-foreground">
              No agent equity mix yet.
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
};
