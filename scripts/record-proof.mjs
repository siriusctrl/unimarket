import { chromium } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { stopProcessGroup, waitForServer } from "./lib/browser-server.mjs";
import { mockDashboardApi } from "../tests/browser/fixtures/dashboard.mjs";

const root = process.cwd();
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = path.join(root, "artifacts", "verification", stamp);
const videoDir = path.join(outputDir, "videos");
const screenshotPath = path.join(outputDir, "final-screenshot.png");
const webmPath = path.join(outputDir, "recording.webm");
const gifPath = path.join(outputDir, "proof.gif");
const contactSheetPath = path.join(outputDir, "contact-sheet.png");
const manifestPath = path.join(outputDir, "manifest.json");
const inspectionPath = path.join(outputDir, "inspection.txt");
const frameCheckPath = path.join(outputDir, "frame-check.json");
const port = Number(process.env.UNIMARKET_PROOF_PORT ?? 43179);
const host = "127.0.0.1";
const url = `http://${host}:${port}`;
const trimStartOverride = process.env.UNIMARKET_PROOF_TRIM_START;

mkdirSync(videoDir, { recursive: true });

function checkSampledFrames(gifFile) {
  const width = 64;
  const height = 40;
  const channels = 3;
  const frameSize = width * height * channels;
  const sample = spawnSync(
    "ffmpeg",
    ["-i", gifFile, "-vf", `fps=1,scale=${width}:${height}:flags=bilinear`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 },
  );

  if (sample.status !== 0) {
    throw new Error(`ffmpeg failed to sample GIF frames: ${sample.stderr.toString()}`);
  }

  const frames = [];
  for (let offset = 0; offset + frameSize <= sample.stdout.length; offset += frameSize) {
    let sum = 0;
    let sumSq = 0;
    for (let index = offset; index < offset + frameSize; index += channels) {
      const red = sample.stdout[index];
      const green = sample.stdout[index + 1];
      const blue = sample.stdout[index + 2];
      const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      sum += luma;
      sumSq += luma * luma;
    }

    const count = width * height;
    const mean = sum / count;
    const deviation = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
    frames.push({
      index: frames.length,
      mean: Number(mean.toFixed(2)),
      deviation: Number(deviation.toFixed(2)),
      blankLike: deviation < 2.8,
    });
  }

  const blankFrames = frames.filter((frame) => frame.blankLike);
  if (frames.length < 4) throw new Error("GIF frame check found too few sampled frames");
  if (blankFrames.length > 0) {
    throw new Error(`GIF frame check found blank-like frames: ${blankFrames.map((frame) => frame.index).join(", ")}`);
  }

  return { frameCount: frames.length, blankFrameCount: blankFrames.length, frames };
}

const server = spawn(
  "corepack",
  ["pnpm", "--filter", "@unimarket/web", "exec", "vite", "--host", host, "--port", String(port), "--strictPort"],
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
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: {
      dir: videoDir,
      size: { width: 1440, height: 900 },
    },
  });
  const recordingStartedAt = Date.now();
  const page = await context.newPage();
  const apiCalls = [];
  const browserErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await mockDashboardApi(page, apiCalls);

  await page.goto(`${url}/dashboard`);
  await page.evaluate(() => window.localStorage.clear());
  await page.evaluate(() => window.localStorage.setItem("unimarket_theme", "light"));
  await page.reload();
  await page.getByRole("heading", { name: "Agent observation console" }).waitFor();
  await page.waitForTimeout(700);
  const trimStartSeconds = trimStartOverride ?? ((Date.now() - recordingStartedAt) / 1_000).toFixed(2);

  await page.getByRole("button", { name: "Return %" }).click();
  await page.getByRole("heading", { name: "Return trend" }).waitFor();
  await page.getByRole("button", { name: "3M" }).click();
  await page.waitForTimeout(500);

  const search = page.getByPlaceholder("Search agents...");
  await search.fill("Atlas");
  await page.getByText("Atlas Alpha").last().waitFor();
  await page.waitForTimeout(450);
  await search.clear();
  await page.waitForTimeout(350);

  await page.getByRole("button", { name: "Atlas Alpha", exact: true }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Atlas Alpha", exact: true }).click();
  await page.getByRole("heading", { name: "Atlas Alpha" }).waitFor();
  await page.waitForTimeout(650);

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.locator("html.dark").waitFor();
  await page.getByRole("heading", { name: "Audit timeline" }).scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Orders" }).click();
  await page.getByText("Buy", { exact: true }).waitFor();
  await page.waitForTimeout(700);

  await page.getByRole("button", { name: "Back to overview" }).click();
  await page.getByRole("heading", { name: "Agent observation console" }).waitFor();
  await page.getByRole("link", { name: "Analysis" }).click();
  await page.getByRole("heading", { name: "Market structure, stored as data" }).waitFor();
  const analysisChart = page.locator("[data-analysis-ready='true']");
  await analysisChart.waitFor();
  await page.getByRole("button", { name: "90d" }).click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "1y" }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForFunction(() => window.scrollY === 0);
  await page.waitForTimeout(900);
  await page.screenshot({ path: screenshotPath, fullPage: true, animations: "allow" });

  await context.close();
  await browser.close();
  browser = undefined;

  const videos = readdirSync(videoDir).filter((file) => file.endsWith(".webm"));
  if (videos.length === 0) throw new Error("Playwright did not write a WebM recording");
  renameSync(path.join(videoDir, videos[0]), webmPath);

  const gif = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-ss",
      trimStartSeconds,
      "-i",
      webmPath,
      "-vf",
      "fps=12,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
      gifPath,
    ],
    { stdio: "pipe" },
  );
  if (gif.status !== 0 || !existsSync(gifPath)) {
    throw new Error(`ffmpeg failed to create GIF: ${gif.stderr.toString()}`);
  }

  const contactSheet = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-i",
      gifPath,
      "-vf",
      "fps=1.5,scale=360:-1:flags=lanczos,tile=4x4:padding=8:margin=8:color=white",
      "-frames:v",
      "1",
      "-update",
      "1",
      contactSheetPath,
    ],
    { stdio: "pipe" },
  );
  if (contactSheet.status !== 0 || !existsSync(contactSheetPath)) {
    throw new Error(`ffmpeg failed to create contact sheet: ${contactSheet.stderr.toString()}`);
  }

  const frameCheck = checkSampledFrames(gifPath);
  writeFileSync(frameCheckPath, `${JSON.stringify(frameCheck, null, 2)}\n`);

  const actions = [
    "load deterministic dashboard fixture",
    "switch equity chart to return mode",
    "change chart range",
    "filter and restore agent roster",
    "open agent detail",
    "toggle dark mode",
    "filter audit timeline to orders",
    "return to dashboard",
    "open the MU analysis workspace",
    "inspect model-authored time-price drawings and volume profile",
    "change and restore the analysis range",
    "capture full-page screenshot",
  ];
  const manifest = {
    url,
    createdAt: new Date().toISOString(),
    fixture: "tests/browser/fixtures/dashboard.mjs",
    trimStartSeconds,
    actions,
    apiCalls,
    browserErrors,
    files: {
      gif: gifPath,
      webm: webmPath,
      screenshot: screenshotPath,
      contactSheet: contactSheetPath,
      frameCheck: frameCheckPath,
    },
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    inspectionPath,
    [
      "Unimarket browser proof inspection",
      "",
      ...actions.map((action) => `- ${action}.`),
      `- Browser console errors: ${browserErrors.length}.`,
      `- Blank-like sampled frames: ${frameCheck.blankFrameCount}.`,
      "",
      `GIF: ${gifPath}`,
      `WebM: ${webmPath}`,
      `Screenshot: ${screenshotPath}`,
      `Contact sheet: ${contactSheetPath}`,
      `Frame check: ${frameCheckPath}`,
      "",
    ].join("\n"),
  );

  if (browserErrors.length > 0) {
    throw new Error(`Browser proof captured console errors: ${browserErrors.join(" | ")}`);
  }

  console.log(`Proof GIF: ${gifPath}`);
  console.log(`Recording: ${webmPath}`);
  console.log(`Screenshot: ${screenshotPath}`);
  console.log(`Contact sheet: ${contactSheetPath}`);
  console.log(`Frame check: ${frameCheckPath}`);
} finally {
  if (browser) await browser.close();
  stopProcessGroup(server);
}
