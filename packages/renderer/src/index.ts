import { createServer } from "node:http";
import { chromium } from "playwright";

import { inspectAnalysis, renderAnalysis } from "./render.js";
import { parseRenderRequest, type AnalysisRenderRequest } from "./request.js";

const port = Number(process.env.PORT ?? 3101);
const host = process.env.HOST ?? "127.0.0.1";
const webBaseUrl = process.env.UNIMARKET_WEB_BASE_URL ?? "http://127.0.0.1:5173";
const maxConcurrentRenders = Number(process.env.UNIMARKET_RENDER_CONCURRENCY ?? 2);
if (!Number.isInteger(maxConcurrentRenders) || maxConcurrentRenders < 1) {
  throw new Error("UNIMARKET_RENDER_CONCURRENCY must be a positive integer");
}
let browser = await chromium.launch({ headless: true });
let activeRenders = 0;

const getBrowser = async () => {
  if (!browser.isConnected()) browser = await chromium.launch({ headless: true });
  return browser;
};

const json = (response: import("node:http").ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
};

const server = createServer(async (request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    const connected = browser.isConnected();
    json(response, connected ? 200 : 503, {
      ok: connected,
      service: "unimarket-analysis-renderer",
      webBaseUrl,
      activeRenders,
      maxConcurrentRenders,
    });
    return;
  }
  if (request.method !== "GET" || (url.pathname !== "/render" && url.pathname !== "/inspect")) {
    json(response, 404, { error: { code: "NOT_FOUND", message: "Use GET /render or GET /inspect" } });
    return;
  }

  let parsed: AnalysisRenderRequest;
  try {
    parsed = parseRenderRequest(url);
  } catch (error) {
    json(response, 400, {
      error: { code: "INVALID_RENDER_REQUEST", message: error instanceof Error ? error.message : "Invalid render request" },
    });
    return;
  }
  if (activeRenders >= maxConcurrentRenders) {
    json(response, 429, { error: { code: "RENDER_BUSY", message: "Renderer concurrency limit reached" } });
    return;
  }

  activeRenders += 1;
  try {
    const activeBrowser = await getBrowser();
    if (url.pathname === "/inspect") {
      json(response, 200, await inspectAnalysis(activeBrowser, webBaseUrl, parsed));
      return;
    }
    const result = await renderAnalysis(activeBrowser, webBaseUrl, parsed);
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": result.image.length,
      "cache-control": "no-store",
      "x-unimarket-annotation-count": String(result.metadata.annotationCount),
      "x-unimarket-drawing-count": String(result.metadata.renderedDrawingIds.length),
      "x-unimarket-visible-drawing-count": String(result.metadata.visibleDrawingIds.length),
      "x-unimarket-clipped-drawing-count": String(result.metadata.clippedDrawingIds.length),
      "x-unimarket-profile-bin-count": String(result.metadata.renderedProfileBins),
      "x-unimarket-candle-hash": result.metadata.candleHash ?? "",
    });
    response.end(result.image);
  } catch (error) {
    json(response, 502, {
      error: {
        code: "RENDER_FAILED",
        message: error instanceof Error ? error.message : "Unknown render failure",
      },
    });
  } finally {
    activeRenders -= 1;
  }
});

server.listen(port, host, () => {
  console.log(`Analysis renderer listening on http://${host}:${port}`);
});

const close = async () => {
  server.close();
  if (browser.isConnected()) await browser.close();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
