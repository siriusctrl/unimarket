import { chromium } from "@playwright/test";
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
const apiBase = `http://127.0.0.1:${apiPort}`;
const webBase = `http://127.0.0.1:${webPort}`;
mkdirSync(outputDir, { recursive: true });

const api = spawn("corepack", ["pnpm", "--filter", "@unimarket/api", "exec", "tsx", "src/index.ts"], {
  cwd: root,
  detached: true,
  stdio: "ignore",
  env: { ...process.env, DB_URL: `file:${dbPath}`, PORT: String(apiPort) },
});
let web;
let browser;

const jsonRequest = async (url, init = {}) => {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${url}: ${JSON.stringify(payload)}`);
  return payload;
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
  const localLows = candles.filter((candle, index) => {
    if (index < 3 || index >= candles.length - 3) return false;
    return candles.slice(index - 3, index + 4).every((candidate) => candle.low <= candidate.low);
  });
  const risingPairs = localLows.flatMap((first, firstIndex) => localLows.slice(firstIndex + 1).flatMap((second) =>
    second.low > first.low ? [{ first, second, span: Date.parse(second.timestamp) - Date.parse(first.timestamp) }] : [],
  )).sort((left, right) => right.span - left.span);
  const firstAnchor = risingPairs[0]?.first ?? candles[Math.floor(candles.length * 0.25)];
  const secondAnchor = risingPairs[0]?.second ?? candles[Math.floor(candles.length * 0.72)];
  const recent = candles.slice(-40);
  const resistance = Math.max(...recent.map((candle) => candle.high));
  const firstAnchorIndex = candles.indexOf(firstAnchor);
  const secondAnchorIndex = candles.indexOf(secondAnchor);
  const channelAnchor = candles.slice(firstAnchorIndex, Math.max(firstAnchorIndex + 1, secondAnchorIndex + 1))
    .reduce((highest, candle) => candle.high > highest.high ? candle : highest, candles[0]);
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
    viewport: { priceScale: "auto" },
    thesis: "Live MU validation document connects confirmed daily swing points and preserves the latest supply boundary.",
    invalidation: `A daily close below ${secondAnchor.low.toFixed(2)} and the projected support invalidates this generated validation structure.`,
    layers: [
      {
        id: "live-rising-support",
        type: "trendLine",
        anchors: [
          { time: firstAnchor.timestamp, price: firstAnchor.low },
          { time: secondAnchor.timestamp, price: secondAnchor.low },
        ],
        extend: { left: false, right: true },
        label: "Live swing support",
        rationale: "Generated from two confirmed local lows in the live one-year MU candle response.",
        confidence: 0.72,
        style: { color: "support", width: 2, lineStyle: "solid", opacity: 0.92 },
      },
      {
        id: "live-channel",
        type: "channel",
        base: [
          { time: firstAnchor.timestamp, price: firstAnchor.low },
          { time: secondAnchor.timestamp, price: secondAnchor.low },
        ],
        parallelAnchor: { time: channelAnchor.timestamp, price: channelAnchor.high },
        fillOpacity: 0.06,
        label: "Live price channel",
        rationale: "Uses the support slope and the highest prior candle to construct a parallel envelope.",
        confidence: 0.64,
        style: { color: "accent", width: 1, lineStyle: "dashed", opacity: 0.75 },
      },
      {
        id: "live-resistance",
        type: "horizontalLine",
        price: resistance,
        label: "40-session high",
        rationale: "Marks the highest high across the latest forty live daily candles.",
        confidence: 0.8,
        style: { color: "resistance", width: 2, lineStyle: "dotted", opacity: 0.86 },
      },
      { id: "sma-20", type: "sma", period: 20 },
      { id: "ema-50", type: "ema", period: 50 },
      { id: "rsi-14", type: "rsi", period: 14 },
      {
        id: "volume-profile",
        type: "volumeProfile",
        from: context.data.range.startTime,
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
  const published = await jsonRequest(`${apiBase}/api/analysis/documents/${created.id}/publish`, {
    method: "POST",
    headers: authorization,
    body: JSON.stringify({ reasoning: "Publish after schema and live-data validation" }),
  });

  web = spawn("corepack", ["pnpm", "--filter", "@unimarket/web", "exec", "vite", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, UNIMARKET_API_PROXY: apiBase },
  });
  await waitForServer(webBase);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(`${webBase}/analysis/hyperliquid/xyz%3AMU`, { waitUntil: "networkidle" });
  const chart = page.locator("[data-analysis-ready='true']");
  await chart.waitFor({ state: "visible" });
  await page.waitForTimeout(700);
  const annotationCount = Number(await chart.getAttribute("data-annotation-count"));
  const renderedDrawingIds = await chart.locator("[data-drawing-id]").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-drawing-id")));
  const renderedProfileBins = await chart.locator("[data-profile-bin]").count();
  if (annotationCount !== 3 || renderedDrawingIds.length !== 3) {
    throw new Error(`Expected 3 live MU drawings, got annotationCount=${annotationCount}, rendered=${renderedDrawingIds.length}`);
  }
  if (renderedProfileBins < 8) throw new Error(`Expected a rendered MU volume profile, got ${renderedProfileBins} bins`);
  if (browserErrors.length > 0) throw new Error(`Live MU page emitted browser errors: ${browserErrors.join(" | ")}`);

  const screenshotPath = path.join(outputDir, "mu-live-analysis.png");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => window.scrollY === 0);
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: screenshotPath, fullPage: true, animations: "allow" });
  writeFileSync(path.join(outputDir, "mu-live-analysis.json"), `${JSON.stringify(published, null, 2)}\n`);
  writeFileSync(path.join(outputDir, "verification.json"), `${JSON.stringify({
    market: "hyperliquid",
    reference: "xyz:MU",
    candleCount: candles.length,
    firstCandle: candles[0].timestamp,
    lastCandle: candles.at(-1).timestamp,
    snapshotHash: context.data.snapshotHash,
    analysisId: created.id,
    annotationCount,
    renderedDrawingIds,
    renderedProfileBins,
    browserErrors,
    screenshotPath,
  }, null, 2)}\n`);
  console.log(`MU live candles: ${candles.length}`);
  console.log(`MU live analysis screenshot: ${screenshotPath}`);
  console.log(`MU live verification: ${path.join(outputDir, "verification.json")}`);
} finally {
  if (browser) await browser.close();
  if (web) stopProcessGroup(web);
  stopProcessGroup(api);
  for (const suffix of ["-shm", "-wal"]) rmSync(`${dbPath}${suffix}`, { force: true });
}
