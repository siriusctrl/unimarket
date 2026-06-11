import { paginationQuerySchema } from "@unimarket/core";
import type { MarketRegistry } from "@unimarket/markets";
import { Hono } from "hono";

import type { AppVariables } from "../platform/auth.js";
import { buildAdminOverviewModel } from "../services/admin-overview.js";
import { buildEquityHistoryModel } from "../services/equity-history.js";
import { buildTimelineEvents } from "../timeline.js";
import { getUserAccountScope, parseQuery, requireUserRecord, withErrorHandling } from "../platform/helpers.js";

export const createDashboardRoutes = (registry: MarketRegistry) => {
  const router = new Hono<{ Variables: AppVariables }>();

  router.get(
    "/overview",
    withErrorHandling(async (c) => {
      return c.json(await buildAdminOverviewModel({ registry }));
    }),
  );

  router.get(
    "/equity-history",
    withErrorHandling(async (c) => {
      return c.json(await buildEquityHistoryModel(c.req.query("range") ?? "1m"));
    }),
  );

  router.get(
    "/users/:id/timeline",
    withErrorHandling(async (c) => {
      const userId = c.req.param("id");
      const userResult = await requireUserRecord(c, userId);
      if (!userResult.success) return userResult.response;

      const parsedQuery = parseQuery(c, paginationQuerySchema);
      if (!parsedQuery.success) return parsedQuery.response;

      const accountScope = await getUserAccountScope(userId);
      const events = await buildTimelineEvents({
        registry,
        userId,
        accountId: accountScope.account?.id ?? null,
        limit: parsedQuery.data.limit,
        offset: parsedQuery.data.offset,
      });

      return c.json({ events });
    }),
  );

  return router;
};
