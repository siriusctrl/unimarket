import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

type AppLike = {
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};

const dbFilePath = join(tmpdir(), `paper-trade-test-${randomUUID()}.sqlite`);
process.env.DB_URL = `file:${dbFilePath}`;
process.env.ADMIN_API_KEY = "admin_test_key";

let app: AppLike;

beforeAll(async () => {
  const [{ createApp }, { migrate }] = await Promise.all([import("../src/app.js"), import("../src/db/client.js")]);
  await migrate();
  app = createApp();
});

afterAll(async () => {
  await rm(dbFilePath, { force: true });
  await rm(`${dbFilePath}-wal`, { force: true });
  await rm(`${dbFilePath}-shm`, { force: true });
});

describe("api integration", () => {
  it("serves health and openapi without auth", async () => {
    const healthResponse = await app.request("/health");
    expect(healthResponse.status).toBe(200);
    const healthPayload = await healthResponse.json();
    expect(healthPayload.status).toBe("ok");

    const openApiResponse = await app.request("/openapi.json");
    expect(openApiResponse.status).toBe(200);
    const openApi = await openApiResponse.json();
    expect(openApi.openapi).toBe("3.1.0");
    expect(openApi.paths["/api/orders"]).toBeDefined();
  });

  it("enforces reasoning on account/order cancel flows and exposes timeline", async () => {
    const registerResponse = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "integration-agent" }),
    });

    expect(registerResponse.status).toBe(201);
    const registerPayload = await registerResponse.json();

    const apiKey = registerPayload.apiKey as string;
    const accountId = registerPayload.account.id as string;

    const missingReasoningAccount = await app.request("/api/accounts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "no-reasoning-account" }),
    });

    expect(missingReasoningAccount.status).toBe(400);
    const missingReasoningAccountPayload = await missingReasoningAccount.json();
    expect(missingReasoningAccountPayload.error.code).toBe("REASONING_REQUIRED");

    const createAccountResponse = await app.request("/api/accounts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "strategy-account",
        reasoning: "Separate account for integration test strategy",
      }),
    });

    expect(createAccountResponse.status).toBe(201);

    const createLimitOrderResponse = await app.request("/api/orders", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        accountId,
        market: "polymarket",
        symbol: "0x-test-symbol",
        side: "buy",
        type: "limit",
        quantity: 10,
        limitPrice: 0.4,
        reasoning: "Test pending order for cancellation flow",
      }),
    });

    expect(createLimitOrderResponse.status).toBe(201);
    const orderPayload = await createLimitOrderResponse.json();
    expect(orderPayload.status).toBe("pending");

    const cancelWithoutReasoning = await app.request(`/api/orders/${orderPayload.id as string}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(cancelWithoutReasoning.status).toBe(400);
    const cancelWithoutReasoningPayload = await cancelWithoutReasoning.json();
    expect(cancelWithoutReasoningPayload.error.code).toBe("REASONING_REQUIRED");

    const cancelWithReasoning = await app.request(`/api/orders/${orderPayload.id as string}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ reasoning: "Market thesis changed" }),
    });

    expect(cancelWithReasoning.status).toBe(200);

    const journalResponse = await app.request("/api/journal", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: "Tracking market sentiment drift",
        tags: ["analysis", "integration-test"],
      }),
    });

    expect(journalResponse.status).toBe(201);

    const timelineResponse = await app.request(`/api/accounts/${accountId}/timeline?limit=20&offset=0`, {
      headers: {
        authorization: `Bearer ${apiKey}`,
      },
    });

    expect(timelineResponse.status).toBe(200);
    const timelinePayload = await timelineResponse.json();

    expect(Array.isArray(timelinePayload.events)).toBe(true);
    expect(timelinePayload.events.some((event: unknown) => {
      if (typeof event !== "object" || event === null) {
        return false;
      }
      const typed = event as { type?: string };
      return typed.type === "order_cancelled";
    })).toBe(true);
    expect(timelinePayload.events.some((event: unknown) => {
      if (typeof event !== "object" || event === null) {
        return false;
      }
      const typed = event as { type?: string };
      return typed.type === "journal";
    })).toBe(true);
  });
});
