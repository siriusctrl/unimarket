import { listPositionsQuerySchema } from "@unimarket/core";
import { asc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";

import type { AppVariables } from "../auth.js";
import { db } from "../db/client.js";
import { accounts, positions } from "../db/schema.js";
import { jsonError } from "../errors.js";
import { getUserAccount, parseQuery, withErrorHandling } from "../helpers.js";

const router = new Hono<{ Variables: AppVariables }>();

router.get(
  "/",
  withErrorHandling(async (c) => {
    const parsed = parseQuery(c, listPositionsQuerySchema);
    if (!parsed.success) return parsed.response;

    const userId = c.get("userId");
    let rows;

    if (userId === "admin") {
      if (parsed.data.userId) {
        const accountIds = (
          await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, parsed.data.userId)).all()
        ).map((item) => item.id);
        if (accountIds.length === 0) return c.json({ positions: [] });
        rows = await db.select().from(positions).where(inArray(positions.accountId, accountIds)).orderBy(asc(positions.market), asc(positions.symbol)).all();
      } else {
        rows = await db.select().from(positions).orderBy(asc(positions.market), asc(positions.symbol)).all();
      }
    } else {
      const account = await getUserAccount(userId);
      if (!account) return jsonError(c, 404, "ACCOUNT_NOT_FOUND", "Account not found");
      rows = await db.select().from(positions).where(eq(positions.accountId, account.id)).orderBy(asc(positions.market), asc(positions.symbol)).all();
    }

    return c.json({ positions: rows });
  }),
);

export { router as positionsRoutes };
