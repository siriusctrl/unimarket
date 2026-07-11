import { describe, expect, it } from "vitest";

import { buildAnalysisUrl, parseRenderRequest } from "../src/request.js";

describe("analysis render requests", () => {
  it("parses defaults and builds an encoded draft preview URL", () => {
    const request = parseRenderRequest(new URL(
      "http://renderer/render?market=hyperliquid&reference=xyz%3AMU&documentId=ana_123"
    ));
    expect(request).toEqual({
      market: "hyperliquid",
      reference: "xyz:MU",
      documentId: "ana_123",
      scope: "chart",
      theme: "dark",
      width: 1440,
      height: 1000
    });
    expect(buildAnalysisUrl("https://unimarket.example/base", request)).toBe(
      "https://unimarket.example/analysis/hyperliquid/xyz%3AMU?documentId=ana_123"
    );
  });

  it("accepts explicit render presentation options", () => {
    const request = parseRenderRequest(new URL(
      "http://renderer/render?market=m&reference=r&documentId=d&scope=page&theme=light&width=1800&height=1200"
    ));
    expect(request).toMatchObject({ scope: "page", theme: "light", width: 1800, height: 1200 });
  });

  it.each([
    "market=m&reference=r",
    "market=m&reference=r&documentId=d&scope=screen",
    "market=m&reference=r&documentId=d&theme=system",
    "market=m&reference=r&documentId=d&width=300",
    "market=m&reference=r&documentId=d&height=wide"
  ])("rejects malformed parameters: %s", (query) => {
    expect(() => parseRenderRequest(new URL(`http://renderer/render?${query}`))).toThrow();
  });
});
