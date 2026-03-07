import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startPeriodicWorker } from "../src/workers/periodic-worker.js";

describe("startPeriodicWorker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.TEST_INTERVAL_MS;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("uses env override, emits results, and stops cleanly", async () => {
    process.env.TEST_INTERVAL_MS = "25";
    const run = vi.fn().mockResolvedValue({ ok: true });
    const onResult = vi.fn();

    const stop = startPeriodicWorker({
      name: "test-worker",
      defaultIntervalMs: 100,
      envVar: "TEST_INTERVAL_MS",
      run,
      onResult,
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({ ok: true });

    stop();
    expect(console.log).toHaveBeenCalledWith("[test-worker] started (interval: 25ms)");
    expect(console.log).toHaveBeenCalledWith("[test-worker] stopped");
  });

  it("falls back to the default interval and avoids overlapping runs", async () => {
    process.env.TEST_INTERVAL_MS = "not-a-number";
    let resolveRun: (() => void) | null = null;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
    );

    const stop = startPeriodicWorker({
      name: "serial-worker",
      defaultIntervalMs: 50,
      envVar: "TEST_INTERVAL_MS",
      run,
    });

    await vi.advanceTimersByTimeAsync(150);
    expect(run).toHaveBeenCalledTimes(1);

    resolveRun?.();
    await vi.advanceTimersByTimeAsync(49);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);

    stop();
  });

  it("logs worker errors and keeps running state recoverable", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");

    const stop = startPeriodicWorker({
      name: "error-worker",
      defaultIntervalMs: 10,
      envVar: "TEST_INTERVAL_MS",
      run,
    });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(console.error).toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });
});
