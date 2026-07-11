import { createServer } from "node:http";
import { chromium } from "playwright";

import { renderAnalysis } from "./render.js";
import { parseRenderRequest } from "./request.js";

const port = Number(process.env.PORT ?? 3101);
const webBaseUrl = process.env.UNIMARKET_WEB_BASE_URL ?? "http://127.0.0.1:5173";
const browser = await chromium.launch({ headless: true });

const json = (response: import("node:http").ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
};

const server = createServer(async (request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, { ok: true, service: "unimarket-analysis-renderer", webBaseUrl });
    return;
  }
  if (request.method !== "GET" || url.pathname !== "/render") {
    json(response, 404, { error: { code: "NOT_FOUND", message: "Use GET /render" } });
    return;
  }

  try {
    const result = await renderAnalysis(browser, webBaseUrl, parseRenderRequest(url));
    const encodedMetadata = Buffer.from(JSON.stringify(result.metadata)).toString("base64url");
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": result.image.length,
      "cache-control": "no-store",
      "x-unimarket-render-metadata": encodedMetadata,
      "x-unimarket-drawing-count": String(result.metadata.renderedDrawingIds.length),
      "x-unimarket-candle-hash": result.metadata.candleHash ?? ""
    });
    response.end(result.image);
  } catch (error) {
    json(response, 400, {
      error: {
        code: "RENDER_FAILED",
        message: error instanceof Error ? error.message : "Unknown render failure"
      }
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Analysis renderer listening on http://0.0.0.0:${port}`);
});

const close = async () => {
  server.close();
  await browser.close();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
