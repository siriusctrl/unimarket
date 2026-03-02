import { createJournalSchema, paginationQuerySchema } from "@unimarket/core";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";

import type { AppVariables } from "../auth.js";
import { db } from "../db/client.js";
import { journal } from "../db/schema.js";
import { jsonError } from "../errors.js";
import { deserializeTags, parseJson, parseQuery, serializeTags, withErrorHandling } from "../helpers.js";
import { makeId, nowIso } from "../utils.js";

const router = new Hono<{ Variables: AppVariables }>();

router.post(
  "/",
  withErrorHandling(async (c) => {
    const parsed = await parseJson(c, createJournalSchema);
    if (!parsed.success) return parsed.response;

    const userId = c.get("userId");
    if (!userId || userId === "admin") {
      return jsonError(c, 400, "INVALID_USER", "Invalid user for journal entry");
    }

    const entry = {
      id: makeId("jrn"),
      userId,
      content: parsed.data.content,
      tags: serializeTags(parsed.data.tags),
      createdAt: nowIso(),
    };

    await db.insert(journal).values(entry).run();
    return c.json({ ...entry, tags: deserializeTags(entry.tags) }, 201);
  }),
);

router.get(
  "/",
  withErrorHandling(async (c) => {
    const parsed = parseQuery(c, paginationQuerySchema);
    if (!parsed.success) return parsed.response;

    const userId = c.get("userId");
    if (!userId || userId === "admin") {
      return jsonError(c, 400, "INVALID_USER", "Invalid user for journal listing");
    }

    const q = c.req.query("q")?.trim();
    const tagsQuery = c.req.query("tags")?.trim();
    const tagSet = tagsQuery ? new Set(tagsQuery.split(",").map((t) => t.trim()).filter(Boolean)) : null;

    let rows = await db.select().from(journal).where(eq(journal.userId, userId)).orderBy(desc(journal.createdAt)).all();

    if (q) {
      const lowered = q.toLowerCase();
      rows = rows.filter(
        (row) =>
          row.content.toLowerCase().includes(lowered) ||
          deserializeTags(row.tags).some((tag) => tag.toLowerCase().includes(lowered)),
      );
    }

    if (tagSet) {
      rows = rows.filter((row) => deserializeTags(row.tags).some((tag) => tagSet.has(tag)));
    }

    const paginated = rows.slice(parsed.data.offset, parsed.data.offset + parsed.data.limit);
    return c.json({
      entries: paginated.map((entry) => ({ ...entry, tags: deserializeTags(entry.tags) })),
    });
  }),
);

export { router as journalRoutes };
