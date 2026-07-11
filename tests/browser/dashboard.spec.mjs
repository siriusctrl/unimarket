import { expect, test } from "@playwright/test";

import { mockDashboardApi } from "./fixtures/dashboard.mjs";

const browserErrorsByPage = new WeakMap();
const apiCallsByPage = new WeakMap();

test.beforeEach(async ({ page }) => {
  const browserErrors = [];
  const apiCalls = [];
  browserErrorsByPage.set(page, browserErrors);
  apiCallsByPage.set(page, apiCalls);
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await mockDashboardApi(page, apiCalls);
  await page.goto("/dashboard");
  await page.evaluate(() => window.localStorage.clear());
  await page.evaluate(() => window.localStorage.setItem("unimarket_theme", "light"));
  await page.reload();
});

test("operator can inspect the deterministic dashboard and agent audit trail", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Agent observation console" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Equity trend" })).toBeVisible();
  await expect(page.getByText("Atlas Alpha").first()).toBeVisible();

  await page.getByRole("button", { name: "Return %" }).click();
  await expect(page.getByRole("heading", { name: "Return trend" })).toBeVisible();
  await page.getByRole("button", { name: "1W" }).click();

  const search = page.getByPlaceholder("Search agents...");
  const roster = page.getByRole("heading", { name: "Agent roster" }).locator("xpath=ancestor::section");
  await search.fill("Sable");
  await expect(roster.getByText("Sable Quant", { exact: true })).toBeVisible();
  await expect(roster.getByText("Northstar Event", { exact: true })).toHaveCount(0);
  await search.clear();

  const overviewCallsBeforeNavigation = apiCallsByPage
    .get(page)
    .filter((call) => call === "/api/dashboard/overview").length;
  await page.getByRole("button", { name: "Atlas Alpha", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/agent-atlas$/);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole("heading", { name: "Atlas Alpha" })).toBeVisible();
  await expect(page.getByText("Federal Reserve cuts rates by September 2026").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Audit timeline" })).toBeVisible();
  const overviewCallsAfterNavigation = apiCallsByPage
    .get(page)
    .filter((call) => call === "/api/dashboard/overview").length;
  expect(overviewCallsAfterNavigation).toBe(overviewCallsBeforeNavigation);

  await page.getByRole("button", { name: "Orders" }).click();
  await expect(page.getByText("Buy", { exact: true })).toBeVisible();
  await expect(page.getByText(/Funding rate/)).toBeHidden();

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);

  expect(browserErrorsByPage.get(page)).toEqual([]);
});

test("mobile shell keeps navigation usable without page-level overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();

  await expect(page.getByRole("heading", { name: "Agent observation console" })).toBeVisible();
  await page.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(browserErrorsByPage.get(page)).toEqual([]);
});
