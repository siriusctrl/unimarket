import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { stopProcessGroup, waitForServer } from "./lib/browser-server.mjs";
import { buildMuAnalysis } from "./lib/mu-analysis.mjs";

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.join(root, "artifacts", "analysis", stamp);
const dbPath = path.join(outputDir, "mu-live.sqlite");
const apiPort = 43180;
const webPort = 43181;
const rendererPort = 43182;
const apiBase = `http://127.0.0.1:${apiPort}`;
const webBase = `http://127.0.0.1:${webPort}`;
const rendererBase = `http://127.0.0.1:${rendererPort}`;
mkdirSync(outputDir, { recursive: true });

const startService = (name, args, env) => {
  const log = openSync(path.join(outputDir, `${name}.log`), "w");
  try {
    return spawn("corepack", args, {
      cwd: root,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, ...env },
    });
  } finally {
    closeSync(log);
  }
};

const api = startService("api", ["pnpm", "--filter", "@unimarket/api", "exec", "tsx", "src/index.ts"], {
  DB_URL: `file:${dbPath}`,
  PORT: String(apiPort),
});
let web;
let renderer;

const jsonRequest = async (url, init = {}) => {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${url}: ${JSON.stringify(payload)}`);
  return payload;
};

const numericHeader = (response, name) => {
  const raw = response.headers.get(name);
  if (raw === null) throw new Error(`Renderer response omitted ${name}`);
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`Renderer response returned an invalid ${name}`);
  return value;
};

try {
  await waitForServer(`${apiBase}/health`);
  const registration = await jsonRequest(`${apiBase}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userName: `mu-visual-verifier-${Date.now()}` }),
  });
  const context = await jsonRequest(
    `${apiBase}/api/analysis/context?market=hyperliquid&reference=xyz%3AMU&interval=1d&lookback=1y`,
  );
  const candles = context.data.candles;
  const { document, viewportCandles, support } = buildMuAnalysis(context, `mu-live-${stamp}`);
  const authorization = { authorization: `Bearer ${registration.apiKey}`, "content-type": "application/json" };
  const created = await jsonRequest(`${apiBase}/api/analysis/documents`, {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({ document, reasoning: "Generate a live MU document for browser verification" }),
  });

  web = startService("web", ["pnpm", "--filter", "@unimarket/web", "exec", "vite", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
    UNIMARKET_API_PROXY: apiBase,
  });
  await waitForServer(webBase);
  renderer = startService("renderer", ["pnpm", "--filter", "@unimarket/renderer", "start"], {
    PORT: String(rendererPort),
    UNIMARKET_WEB_BASE_URL: webBase,
  });
  await waitForServer(`${rendererBase}/health`);
  const renderUrl = new URL("/render", rendererBase);
  renderUrl.searchParams.set("market", "hyperliquid");
  renderUrl.searchParams.set("reference", "xyz:MU");
  renderUrl.searchParams.set("documentId", created.id);
  renderUrl.searchParams.set("scope", "page");
  const renderResponse = await fetch(renderUrl);
  if (!renderResponse.ok) throw new Error(`Renderer failed: ${renderResponse.status} ${await renderResponse.text()}`);
  const candleHash = renderResponse.headers.get("x-unimarket-candle-hash");
  const annotationCount = numericHeader(renderResponse, "x-unimarket-annotation-count");
  const renderedDrawingCount = numericHeader(renderResponse, "x-unimarket-drawing-count");
  const visibleDrawingCount = numericHeader(renderResponse, "x-unimarket-visible-drawing-count");
  const clippedDrawingCount = numericHeader(renderResponse, "x-unimarket-clipped-drawing-count");
  const renderedProfileBins = numericHeader(renderResponse, "x-unimarket-profile-bin-count");
  if (candleHash !== context.data.snapshotHash) {
    throw new Error("Renderer image used a different candle snapshot");
  }
  if (annotationCount !== 3 || renderedDrawingCount !== 3) {
    throw new Error(`Expected 3 live MU drawings, got annotationCount=${annotationCount}, rendered=${renderedDrawingCount}`);
  }
  if (visibleDrawingCount !== 3 || clippedDrawingCount !== 0) {
    throw new Error(`Expected all live MU drawings to intersect the focused viewport, visible=${visibleDrawingCount}, clipped=${clippedDrawingCount}`);
  }
  if (renderedProfileBins < 8) throw new Error(`Expected a rendered MU volume profile, got ${renderedProfileBins} bins`);

  const screenshotPath = path.join(outputDir, "mu-live-analysis.png");
  writeFileSync(screenshotPath, Buffer.from(await renderResponse.arrayBuffer()));
  const published = await jsonRequest(`${apiBase}/api/analysis/documents/${created.id}/publish`, {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({ reasoning: "Publish only after the exact draft rendered successfully through the image service" }),
  });
  writeFileSync(path.join(outputDir, "mu-live-analysis.json"), `${JSON.stringify(published, null, 2)}\n`);
  writeFileSync(path.join(outputDir, "verification.json"), `${JSON.stringify({
    market: "hyperliquid",
    reference: "xyz:MU",
    candleCount: candles.length,
    firstCandle: candles[0].timestamp,
    lastCandle: candles.at(-1).timestamp,
    snapshotHash: context.data.snapshotHash,
    analysisId: created.id,
    renderedStatus: created.status,
    finalStatus: published.status,
    annotationCount,
    renderedDrawingCount,
    visibleDrawingCount,
    clippedDrawingCount,
    renderedProfileBins,
    viewportCandleCount: viewportCandles.length,
    viewportFrom: viewportCandles[0].timestamp,
    supportAnchors: [support.first.candle.timestamp, support.second.candle.timestamp],
    projectedSupport: support.projected,
    supportViolations: support.violations,
    rendererUrl: renderUrl.toString(),
    screenshotPath,
  }, null, 2)}\n`);
  console.log(`MU live candles: ${candles.length}`);
  console.log(`MU live analysis screenshot: ${screenshotPath}`);
  console.log(`MU live verification: ${path.join(outputDir, "verification.json")}`);
} catch (error) {
  console.error(`MU live verification failed; service logs are in ${outputDir}`);
  throw error;
} finally {
  if (renderer) stopProcessGroup(renderer);
  if (web) stopProcessGroup(web);
  stopProcessGroup(api);
  for (const suffix of ["-shm", "-wal"]) rmSync(`${dbPath}${suffix}`, { force: true });
}
