import { INITIAL_BALANCE, registerSchema } from "@unimarket/core";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";

import type { AppVariables } from "../platform/auth.js";
import { db } from "../db/client.js";
import { accounts, apiKeys, users } from "../db/schema.js";
import { jsonError } from "../platform/errors.js";
import { parseJson, withErrorHandling } from "../platform/helpers.js";
import { createApiKey, hashApiKey, keyPrefix, makeId, nowIso } from "../utils.js";

const auth = new Hono<{ Variables: AppVariables }>();

auth.post(
  "/register",
  withErrorHandling(async (c) => {
    const parsed = await parseJson(c, registerSchema);
    if (!parsed.success) return parsed.response;

    const createdAt = nowIso();
    const userId = makeId("usr");
    const accountId = makeId("acc");
    const keyId = makeId("key");
    const apiKey = createApiKey();
    const userName = parsed.data.userName;

    await db.insert(users).values({ id: userId, name: userName, createdAt }).run();

    await db
      .insert(apiKeys)
      .values({
        id: keyId,
        userId,
        keyHash: hashApiKey(apiKey),
        prefix: keyPrefix(apiKey),
        createdAt,
        revokedAt: null,
      })
      .run();

    await db
      .insert(accounts)
      .values({
        id: accountId,
        userId,
        balance: INITIAL_BALANCE,
        name: `${userName}-main`,
        reasoning: "Initial account created at registration",
        createdAt,
      })
      .run();

    return c.json(
      {
        userId,
        apiKey,
        account: { id: accountId, balance: INITIAL_BALANCE, createdAt },
      },
      201,
    );
  }),
);

auth.post(
  "/keys",
  withErrorHandling(async (c) => {
    const userId = c.get("userId");
    if (!userId || userId === "admin") {
      return jsonError(c, 400, "INVALID_USER", "Admin user cannot create API keys in this endpoint");
    }

    const apiKey = createApiKey();
    const createdAt = nowIso();
    const keyId = makeId("key");

    await db
      .insert(apiKeys)
      .values({
        id: keyId,
        userId,
        keyHash: hashApiKey(apiKey),
        prefix: keyPrefix(apiKey),
        createdAt,
        revokedAt: null,
      })
      .run();

    return c.json({ id: keyId, apiKey, prefix: keyPrefix(apiKey) }, 201);
  }),
);

auth.delete(
  "/keys/:id",
  withErrorHandling(async (c) => {
    const userId = c.get("userId");
    if (!userId || userId === "admin") {
      return jsonError(c, 400, "INVALID_USER", "Admin user cannot revoke via this endpoint");
    }

    const keyId = c.req.param("id");
    const updated = await db
      .update(apiKeys)
      .set({ revokedAt: nowIso() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId), isNull(apiKeys.revokedAt)))
      .run();

    if (updated.rowsAffected === 0) {
      return jsonError(c, 404, "KEY_NOT_FOUND", "API key not found");
    }

    return c.json({ revoked: true });
  }),
);

export { auth };
