import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

import { stopProcessGroup, waitForServer } from "./lib/browser-server.mjs";
import { mockDashboardApi } from "../tests/browser/fixtures/dashboard.mjs";

const root = process.cwd();
const port = Number(process.env.UNIMARKET_PREVIEW_PORT ?? 43178);
const host = "127.0.0.1";
const url = `http://${host}:${port}`;

const build = spawnSync("corepack", ["pnpm", "--filter", "@unimarket/web", "build"], {
  cwd: root,
  stdio: "inherit",
});

if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawn(
  "corepack",
  ["pnpm", "--filter", "@unimarket/web", "exec", "vite", "preview", "--host", host, "--port", String(port), "--strictPort"],
  {
    cwd: root,
    detached: true,
    stdio: "ignore",
  },
);

let browser;

try {
  await waitForServer(url);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await mockDashboardApi(page);
  await page.goto(`${url}/dashboard`);
  await page.evaluate(() => window.localStorage.setItem("unimarket_theme", "light"));
  await page.reload();

  await page.getByRole("heading", { name: "Agent observation console" }).waitFor();
  await page.getByText("Atlas Alpha").first().waitFor();
  await page.getByRole("button", { name: "Toggle theme" }).click();

  const darkMode = await page.locator("html").evaluate((element) => element.classList.contains("dark"));
  if (!darkMode) throw new Error("Production preview did not apply the dark theme");

  await page.getByRole("button", { name: "Atlas Alpha", exact: true }).click();
  await page.getByRole("heading", { name: "Audit timeline" }).waitFor();

  console.log(`Production preview verification passed: ${url}`);
} finally {
  if (browser) await browser.close();
  stopProcessGroup(server);
}
