import { createJournalSchema, paginationQuerySchema } from "@unimarket/core";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { AppVariables } from "../platform/auth.js";
import { db } from "../db/client.js";
import { journal } from "../db/schema.js";
import { jsonError } from "../platform/errors.js";
import {
  parseStoredStringArray,
  parseJson,
  parseQuery,
  requireNonAdminUserId,
  serializeTags,
  withErrorHandling,
} from "../platform/helpers.js";
import { beginIdempotentRequest, storeIdempotentJsonResponse } from "../platform/idempotency.js";
import { makeId, nowIso } from "../utils.js";

const router = new Hono<{ Variables: AppVariables }>();
const parseTags = (raw: string): string[] => parseStoredStringArray(raw, "journal tags");

router.post(
  "/",
  withErrorHandling(async (c) => {
    const parsed = await parseJson(c, createJournalSchema);
    if (!parsed.success) return parsed.response;

    const userResult = requireNonAdminUserId(c, "Invalid user for journal entry");
    if (!userResult.success) {
      return userResult.response;
    }

    const idempotency = await beginIdempotentRequest(c, userResult.userId, parsed.data);
    if (idempotency.kind === "response") {
      return idempotency.response;
    }

    const entry = {
      id: makeId("jrn"),
      userId: userResult.userId,
      content: parsed.data.content,
      tags: serializeTags(parsed.data.tags),
      createdAt: nowIso(),
    };

    await db.insert(journal).values(entry).run();
    const payload = { ...entry, tags: parseTags(entry.tags) };
    const response = c.json(payload, 201);
    await storeIdempotentJsonResponse(idempotency.candidate, response);
    return response;
  }),
);

router.get(
  "/",
  withErrorHandling(async (c) => {
    const parsed = parseQuery(c, paginationQuerySchema);
    if (!parsed.success) return parsed.response;

    const userResult = requireNonAdminUserId(c, "Invalid user for journal listing");
    if (!userResult.success) {
      return userResult.response;
    }

    const q = c.req.query("q")?.trim();
    const tagsQuery = c.req.query("tags")?.trim();
    const tagSet = tagsQuery ? new Set(tagsQuery.split(",").map((t) => t.trim()).filter(Boolean)) : null;

    let rows = await db.select().from(journal).where(eq(journal.userId, userResult.userId)).orderBy(desc(journal.createdAt)).all();

    if (q) {
      const lowered = q.toLowerCase();
      rows = rows.filter(
        (row) =>
          row.content.toLowerCase().includes(lowered) ||
          parseTags(row.tags).some((tag) => tag.toLowerCase().includes(lowered)),
      );
    }

    if (tagSet) {
      rows = rows.filter((row) => parseTags(row.tags).some((tag) => tagSet.has(tag)));
    }

    const paginated = rows.slice(parsed.data.offset, parsed.data.offset + parsed.data.limit);
    return c.json({
      entries: paginated.map((entry) => ({ ...entry, tags: parseTags(entry.tags) })),
    });
  }),
);

export { router as journalRoutes };
