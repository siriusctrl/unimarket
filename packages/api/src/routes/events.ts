import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { AppVariables } from "../platform/auth.js";
import { jsonError } from "../platform/errors.js";
import { ALL_EVENTS_SUBSCRIBER, eventBus, type SequencedTradingEvent } from "../platform/events.js";
import { nowIso } from "../utils.js";
import { API_VERSION } from "../version.js";

const router = new Hono<{ Variables: AppVariables }>();

const parseEventCursor = (raw: string | undefined): number | null | "invalid" => {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "invalid";
  if (!/^\d+$/.test(trimmed)) return "invalid";

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return "invalid";
  return parsed;
};

router.get("/", (c) => {
  const userId = c.get("userId");
  if (!userId) return jsonError(c, 401, "UNAUTHORIZED", "Missing user identity");

  const subscriptionKey = c.get("isAdmin") ? ALL_EVENTS_SUBSCRIBER : userId;
  const cursorRaw = c.req.query("since") ?? c.req.header("last-event-id");
  const sinceEventId = parseEventCursor(cursorRaw);
  if (sinceEventId === "invalid") {
    return jsonError(c, 400, "INVALID_INPUT", "Invalid SSE cursor. Use a positive integer for since/Last-Event-ID");
  }

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: "system.ready",
      data: JSON.stringify({ type: "system.ready", data: { version: API_VERSION, connectedAt: nowIso() } }),
    });

    const deliveredEventIds = new Set<string>();
    const writeEvent = (event: SequencedTradingEvent) => {
      if (deliveredEventIds.has(event.id)) {
        return;
      }
      deliveredEventIds.add(event.id);
      void stream.writeSSE({
        id: event.id,
        data: JSON.stringify(event),
      });
    };

    const onEvent = (event: SequencedTradingEvent) => {
      writeEvent(event);
    };

    const unsubscribe = eventBus.subscribe(subscriptionKey, onEvent);
    if (sinceEventId !== null) {
      const replayEvents = eventBus.replay(subscriptionKey, sinceEventId);
      for (const replayEvent of replayEvents) {
        writeEvent(replayEvent);
      }
    }

    let cleaned = false;

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      unsubscribe();
      c.req.raw.signal.removeEventListener("abort", handleAbort);
    };

    const handleAbort = () => {
      cleanup();
      stream.abort();
    };

    c.req.raw.signal.addEventListener("abort", handleAbort, { once: true });

    stream.onAbort(cleanup);
    await new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
    });
  });
});

export { router as eventsRoutes };
