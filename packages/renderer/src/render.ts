import type { Browser } from "playwright";

import { buildAnalysisUrl, type AnalysisRenderRequest } from "./request.js";

export type AnalysisRenderResult = {
  image: Buffer;
  metadata: {
    documentId: string;
    targetUrl: string;
    candleHash: string | null;
    annotationCount: number;
    renderedDrawingIds: string[];
    renderedProfileBins: number;
    viewportFrom: string | null;
    viewportTo: string | null;
    browserErrors: string[];
  };
};

export const renderAnalysis = async (
  browser: Browser,
  webBaseUrl: string,
  request: AnalysisRenderRequest
): Promise<AnalysisRenderResult> => {
  const page = await browser.newPage({
    viewport: { width: request.width, height: request.height },
    colorScheme: request.theme
  });
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  try {
    const targetUrl = buildAnalysisUrl(webBaseUrl, request);
    await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 30_000 });
    const chart = page.locator("[data-analysis-ready='true']");
    await chart.waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForFunction(() => {
      const element = document.querySelector("[data-analysis-ready='true']");
      if (!element) return false;
      const expected = Number(element.getAttribute("data-annotation-count") ?? 0);
      return element.querySelectorAll("[data-drawing-id]").length === expected;
    });
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);

    const metadata = await chart.evaluate((element) => ({
      candleHash: element.getAttribute("data-candle-hash"),
      annotationCount: Number(element.getAttribute("data-annotation-count") ?? 0),
      renderedDrawingIds: Array.from(element.querySelectorAll("[data-drawing-id]"))
        .map((drawing) => drawing.getAttribute("data-drawing-id"))
        .filter((id): id is string => id !== null),
      renderedProfileBins: element.querySelectorAll("[data-profile-bin]").length,
      viewportFrom: element.getAttribute("data-viewport-from"),
      viewportTo: element.getAttribute("data-viewport-to")
    }));
    if (browserErrors.length > 0) throw new Error(`Rendered page emitted browser errors: ${browserErrors.join(" | ")}`);
    const image = request.scope === "page"
      ? await page.screenshot({ fullPage: true, animations: "allow", type: "png" })
      : await chart.screenshot({ animations: "allow", type: "png" });

    return {
      image,
      metadata: { documentId: request.documentId, targetUrl, ...metadata, browserErrors }
    };
  } finally {
    await page.close();
  }
};
