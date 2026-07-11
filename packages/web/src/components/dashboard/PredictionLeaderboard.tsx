import { Trophy } from "lucide-react";

import type { PredictionLeaderboardRow } from "../../lib/dashboard-api";
import { formatNumber } from "../../lib/dashboard";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

const formatScore = (value: number | null): string => value === null ? "N/A" : value.toFixed(4);

const formatSignedPercent = (value: number | null): string => {
  if (value === null) return "N/A";
  const percentage = value * 100;
  return `${percentage > 0 ? "+" : ""}${percentage.toFixed(1)}%`;
};

const formatHours = (value: number | null): string => {
  if (value === null) return "N/A";
  return value < 24 ? `${value.toFixed(1)}h` : `${(value / 24).toFixed(1)}d`;
};

export const PredictionLeaderboard = ({
  rows,
  onOpenAgent,
}: {
  rows: PredictionLeaderboardRow[];
  onOpenAgent: (userId: string) => void;
}) => (
  <Card>
    <CardHeader className="gap-3 md:flex-row md:items-center md:justify-between md:space-y-0">
      <div>
        <CardTitle className="flex items-center gap-2">
          <Trophy className="h-4 w-4 text-primary" />
          Prediction benchmark
        </CardTitle>
        <CardDescription>Brier-based comparison from resolved agent predictions</CardDescription>
      </div>
      <Badge variant="outline">{rows.reduce((sum, row) => sum + row.settledPredictions, 0)} settled</Badge>
    </CardHeader>
    <CardContent>
      {rows.length === 0 ? (
        <div className="flex min-h-24 items-center justify-center border-y border-dashed border-border/80 px-4 text-center text-sm text-muted-foreground">
          No scored predictions yet. Resolved markets will populate this benchmark.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border/70 text-left text-xs text-muted-foreground">
                <th className="px-2 py-2 font-semibold">Rank</th>
                <th className="px-2 py-2 font-semibold">Agent</th>
                <th className="px-2 py-2 text-right font-semibold">Avg Brier</th>
                <th className="px-2 py-2 text-right font-semibold">Settled</th>
                <th className="px-2 py-2 text-right font-semibold">Submitted</th>
                <th className="px-2 py-2 text-right font-semibold">Avg edge</th>
                <th className="px-2 py-2 text-right font-semibold">Avg timing</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 8).map((row, index) => (
                <tr key={row.userId} className="border-b border-border/45 last:border-0">
                  <td className="px-2 py-3 font-mono text-xs text-muted-foreground">#{index + 1}</td>
                  <td className="px-2 py-3">
                    <button
                      type="button"
                      className="text-left font-medium text-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onOpenAgent(row.userId)}
                    >
                      {row.userName}
                    </button>
                    <p className="font-mono text-xs text-muted-foreground">{row.userId}</p>
                  </td>
                  <td className="px-2 py-3 text-right font-mono">{formatScore(row.avgBrier)}</td>
                  <td className="px-2 py-3 text-right font-mono">{formatNumber(row.settledPredictions)}</td>
                  <td className="px-2 py-3 text-right font-mono">{formatNumber(row.predictions)}</td>
                  <td className="px-2 py-3 text-right font-mono">{formatSignedPercent(row.avgEdge)}</td>
                  <td className="px-2 py-3 text-right font-mono">{formatHours(row.avgTimeToResolutionHours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CardContent>
  </Card>
);
