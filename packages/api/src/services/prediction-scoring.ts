import { and, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { predictionScores, predictions, users } from "../db/schema.js";
import { makeId } from "../utils.js";

const SCORE_VERSION = "v1";

type PredictionRow = typeof predictions.$inferSelect;
type PredictionScoreRow = typeof predictionScores.$inferSelect;

type ScoreTx = {
  select: typeof db.select;
  insert: typeof db.insert;
};

export type PredictionLeaderboardRow = {
  userId: string;
  userName: string;
  predictions: number;
  settledPredictions: number;
  avgBrier: number | null;
  avgEdge: number | null;
  avgConviction: number | null;
  avgTimeToResolutionHours: number | null;
};

const round = (value: number, digits = 6): number => Number(value.toFixed(digits));

const hoursBetween = (startIso: string, endIso: string): number | null => {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return round((end - start) / 3_600_000);
};

const predictionEdge = (prediction: PredictionRow): number | null => {
  if (prediction.entryPrice === null) return null;
  const rawEdge = prediction.side === "sell"
    ? prediction.entryPrice - prediction.probability
    : prediction.probability - prediction.entryPrice;
  return round(rawEdge);
};

const insertScore = async (
  tx: ScoreTx,
  prediction: PredictionRow,
  metric: string,
  value: number,
  scoredAt: string,
  details: Record<string, unknown>,
): Promise<void> => {
  await tx
    .insert(predictionScores)
    .values({
      id: makeId("psc"),
      predictionId: prediction.id,
      orderId: prediction.orderId,
      accountId: prediction.accountId,
      userId: prediction.userId,
      market: prediction.market,
      symbol: prediction.symbol,
      metric,
      version: SCORE_VERSION,
      value: round(value),
      details: JSON.stringify(details),
      scoredAt,
    })
    .onConflictDoNothing()
    .run();
};

export const scoreResolvedPredictionsInTx = async (
  tx: ScoreTx,
  {
    accountId,
    market,
    symbol,
    settlementPrice,
    resolvedOutcome,
    resolvedAt,
  }: {
    accountId: string;
    market: string;
    symbol: string;
    settlementPrice: number;
    resolvedOutcome: string | null;
    resolvedAt: string;
  },
): Promise<number> => {
  const predictionRows = await tx
    .select()
    .from(predictions)
    .where(and(eq(predictions.accountId, accountId), eq(predictions.market, market), eq(predictions.symbol, symbol)))
    .all();

  let scored = 0;
  for (const prediction of predictionRows) {
    const details = {
      resolvedOutcome,
      settlementPrice,
      submittedAt: prediction.submittedAt,
      resolvedAt,
      entryPrice: prediction.entryPrice,
    };

    const brier = (prediction.probability - settlementPrice) ** 2;
    await insertScore(tx, prediction, "brier", brier, resolvedAt, details);
    scored += 1;

    const timeToResolutionHours = hoursBetween(prediction.submittedAt, resolvedAt);
    if (timeToResolutionHours !== null) {
      await insertScore(tx, prediction, "time_to_resolution_hours", timeToResolutionHours, resolvedAt, details);
    }

    const edge = predictionEdge(prediction);
    if (edge !== null) {
      await insertScore(tx, prediction, "entry_edge", edge, resolvedAt, details);
    }
  }

  return scored;
};

const average = (values: number[]): number | null => {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
};

export const buildPredictionLeaderboard = async (): Promise<PredictionLeaderboardRow[]> => {
  const [userRows, predictionRows, scoreRows] = await Promise.all([
    db.select().from(users).all(),
    db.select().from(predictions).all(),
    db.select().from(predictionScores).where(eq(predictionScores.version, SCORE_VERSION)).all(),
  ]);

  const userNameById = new Map(userRows.map((user) => [user.id, user.name]));
  const predictionsByUser = new Map<string, PredictionRow[]>();
  for (const prediction of predictionRows) {
    const rows = predictionsByUser.get(prediction.userId) ?? [];
    rows.push(prediction);
    predictionsByUser.set(prediction.userId, rows);
  }

  const scoresByUserAndMetric = new Map<string, PredictionScoreRow[]>();
  for (const score of scoreRows) {
    const key = `${score.userId}:${score.metric}`;
    const rows = scoresByUserAndMetric.get(key) ?? [];
    rows.push(score);
    scoresByUserAndMetric.set(key, rows);
  }

  return Array.from(predictionsByUser.entries())
    .map(([userId, rows]) => {
      const brierScores = scoresByUserAndMetric.get(`${userId}:brier`) ?? [];
      const timeScores = scoresByUserAndMetric.get(`${userId}:time_to_resolution_hours`) ?? [];
      const edgeScores = scoresByUserAndMetric.get(`${userId}:entry_edge`) ?? [];
      const convictionValues = rows
        .map((prediction) => prediction.conviction)
        .filter((value): value is number => value !== null);

      return {
        userId,
        userName: userNameById.get(userId) ?? userId,
        predictions: rows.length,
        settledPredictions: brierScores.length,
        avgBrier: average(brierScores.map((score) => score.value)),
        avgEdge: average(edgeScores.map((score) => score.value)),
        avgConviction: average(convictionValues),
        avgTimeToResolutionHours: average(timeScores.map((score) => score.value)),
      };
    })
    .sort((a, b) => {
      if (a.avgBrier === null && b.avgBrier === null) return b.predictions - a.predictions;
      if (a.avgBrier === null) return 1;
      if (b.avgBrier === null) return -1;
      if (a.avgBrier !== b.avgBrier) return a.avgBrier - b.avgBrier;
      return b.settledPredictions - a.settledPredictions;
    });
};
