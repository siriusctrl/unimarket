import { afterEach, describe, expect, it, vi } from "vitest";

const makeContext = (header?: string) => {
  return {
    req: {
      header: vi.fn((name: string) => (name === "idempotency-key" ? header : undefined)),
      method: "post",
      path: "/orders",
    },
    json: (body: unknown, status: number) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  };
};

const loadModule = async (existing: unknown) => {
  vi.resetModules();

  const selectGet = vi.fn().mockResolvedValue(existing);
  const insertRun = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoNothing: () => ({ run: insertRun }) }));
  const insert = vi.fn(() => ({ values }));

  vi.doMock("../src/db/client.js", () => ({
    db: {
      select: () => ({ from: () => ({ where: () => ({ get: selectGet }) }) }),
      insert,
    },
  }));

  vi.doMock("../src/platform/errors.js", () => ({
    jsonError: (_c: unknown, status: number, code: string, message: string) =>
      new Response(JSON.stringify({ error: { code, message } }), {
        status,
        headers: { "content-type": "application/json" },
      }),
  }));

  vi.doMock("../src/utils.js", () => ({
    makeId: () => "idem_1",
    nowIso: () => "2026-03-07T00:00:00.000Z",
  }));

  const mod = await import("../src/platform/idempotency.js");
  return { ...mod, selectGet, insert, values, insertRun };
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("idempotency", () => {
  it("returns none when the header is missing", async () => {
    const { checkIdempotency } = await loadModule(undefined);
    const result = await checkIdempotency(makeContext() as never, "usr_1", { amount: 1 });
    expect(result).toEqual({ kind: "none" });
  });

  it("rejects blank and overly long headers", async () => {
    const { checkIdempotency } = await loadModule(undefined);

    const blank = await checkIdempotency(makeContext("   ") as never, "usr_1", { amount: 1 });
    expect(blank.kind).toBe("invalid");
    expect(blank.response.status).toBe(400);

    const longHeader = await checkIdempotency(makeContext("x".repeat(129)) as never, "usr_1", { amount: 1 });
    expect(longHeader.kind).toBe("invalid");
    expect(longHeader.response.status).toBe(400);
  });

  it("returns a store candidate when no existing idempotency row is found", async () => {
    const { checkIdempotency, selectGet } = await loadModule(undefined);
    const result = await checkIdempotency(makeContext("idem-1") as never, "usr_1", { amount: 1 });

    expect(selectGet).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      kind: "store",
      candidate: {
        userId: "usr_1",
        key: "idem-1",
        method: "POST",
        path: "/orders",
      },
    });
  });

  it("rejects conflicting payloads and unreplayable stored bodies", async () => {
    const seed = await loadModule(undefined);
    const store = await seed.checkIdempotency(makeContext("idem-1") as never, "usr_1", { amount: 1 });
    if (store.kind !== "store") throw new Error("expected store candidate");

    const { checkIdempotency } = await loadModule({
      userId: "usr_1",
      key: "idem-1",
      method: "POST",
      path: "/orders",
      requestHash: "other",
      responseBody: JSON.stringify({ ok: true }),
      status: 200,
    });

    const conflict = await checkIdempotency(makeContext("idem-1") as never, "usr_1", { amount: 1 });
    expect(conflict.kind).toBe("invalid");
    expect(conflict.response.status).toBe(409);

    const invalidReplayModule = await loadModule({
      userId: store.candidate.userId,
      key: store.candidate.key,
      method: store.candidate.method,
      path: store.candidate.path,
      requestHash: store.candidate.requestHash,
      responseBody: "{bad json",
      status: 200,
    });

    const invalidReplay = await invalidReplayModule.checkIdempotency(makeContext("idem-1") as never, "usr_1", { amount: 1 });
    expect(invalidReplay.kind).toBe("invalid");
    expect(invalidReplay.response.status).toBe(409);
  });

  it("replays a stored response and marks the replay header", async () => {
    const seed = await loadModule(undefined);
    const store = await seed.checkIdempotency(makeContext("idem-1") as never, "usr_1", { amount: 1 });
    if (store.kind !== "store") throw new Error("expected store candidate");

    const { checkIdempotency } = await loadModule({
      userId: store.candidate.userId,
      key: store.candidate.key,
      method: store.candidate.method,
      path: store.candidate.path,
      requestHash: store.candidate.requestHash,
      responseBody: JSON.stringify({ ok: true }),
      status: 201,
    });

    const replay = await checkIdempotency(makeContext("idem-1") as never, "usr_1", { amount: 1 });
    expect(replay.kind).toBe("replay");
    expect(replay.response.status).toBe(201);
    expect(replay.response.headers.get("x-idempotent-replay")).toBe("true");
    await expect(replay.response.json()).resolves.toEqual({ ok: true });
  });

  it("stores successful responses and skips 5xx responses", async () => {
    const { storeIdempotencyResponse, insertRun } = await loadModule(undefined);
    const candidate = {
      userId: "usr_1",
      key: "idem-1",
      method: "POST",
      path: "/orders",
      requestHash: "hash",
    };

    await storeIdempotencyResponse(candidate, 503, { ok: false });
    expect(insertRun).not.toHaveBeenCalled();

    await storeIdempotencyResponse(candidate, 201, { ok: true });
    expect(insertRun).toHaveBeenCalledTimes(1);
  });
});
