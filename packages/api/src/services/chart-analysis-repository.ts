import { and, desc, eq } from "drizzle-orm";

import { db } from "../db/client.js";
import { chartAnalyses } from "../db/schema.js";

export type ChartAnalysisRow = typeof chartAnalyses.$inferSelect;
export type NewChartAnalysisRow = typeof chartAnalyses.$inferInsert;

export type ChartAnalysisListFilters = {
  market?: string;
  reference?: string;
  interval?: string;
  status?: "draft" | "published";
  limit: number;
};

export const findChartAnalysis = (id: string): Promise<ChartAnalysisRow | undefined> =>
  db.select().from(chartAnalyses).where(eq(chartAnalyses.id, id)).get();

export const listChartAnalyses = (filters: ChartAnalysisListFilters): Promise<ChartAnalysisRow[]> =>
  db.select().from(chartAnalyses).where(and(
    filters.market ? eq(chartAnalyses.market, filters.market) : undefined,
    filters.reference ? eq(chartAnalyses.reference, filters.reference) : undefined,
    filters.interval ? eq(chartAnalyses.interval, filters.interval) : undefined,
    filters.status ? eq(chartAnalyses.status, filters.status) : undefined,
  )).orderBy(desc(chartAnalyses.createdAt)).limit(filters.limit).all();

export const createChartAnalysis = (row: NewChartAnalysisRow): Promise<ChartAnalysisRow> =>
  db.insert(chartAnalyses).values(row).returning().get();

export const replaceDraftChartAnalysis = (
  existing: ChartAnalysisRow,
  values: Pick<NewChartAnalysisRow, "snapshotHash" | "document" | "reasoning" | "updatedAt">,
): Promise<ChartAnalysisRow | undefined> =>
  db.update(chartAnalyses).set({ ...values, revision: existing.revision + 1 }).where(and(
    eq(chartAnalyses.id, existing.id),
    eq(chartAnalyses.status, "draft"),
    eq(chartAnalyses.revision, existing.revision),
  )).returning().get();

export const publishDraftChartAnalysis = (
  existing: ChartAnalysisRow,
  reasoning: string,
  publishedAt: string,
): Promise<ChartAnalysisRow | undefined> =>
  db.update(chartAnalyses).set({
    status: "published",
    revision: existing.revision + 1,
    reasoning,
    updatedAt: publishedAt,
    publishedAt,
  }).where(and(
    eq(chartAnalyses.id, existing.id),
    eq(chartAnalyses.status, "draft"),
    eq(chartAnalyses.revision, existing.revision),
  )).returning().get();
