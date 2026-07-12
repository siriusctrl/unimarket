import type { Browser } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectAnalysis, renderAnalysis } from "../src/render.js";
import type { AnalysisRenderRequest } from "../src/request.js";

const request: AnalysisRenderRequest = {
  market: "hyperliquid",
  reference: "xyz:MU",
  documentId: "ana_test",
  scope: "chart",
  theme: "dark",
  width: 1440,
  height: 1000,
};

const createBrowser = ({ consoleError = false } = {}) => {
  let closed = false;
  const handlers = new Map<string, (value: never) => void>();
  const attributes = new Map([
    ["data-projection-ready", "true"],
    ["data-candle-hash", `sha256:${"a".repeat(64)}`],
    ["data-annotation-count", "2"],
    ["data-visible-drawing-ids", JSON.stringify(["support"])],
    ["data-clipped-drawing-ids", JSON.stringify(["target"])],
    ["data-viewport-from", "2026-01-01T00:00:00.000Z"],
    ["data-viewport-to", "2026-02-01T00:00:00.000Z"],
  ]);
  const drawings = ["support", "target"].map((id) => ({
    getAttribute: (name: string) => name === "data-drawing-id" ? id : null,
  }));
  const element = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    querySelectorAll: (selector: string) => selector === "[data-drawing-id]"
      ? drawings
      : Array.from({ length: selector === "[data-profile-bin]" ? 24 : 0 }),
  };
  vi.stubGlobal("document", {
    querySelector: () => element,
    fonts: { ready: Promise.resolve() },
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  const chart = {
    waitFor: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockImplementation((callback: (target: typeof element) => unknown) => callback(element)),
    screenshot: vi.fn().mockImplementation(async () => {
      await Promise.resolve();
      if (closed) throw new Error("chart closed before screenshot completed");
      return Buffer.from("chart");
    }),
  };
  const page = {
    on: vi.fn((event: string, handler: (value: never) => void) => handlers.set(event, handler)),
    goto: vi.fn().mockImplementation(async () => {
      if (consoleError) {
        handlers.get("console")?.({ type: () => "error", text: () => "canvas failed" } as never);
      }
    }),
    locator: vi.fn().mockReturnValue(chart),
    waitForFunction: vi.fn().mockImplementation((callback: () => unknown) => callback()),
    evaluate: vi.fn().mockImplementation((callback: () => unknown) => callback()),
    screenshot: vi.fn().mockImplementation(async () => {
      await Promise.resolve();
      if (closed) throw new Error("page closed before screenshot completed");
      return Buffer.from("page");
    }),
    close: vi.fn().mockImplementation(async () => {
      closed = true;
    }),
  };
  const browser = { newPage: vi.fn().mockResolvedValue(page) } as unknown as Browser;
  return { browser, chart, page };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("analysis rendering", () => {
  it("captures chart scope with semantic visibility metadata", async () => {
    const { browser, chart, page } = createBrowser();
    const result = await renderAnalysis(browser, "https://app.example.com", request);

    expect(result.image.toString()).toBe("chart");
    expect(result.metadata).toMatchObject({
      documentId: "ana_test",
      renderedDrawingIds: ["support", "target"],
      visibleDrawingIds: ["support"],
      clippedDrawingIds: ["target"],
      browserErrors: [],
    });
    expect(chart.screenshot).toHaveBeenCalledOnce();
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("captures page scope and always closes the isolated page", async () => {
    const { browser, page } = createBrowser();
    const result = await renderAnalysis(browser, "https://app.example.com", { ...request, scope: "page" });
    expect(result.image.toString()).toBe("page");
    expect(page.screenshot).toHaveBeenCalledWith({ fullPage: true, animations: "allow", type: "png" });
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("inspects projected metadata without taking a discarded screenshot", async () => {
    const { browser, chart, page } = createBrowser();
    const metadata = await inspectAnalysis(browser, "https://app.example.com", request);
    expect(metadata.visibleDrawingIds).toEqual(["support"]);
    expect(chart.screenshot).not.toHaveBeenCalled();
    expect(page.screenshot).not.toHaveBeenCalled();
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("rejects browser console failures and still closes the page", async () => {
    const { browser, page } = createBrowser({ consoleError: true });
    await expect(renderAnalysis(browser, "https://app.example.com", request)).rejects.toThrow("canvas failed");
    expect(page.close).toHaveBeenCalledOnce();
  });
});
