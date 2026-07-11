import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const [targetUrl, outputArg = "artifacts/analysis/analysis-preview.png"] = process.argv.slice(2);
if (!targetUrl) {
  throw new Error("Usage: pnpm render:analysis <analysis-preview-url> [output.png]");
}

const outputPath = path.resolve(outputArg);
const metadataPath = outputPath.replace(/\.png$/i, ".json");
mkdirSync(path.dirname(outputPath), { recursive: true });

const browser = await chromium.launch({ headless: true });
const browserErrors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto(targetUrl, { waitUntil: "networkidle" });
  const chart = page.locator("[data-analysis-ready='true']");
  await chart.waitFor({ state: "visible" });
  await page.waitForTimeout(500);
  await chart.screenshot({ path: outputPath, animations: "disabled" });

  const metadata = await chart.evaluate((element) => ({
    analysisReady: element.getAttribute("data-analysis-ready") === "true",
    annotationCount: Number(element.getAttribute("data-annotation-count") ?? 0),
    candleHash: element.getAttribute("data-candle-hash"),
    viewportFrom: element.getAttribute("data-viewport-from"),
    viewportTo: element.getAttribute("data-viewport-to"),
    priceScale: element.getAttribute("data-price-scale"),
    renderedProfileBins: element.querySelectorAll("[data-profile-bin]").length,
    renderedDrawingIds: Array.from(element.querySelectorAll("[data-drawing-id]"))
      .map((drawing) => drawing.getAttribute("data-drawing-id"))
      .filter(Boolean),
  }));
  writeFileSync(metadataPath, `${JSON.stringify({ targetUrl, ...metadata, browserErrors }, null, 2)}\n`);
  if (browserErrors.length > 0) throw new Error(`Analysis preview emitted browser errors: ${browserErrors.join(" | ")}`);
  console.log(`Analysis screenshot: ${outputPath}`);
  console.log(`Render metadata: ${metadataPath}`);
} finally {
  await browser.close();
}
