import {
  CHART_ANALYSIS_SCHEMA,
  DRAWING_CAPABILITIES,
  buildDrawingRenderMetadata,
  chartAnalysisDocumentSchema,
  createAnalysisDocumentSchema,
  publishAnalysisDocumentSchema,
  updateAnalysisDocumentSchema,
  type IndicatorLayer,
} from "@unimarket/analysis";
import { priceHistoryIntervalSchema, priceHistoryLookbackSchema } from "@unimarket/core";
import type { MarketRegistry } from "@unimarket/markets";
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { AppVariables } from "../platform/auth.js";
import { db } from "../db/client.js";
import { chartAnalyses } from "../db/schema.js";
import { jsonError } from "../platform/errors.js";
import { parseJson, parseQuery, withErrorHandling } from "../platform/helpers.js";
import { buildChartContext, parseStoredChartAnalysis, validateChartAnalysisSnapshot } from "../services/chart-analysis.js";
import { makeId, nowIso } from "../utils.js";

const contextQuerySchema = z.object({
  market: z.string().trim().min(1),
  reference: z.string().trim().min(1),
  interval: priceHistoryIntervalSchema.default("1d"),
  lookback: priceHistoryLookbackSchema.default("1y"),
  asOf: z.string().datetime({ offset: true }).optional(),
  documentId: z.string().trim().min(1).optional(),
});

const listQuerySchema = z.object({
  market: z.string().trim().min(1).optional(),
  reference: z.string().trim().min(1).optional(),
  interval: priceHistoryIntervalSchema.optional(),
  status: z.enum(["draft", "published"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const validationSchema = z.object({ document: chartAnalysisDocumentSchema });

const drawingContracts = {
  horizontalLine: { coordinates: ["price"] },
  verticalLine: { coordinates: ["time"] },
  trendLine: { coordinates: ["anchors[2]", "extend.left", "extend.right"] },
  ray: { coordinates: ["anchors[2]"] },
  channel: { coordinates: ["base[2]", "parallelAnchor"] },
  rectangle: { coordinates: ["anchors[2]"] },
  marker: { coordinates: ["point", "shape"] },
  text: { coordinates: ["point", "text"] },
} as const;

const indicatorContracts = {
  sma: { parameters: ["period"] },
  ema: { parameters: ["period"] },
  rsi: { parameters: ["period"] },
  atr: { parameters: ["period"] },
  macd: { parameters: ["fastPeriod", "slowPeriod", "signalPeriod"] },
  bollingerBands: { parameters: ["period", "standardDeviations"] },
  volumeProfile: { parameters: ["from", "to", "bins", "valueAreaPercent", "method=ohlcv-range-approximation"] },
} as const;

export const createAnalysisRoutes = (registry: MarketRegistry) => {
  const router = new Hono<{ Variables: AppVariables }>();

  router.get("/schema", (c) => c.json({
    schema: CHART_ANALYSIS_SCHEMA,
    documentFormat: "versioned JSON",
    drawingCapabilities: DRAWING_CAPABILITIES,
    indicatorCapabilities: ["sma", "ema", "rsi", "atr", "macd", "bollingerBands", "volumeProfile"],
    documentFields: {
      required: ["schema", "title", "instrument", "data", "thesis", "invalidation", "layers", "metadata"],
      instrument: ["market", "reference", "displayName?"],
      data: ["interval", "from", "to", "asOf", "snapshotHash"],
      viewport: ["from?", "to?", "priceScale=auto|logarithmic"],
      metadata: ["createdBy.kind", "createdBy.actorId", "runId?", "createdAt"],
      drawingCommon: ["id", "type", "rationale", "label?", "labelPlacement?", "confidence?", "visible?", "style?"],
      indicatorCommon: ["id", "type", "visible?"],
    },
    drawingContracts,
    indicatorContracts,
    coordinateSystem: "time-price",
    arbitraryCodeAllowed: false,
  }));

  router.get(
    "/context",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, contextQuerySchema);
      if (!parsed.success) return parsed.response;
      const adapter = registry.get(parsed.data.market);
      if (!adapter) return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");
      if (!adapter.getPriceHistory) {
        return jsonError(c, 400, "CAPABILITY_NOT_SUPPORTED", "priceHistory is not supported for this market");
      }
      let indicatorLayers: IndicatorLayer[] | undefined;
      if (parsed.data.documentId) {
        const row = await db.select().from(chartAnalyses).where(eq(chartAnalyses.id, parsed.data.documentId)).get();
        if (!row) return jsonError(c, 404, "ANALYSIS_NOT_FOUND", "Analysis document not found");
        const stored = parseStoredChartAnalysis(row);
        if (stored.document.instrument.market !== parsed.data.market || stored.document.instrument.reference !== parsed.data.reference) {
          return jsonError(c, 409, "INSTRUMENT_MISMATCH", "Analysis document does not match the requested instrument");
        }
        if (stored.document.data.interval !== parsed.data.interval) {
          return jsonError(c, 409, "INTERVAL_MISMATCH", "Analysis document does not match the requested candle interval");
        }
        indicatorLayers = stored.document.layers.filter(
          (layer): layer is IndicatorLayer => !("rationale" in layer),
        );
      }
      const { documentId: _documentId, ...contextOptions } = parsed.data;
      return c.json(await buildChartContext({ registry, ...contextOptions, indicatorLayers }));
    }),
  );

  router.post(
    "/validate",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, validationSchema);
      if (!parsed.success) return parsed.response;
      return c.json({ valid: true, document: parsed.data.document });
    }),
  );

  router.get(
    "/documents",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, listQuerySchema);
      if (!parsed.success) return parsed.response;
      const rows = await db.select().from(chartAnalyses).orderBy(desc(chartAnalyses.createdAt)).all();
      const documents = rows
        .filter((row) => !parsed.data.market || row.market === parsed.data.market)
        .filter((row) => !parsed.data.reference || row.reference === parsed.data.reference)
        .filter((row) => !parsed.data.interval || row.interval === parsed.data.interval)
        .filter((row) => !parsed.data.status || row.status === parsed.data.status)
        .slice(0, parsed.data.limit)
        .map(parseStoredChartAnalysis);
      return c.json({ documents });
    }),
  );

  router.post(
    "/documents",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, createAnalysisDocumentSchema);
      if (!parsed.success) return parsed.response;
      const userId = c.get("userId");
      const createdAt = nowIso();
      let version = 1;

      const adapter = registry.get(parsed.data.document.instrument.market);
      if (!adapter) return jsonError(c, 404, "MARKET_NOT_FOUND", "Market not found");
      if (!adapter.getPriceHistory) {
        return jsonError(c, 400, "CAPABILITY_NOT_SUPPORTED", "priceHistory is not supported for this market");
      }

      const snapshot = await validateChartAnalysisSnapshot(registry, parsed.data.document);
      if (!snapshot.valid) {
        return jsonError(c, 409, "SNAPSHOT_MISMATCH", `Document candle snapshot does not match ${snapshot.expectedHash}`);
      }

      if (parsed.data.supersedesId) {
        const previous = await db.select().from(chartAnalyses).where(eq(chartAnalyses.id, parsed.data.supersedesId)).get();
        if (!previous) return jsonError(c, 404, "ANALYSIS_NOT_FOUND", "Superseded analysis not found");
        if (previous.status !== "published") {
          return jsonError(c, 409, "ANALYSIS_NOT_PUBLISHED", "Only published analyses can be superseded");
        }
        if (
          previous.market !== parsed.data.document.instrument.market ||
          previous.reference !== parsed.data.document.instrument.reference
        ) {
          return jsonError(c, 409, "INSTRUMENT_MISMATCH", "A revision must use the same instrument");
        }
        version = previous.version + 1;
      }

      const document = {
        ...parsed.data.document,
        metadata: {
          ...parsed.data.document.metadata,
          createdBy: { ...parsed.data.document.metadata.createdBy, actorId: userId },
        },
      };
      const row = {
        id: makeId("ana"),
        supersedesId: parsed.data.supersedesId ?? null,
        version,
        status: "draft",
        market: document.instrument.market,
        reference: document.instrument.reference,
        interval: document.data.interval,
        snapshotHash: document.data.snapshotHash,
        document: JSON.stringify(document),
        createdBy: userId,
        reasoning: parsed.data.reasoning,
        createdAt,
        updatedAt: createdAt,
        publishedAt: null,
      };
      await db.insert(chartAnalyses).values(row).run();
      return c.json(parseStoredChartAnalysis(row), 201);
    }),
  );

  router.get(
    "/documents/:id",
    withErrorHandling(async (c) => {
      const row = await db.select().from(chartAnalyses).where(eq(chartAnalyses.id, c.req.param("id"))).get();
      if (!row) return jsonError(c, 404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      return c.json(parseStoredChartAnalysis(row));
    }),
  );

  router.put(
    "/documents/:id",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, updateAnalysisDocumentSchema);
      if (!parsed.success) return parsed.response;
      const id = c.req.param("id");
      const existing = await db.select().from(chartAnalyses).where(eq(chartAnalyses.id, id)).get();
      if (!existing) return jsonError(c, 404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      if (existing.status !== "draft") return jsonError(c, 409, "ANALYSIS_IMMUTABLE", "Published analyses are immutable");
      if (!c.get("isAdmin") && existing.createdBy !== c.get("userId")) {
        return jsonError(c, 403, "FORBIDDEN", "Only the creating agent can update this draft");
      }

      if (
        parsed.data.document.instrument.market !== existing.market ||
        parsed.data.document.instrument.reference !== existing.reference
      ) {
        return jsonError(c, 409, "INSTRUMENT_MISMATCH", "Draft instrument cannot be changed");
      }

      const snapshot = await validateChartAnalysisSnapshot(registry, parsed.data.document);
      if (!snapshot.valid) {
        return jsonError(c, 409, "SNAPSHOT_MISMATCH", `Document candle snapshot does not match ${snapshot.expectedHash}`);
      }

      const document = {
        ...parsed.data.document,
        metadata: {
          ...parsed.data.document.metadata,
          createdBy: { ...parsed.data.document.metadata.createdBy, actorId: existing.createdBy },
        },
      };
      const updatedAt = nowIso();
      await db.update(chartAnalyses).set({
        interval: document.data.interval,
        snapshotHash: document.data.snapshotHash,
        document: JSON.stringify(document),
        reasoning: parsed.data.reasoning,
        updatedAt,
      }).where(and(eq(chartAnalyses.id, id), eq(chartAnalyses.status, "draft"))).run();
      const updated = await db.select().from(chartAnalyses).where(eq(chartAnalyses.id, id)).get();
      if (!updated) throw new Error(`Updated chart analysis ${id} could not be loaded`);
      return c.json(parseStoredChartAnalysis(updated));
    }),
  );

  router.post(
    "/documents/:id/publish",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, publishAnalysisDocumentSchema);
      if (!parsed.success) return parsed.response;
      const id = c.req.param("id");
      const existing = await db.select().from(chartAnalyses).where(eq(chartAnalyses.id, id)).get();
      if (!existing) return jsonError(c, 404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      if (existing.status !== "draft") return jsonError(c, 409, "ANALYSIS_IMMUTABLE", "Analysis is already published");
      if (!c.get("isAdmin") && existing.createdBy !== c.get("userId")) {
        return jsonError(c, 403, "FORBIDDEN", "Only the creating agent can publish this draft");
      }

      const publishedAt = nowIso();
      await db.update(chartAnalyses).set({
        status: "published",
        reasoning: parsed.data.reasoning,
        updatedAt: publishedAt,
        publishedAt,
      }).where(and(eq(chartAnalyses.id, id), eq(chartAnalyses.status, "draft"))).run();
      const published = await db.select().from(chartAnalyses).where(eq(chartAnalyses.id, id)).get();
      if (!published) throw new Error(`Published chart analysis ${id} could not be loaded`);
      return c.json(parseStoredChartAnalysis(published));
    }),
  );

  router.get(
    "/documents/:id/render-metadata",
    withErrorHandling(async (c) => {
      const row = await db.select().from(chartAnalyses).where(eq(chartAnalyses.id, c.req.param("id"))).get();
      if (!row) return jsonError(c, 404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      const stored = parseStoredChartAnalysis(row);
      return c.json({
        analysisId: stored.id,
        version: stored.version,
        snapshotHash: stored.document.data.snapshotHash,
        drawings: buildDrawingRenderMetadata(stored.document),
      });
    }),
  );

  return router;
};
