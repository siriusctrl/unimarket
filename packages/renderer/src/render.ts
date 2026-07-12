import type { Browser, Locator, Page } from "playwright";

import { buildAnalysisUrl, type AnalysisRenderRequest } from "./request.js";

export type AnalysisRenderMetadata = {
  documentId: string;
  targetUrl: string;
  candleHash: string | null;
  annotationCount: number;
  renderedDrawingIds: string[];
  visibleDrawingIds: string[];
  clippedDrawingIds: string[];
  renderedProfileBins: number;
  viewportFrom: string | null;
  viewportTo: string | null;
  browserErrors: string[];
};

type ReadyAnalysis = {
  page: Page;
  chart: Locator;
  metadata: AnalysisRenderMetadata;
};

const withReadyAnalysis = async <T>(
  browser: Browser,
  webBaseUrl: string,
  request: AnalysisRenderRequest,
  consume: (analysis: ReadyAnalysis) => Promise<T>,
): Promise<T> => {
  const page = await browser.newPage({
    viewport: { width: request.width, height: request.height },
    colorScheme: request.theme,
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
      return element?.getAttribute("data-projection-ready") === "true";
    });
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }));
    await page.evaluate(() => document.fonts.ready);

    const projected = await chart.evaluate((element) => ({
      candleHash: element.getAttribute("data-candle-hash"),
      annotationCount: Number(element.getAttribute("data-annotation-count") ?? 0),
      renderedDrawingIds: Array.from(element.querySelectorAll("[data-drawing-id]"))
        .map((drawing) => drawing.getAttribute("data-drawing-id"))
        .filter((id): id is string => id !== null),
      visibleDrawingIds: JSON.parse(element.getAttribute("data-visible-drawing-ids") ?? "[]") as string[],
      clippedDrawingIds: JSON.parse(element.getAttribute("data-clipped-drawing-ids") ?? "[]") as string[],
      renderedProfileBins: element.querySelectorAll("[data-profile-bin]").length,
      viewportFrom: element.getAttribute("data-viewport-from"),
      viewportTo: element.getAttribute("data-viewport-to"),
    }));
    if (browserErrors.length > 0) throw new Error(`Rendered page emitted browser errors: ${browserErrors.join(" | ")}`);
    return await consume({
      page,
      chart,
      metadata: { documentId: request.documentId, targetUrl, ...projected, browserErrors },
    });
  } finally {
    await page.close();
  }
};

export const inspectAnalysis = (
  browser: Browser,
  webBaseUrl: string,
  request: AnalysisRenderRequest,
): Promise<AnalysisRenderMetadata> =>
  withReadyAnalysis(browser, webBaseUrl, request, async ({ metadata }) => metadata);

export const renderAnalysis = (
  browser: Browser,
  webBaseUrl: string,
  request: AnalysisRenderRequest,
): Promise<{ image: Buffer; metadata: AnalysisRenderMetadata }> =>
  withReadyAnalysis(browser, webBaseUrl, request, async ({ page, chart, metadata }) => ({
    image: request.scope === "page"
      ? await page.screenshot({ fullPage: true, animations: "allow", type: "png" })
      : await chart.screenshot({ animations: "allow", type: "png" }),
    metadata,
  }));
