import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import type { AppVariables } from "./auth.js";
import { db } from "../db/client.js";
import { idempotencyKeys } from "../db/schema.js";
import { jsonError } from "./errors.js";
import { makeId, nowIso } from "../utils.js";

const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

type AppContext = Context<{ Variables: AppVariables }>;

export type IdempotencyStoreCandidate = {
  userId: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
};

const computeRequestHash = (payload: unknown): string => {
  const serialized = JSON.stringify(payload);
  return createHash("sha256").update(serialized).digest("hex");
};

const parseStoredResponse = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const checkIdempotency = async (
  c: AppContext,
  userId: string,
  payload: unknown,
): Promise<
  | { kind: "none" }
  | { kind: "store"; candidate: IdempotencyStoreCandidate }
  | { kind: "replay"; response: Response }
  | { kind: "invalid"; response: Response }
> => {
  const rawHeader = c.req.header("idempotency-key");
  if (rawHeader === undefined) {
    return { kind: "none" };
  }

  const key = rawHeader.trim();
  if (key.length === 0) {
    return {
      kind: "invalid",
      response: jsonError(c, 400, "INVALID_INPUT", "Idempotency-Key must be a non-empty string"),
    };
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return {
      kind: "invalid",
      response: jsonError(c, 400, "INVALID_INPUT", `Idempotency-Key must be <= ${MAX_IDEMPOTENCY_KEY_LENGTH} chars`),
    };
  }

  const candidate: IdempotencyStoreCandidate = {
    userId,
    key,
    method: c.req.method.toUpperCase(),
    path: c.req.path,
    requestHash: computeRequestHash(payload),
  };

  const existing = await db
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, candidate.userId),
        eq(idempotencyKeys.key, candidate.key),
        eq(idempotencyKeys.method, candidate.method),
        eq(idempotencyKeys.path, candidate.path),
      ),
    )
    .get();

  if (!existing) {
    return { kind: "store", candidate };
  }

  if (existing.requestHash !== candidate.requestHash) {
    return {
      kind: "invalid",
      response: jsonError(
        c,
        409,
        "IDEMPOTENCY_KEY_CONFLICT",
        "Idempotency-Key was already used with a different request payload",
      ),
    };
  }

  const body = parseStoredResponse(existing.responseBody);
  if (body === null) {
    return {
      kind: "invalid",
      response: jsonError(c, 409, "IDEMPOTENCY_KEY_CONFLICT", "Unable to replay stored idempotent response"),
    };
  }

  const replay = c.json(body, existing.status as 200);
  replay.headers.set("x-idempotent-replay", "true");
  return { kind: "replay", response: replay };
};

export const storeIdempotencyResponse = async (
  candidate: IdempotencyStoreCandidate,
  status: number,
  body: unknown,
): Promise<void> => {
  if (status >= 500) {
    return;
  }

  await db
    .insert(idempotencyKeys)
    .values({
      id: makeId("idem"),
      userId: candidate.userId,
      key: candidate.key,
      method: candidate.method,
      path: candidate.path,
      requestHash: candidate.requestHash,
      status,
      responseBody: JSON.stringify(body),
      createdAt: nowIso(),
    })
    .onConflictDoNothing()
    .run();
};

