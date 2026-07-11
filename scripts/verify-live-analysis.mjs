import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { stopProcessGroup, waitForServer } from "./lib/browser-server.mjs";

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

const api = spawn("corepack", ["pnpm", "--filter", "@unimarket/api", "exec", "tsx", "src/index.ts"], {
  cwd: root,
  detached: true,
  stdio: "ignore",
  env: { ...process.env, DB_URL: `file:${dbPath}`, PORT: String(apiPort) },
});
let web;
let renderer;

const jsonRequest = async (url, init = {}) => {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${url}: ${JSON.stringify(payload)}`);
  return payload;
};

const selectViewportStartIndex = (candles) => {
  const earliest = Math.max(0, candles.length - 90);
  const latest = Math.max(0, candles.length - 55);
  let breakoutIndex = earliest;
  let largestMove = 0;
  for (let index = Math.max(1, earliest); index < candles.length; index += 1) {
    const move = Math.abs((candles[index].close / candles[index - 1].close) - 1);
    if (move > largestMove) {
      largestMove = move;
      breakoutIndex = index;
    }
  }
  return Math.max(earliest, Math.min(latest, breakoutIndex - 8));
};

const selectRecentSupport = (candles, viewportStartIndex) => {
  const pivots = candles.flatMap((candle, index) => {
    if (index < viewportStartIndex + 2 || index >= candles.length - 2) return [];
    const neighborhood = candles.slice(index - 2, index + 3);
    return neighborhood.every((candidate) => candle.low <= candidate.low) ? [{ candle, index }] : [];
  });
  const latest = candles.at(-1);
  const candidates = pivots.flatMap((first, firstIndex) => pivots.slice(firstIndex + 1).flatMap((second) => {
    const span = second.index - first.index;
    if (span < 8 || span > 45 || second.candle.low <= first.candle.low) return [];
    const slope = (second.candle.low - first.candle.low) / span;
    const projected = second.candle.low + slope * (candles.length - 1 - second.index);
    if (projected > latest.low * 1.01 || projected < latest.close * 0.65) return [];
    const violations = candles.slice(first.index).filter((candle, offset) => {
      const support = first.candle.low + slope * offset;
      return candle.low < support * 0.98;
    }).length;
    const distance = (latest.close - projected) / latest.close;
    const age = candles.length - 1 - second.index;
    const score = violations * 100 + distance * 20 + age * 0.04 + Math.abs(span - 22) * 0.03;
    return [{ first, second, slope, projected, violations, score }];
  }));
  if (candidates.length > 0) return candidates.sort((left, right) => left.score - right.score)[0];

  const focused = candles.slice(viewportStartIndex);
  const midpoint = Math.floor(focused.length / 2);
  const lowest = (rows, offset) => rows.reduce((best, candle, index) =>
    candle.low < best.candle.low ? { candle, index: offset + index } : best,
  { candle: rows[0], index: offset });
  const first = lowest(focused.slice(0, midpoint), viewportStartIndex);
  const second = lowest(focused.slice(midpoint), viewportStartIndex + midpoint);
  const slope = (second.candle.low - first.candle.low) / (second.index - first.index);
  const projected = second.candle.low + slope * (candles.length - 1 - second.index);
  return { first, second, slope, projected, violations: 0, score: Number.POSITIVE_INFINITY };
};

const quantile = (values, percentile) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile))];
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
  if (context.data.candles.length < 40) throw new Error(`MU live history returned only ${context.data.candles.length} candles`);

  const candles = context.data.candles;
  const viewportStartIndex = selectViewportStartIndex(candles);
  const viewportCandles = candles.slice(viewportStartIndex);
  const support = selectRecentSupport(candles, viewportStartIndex);
  const recent = candles.slice(-35);
  const supplyHigh = Math.max(...recent.map((candle) => candle.high));
  const supplyLow = quantile(recent.map((candle) => candle.high), 0.82);
  const supplyStart = recent.find((candle) => candle.high >= supplyLow) ?? recent[0];
  const invalidation = support.projected * 0.98;
  if (support.slope <= 0 || support.projected > candles.at(-1).low * 1.01) {
    throw new Error("MU live data did not produce a valid, unbroken rising support candidate in the focused window");
  }
  const now = new Date().toISOString();
  const document = {
    schema: "unimarket.chart-analysis/v1",
    title: "MU live daily structure",
    instrument: { market: "hyperliquid", reference: "xyz:MU", displayName: "MU perpetual on XYZ" },
    data: {
      interval: context.data.interval,
      from: context.data.range.startTime,
      to: context.data.range.endTime,
      asOf: context.data.range.asOf,
      snapshotHash: context.data.snapshotHash,
    },
    viewport: {
      from: viewportCandles[0].timestamp,
      to: context.data.range.endTime,
      priceScale: "auto",
    },
    thesis: "The focused post-breakout window shows a recent sequence of higher pivot lows below an overhead supply zone; the full one-year history remains available as context but does not define the active trend slope.",
    invalidation: `A daily close below ${invalidation.toFixed(2)} invalidates the focused rising-support candidate.`,
    layers: [
      {
        id: "live-rising-support",
        type: "trendLine",
        anchors: [
          { time: support.first.candle.timestamp, price: support.first.candle.low },
          { time: support.second.candle.timestamp, price: support.second.candle.low },
        ],
        extend: { left: false, right: true },
        label: "Recent pivot support",
        rationale: `Connects two higher local lows inside the focused ${viewportCandles.length}-session regime; projected support remains below the latest candle.`,
        confidence: 0.74,
        style: { color: "support", width: 2, lineStyle: "solid", opacity: 0.92 },
      },
      {
        id: "live-supply-zone",
        type: "rectangle",
        anchors: [
          { time: supplyStart.timestamp, price: supplyLow },
          { time: context.data.range.endTime, price: supplyHigh },
        ],
        fillOpacity: 0.08,
        label: "Recent supply",
        labelPlacement: { at: "middle", offsetX: -30, offsetY: -6 },
        rationale: "Marks the upper distribution of highs from the latest thirty-five sessions instead of forcing a parallel channel through an explosive repricing.",
        confidence: 0.7,
        style: { color: "resistance", width: 1, lineStyle: "solid", opacity: 0.72 },
      },
      {
        id: "live-invalidation",
        type: "horizontalLine",
        price: invalidation,
        label: "Structure invalidation",
        rationale: "Places invalidation just below the projected recent support rather than below an unrelated annual low.",
        confidence: 0.76,
        style: { color: "warning", width: 1, lineStyle: "dotted", opacity: 0.8 },
      },
      { id: "sma-20", type: "sma", period: 20 },
      { id: "ema-50", type: "ema", period: 50 },
      { id: "rsi-14", type: "rsi", period: 14 },
      {
        id: "volume-profile",
        type: "volumeProfile",
        from: viewportCandles[0].timestamp,
        to: context.data.range.endTime,
        bins: 48,
        valueAreaPercent: 70,
        method: "ohlcv-range-approximation",
      },
    ],
    metadata: {
      createdBy: { kind: "system", actorId: "mu-live-verifier" },
      runId: `mu-live-${stamp}`,
      createdAt: now,
    },
  };
  const authorization = { authorization: `Bearer ${registration.apiKey}`, "content-type": "application/json" };
  const created = await jsonRequest(`${apiBase}/api/analysis/documents`, {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({ document, reasoning: "Generate a live MU document for browser verification" }),
  });

  web = spawn("corepack", ["pnpm", "--filter", "@unimarket/web", "exec", "vite", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, UNIMARKET_API_PROXY: apiBase },
  });
  await waitForServer(webBase);
  renderer = spawn("corepack", ["pnpm", "--filter", "@unimarket/renderer", "start"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PORT: String(rendererPort), UNIMARKET_WEB_BASE_URL: webBase },
  });
  await waitForServer(`${rendererBase}/health`);
  const renderUrl = new URL("/render", rendererBase);
  renderUrl.searchParams.set("market", "hyperliquid");
  renderUrl.searchParams.set("reference", "xyz:MU");
  renderUrl.searchParams.set("documentId", created.id);
  renderUrl.searchParams.set("scope", "page");
  const renderResponse = await fetch(renderUrl);
  if (!renderResponse.ok) throw new Error(`Renderer failed: ${renderResponse.status} ${await renderResponse.text()}`);
  const encodedMetadata = renderResponse.headers.get("x-unimarket-render-metadata");
  if (!encodedMetadata) throw new Error("Renderer response did not include visual metadata");
  const renderMetadata = JSON.parse(Buffer.from(encodedMetadata, "base64url").toString("utf8"));
  const annotationCount = renderMetadata.annotationCount;
  const renderedDrawingIds = renderMetadata.renderedDrawingIds;
  const renderedProfileBins = renderMetadata.renderedProfileBins;
  const browserErrors = renderMetadata.browserErrors;
  if (annotationCount !== 3 || renderedDrawingIds.length !== 3) {
    throw new Error(`Expected 3 live MU drawings, got annotationCount=${annotationCount}, rendered=${renderedDrawingIds.length}`);
  }
  if (renderedProfileBins < 8) throw new Error(`Expected a rendered MU volume profile, got ${renderedProfileBins} bins`);
  if (browserErrors.length > 0) throw new Error(`Live MU page emitted browser errors: ${browserErrors.join(" | ")}`);

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
    renderedDrawingIds,
    renderedProfileBins,
    viewportCandleCount: viewportCandles.length,
    viewportFrom: viewportCandles[0].timestamp,
    supportAnchors: [support.first.candle.timestamp, support.second.candle.timestamp],
    projectedSupport: support.projected,
    supportViolations: support.violations,
    browserErrors,
    rendererUrl: renderUrl.toString(),
    screenshotPath,
  }, null, 2)}\n`);
  console.log(`MU live candles: ${candles.length}`);
  console.log(`MU live analysis screenshot: ${screenshotPath}`);
  console.log(`MU live verification: ${path.join(outputDir, "verification.json")}`);
} finally {
  if (renderer) stopProcessGroup(renderer);
  if (web) stopProcessGroup(web);
  stopProcessGroup(api);
  for (const suffix of ["-shm", "-wal"]) rmSync(`${dbPath}${suffix}`, { force: true });
}
