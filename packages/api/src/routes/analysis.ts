import {
  buildDrawingRenderMetadata,
  createAnalysisDocumentSchema,
  publishAnalysisDocumentSchema,
  updateAnalysisDocumentSchema,
  type IndicatorLayer,
} from "@unimarket/analysis";
import type { MarketRegistry } from "@unimarket/markets";
import { Hono } from "hono";

import type { AppVariables } from "../platform/auth.js";
import { jsonError } from "../platform/errors.js";
import { parseJson, parseQuery, withErrorHandling } from "../platform/helpers.js";
import {
  createChartAnalysis,
  findChartAnalysis,
  listChartAnalyses,
  publishDraftChartAnalysis,
  replaceDraftChartAnalysis,
} from "../services/chart-analysis-repository.js";
import { buildChartContext, parseStoredChartAnalysis, validateChartAnalysisSnapshot } from "../services/chart-analysis.js";
import { makeId, nowIso } from "../utils.js";
import {
  analysisListQuerySchema,
  analysisSchemaResponse,
  analysisValidationSchema,
  contextQuerySchema,
} from "./analysis-contract.js";

export const createAnalysisRoutes = (registry: MarketRegistry) => {
  const router = new Hono<{ Variables: AppVariables }>();

  router.get("/schema", (c) => c.json(analysisSchemaResponse));

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
      let documentSnapshot: { hash: string; startTime: string; endTime: string } | undefined;
      if (parsed.data.documentId) {
        const row = await findChartAnalysis(parsed.data.documentId);
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
        documentSnapshot = {
          hash: stored.document.data.snapshotHash,
          startTime: stored.document.data.from,
          endTime: stored.document.data.to,
        };
      }
      const context = await buildChartContext({
        registry,
        market: parsed.data.market,
        reference: parsed.data.reference,
        interval: parsed.data.interval,
        range: documentSnapshot
          ? { mode: "custom", startTime: documentSnapshot.startTime, endTime: documentSnapshot.endTime }
          : { mode: "lookback", lookback: parsed.data.lookback, asOf: parsed.data.asOf },
        indicatorLayers,
      });
      if (documentSnapshot && context.data.snapshotHash !== documentSnapshot.hash) {
        return jsonError(c, 409, "SNAPSHOT_MISMATCH", "Stored analysis snapshot no longer matches the market adapter data");
      }
      return c.json(context);
    }),
  );

  router.post(
    "/validate",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, analysisValidationSchema);
      if (!parsed.success) return parsed.response;
      return c.json({ valid: true, document: parsed.data.document });
    }),
  );

  router.get(
    "/documents",
    withErrorHandling(async (c) => {
      const parsed = parseQuery(c, analysisListQuerySchema);
      if (!parsed.success) return parsed.response;
      const rows = await listChartAnalyses(parsed.data);
      const documents = rows.map(parseStoredChartAnalysis);
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
        const previous = await findChartAnalysis(parsed.data.supersedesId);
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
        if (previous.interval !== parsed.data.document.data.interval) {
          return jsonError(c, 409, "INTERVAL_MISMATCH", "A revision must use the same candle interval");
        }
        version = previous.version + 1;
      }

      const document = {
        ...parsed.data.document,
        metadata: {
          ...parsed.data.document.metadata,
          createdBy: { kind: c.get("isAdmin") ? "system" as const : "agent" as const, actorId: userId },
          createdAt,
        },
      };
      const row = {
        id: makeId("ana"),
        supersedesId: parsed.data.supersedesId ?? null,
        version,
        revision: 1,
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
      return c.json(parseStoredChartAnalysis(await createChartAnalysis(row)), 201);
    }),
  );

  router.get(
    "/documents/:id",
    withErrorHandling(async (c) => {
      const row = await findChartAnalysis(c.req.param("id"));
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
      const existing = await findChartAnalysis(id);
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
      if (parsed.data.document.data.interval !== existing.interval) {
        return jsonError(c, 409, "INTERVAL_MISMATCH", "Draft candle interval cannot be changed");
      }

      const snapshot = await validateChartAnalysisSnapshot(registry, parsed.data.document);
      if (!snapshot.valid) {
        return jsonError(c, 409, "SNAPSHOT_MISMATCH", `Document candle snapshot does not match ${snapshot.expectedHash}`);
      }

      const existingDocument = parseStoredChartAnalysis(existing).document;
      const document = {
        ...parsed.data.document,
        metadata: {
          ...parsed.data.document.metadata,
          createdBy: existingDocument.metadata.createdBy,
          createdAt: existingDocument.metadata.createdAt,
        },
      };
      const updated = await replaceDraftChartAnalysis(existing, {
        snapshotHash: document.data.snapshotHash,
        document: JSON.stringify(document),
        reasoning: parsed.data.reasoning,
        updatedAt: nowIso(),
      });
      if (!updated) {
        return jsonError(c, 409, "ANALYSIS_CONFLICT", "Draft changed while the update was being applied");
      }
      return c.json(parseStoredChartAnalysis(updated));
    }),
  );

  router.post(
    "/documents/:id/publish",
    withErrorHandling(async (c) => {
      const parsed = await parseJson(c, publishAnalysisDocumentSchema);
      if (!parsed.success) return parsed.response;
      const id = c.req.param("id");
      const existing = await findChartAnalysis(id);
      if (!existing) return jsonError(c, 404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      if (existing.status !== "draft") return jsonError(c, 409, "ANALYSIS_IMMUTABLE", "Analysis is already published");
      if (!c.get("isAdmin") && existing.createdBy !== c.get("userId")) {
        return jsonError(c, 403, "FORBIDDEN", "Only the creating agent can publish this draft");
      }

      const publishedAt = nowIso();
      const published = await publishDraftChartAnalysis(existing, parsed.data.reasoning, publishedAt);
      if (!published) {
        return jsonError(c, 409, "ANALYSIS_CONFLICT", "Draft changed while it was being published");
      }
      return c.json(parseStoredChartAnalysis(published));
    }),
  );

  router.get(
    "/documents/:id/render-metadata",
    withErrorHandling(async (c) => {
      const row = await findChartAnalysis(c.req.param("id"));
      if (!row) return jsonError(c, 404, "ANALYSIS_NOT_FOUND", "Analysis not found");
      const stored = parseStoredChartAnalysis(row);
      return c.json({
        analysisId: stored.id,
        version: stored.version,
        revision: stored.revision,
        snapshotHash: stored.document.data.snapshotHash,
        drawings: buildDrawingRenderMetadata(stored.document),
      });
    }),
  );

  return router;
};
