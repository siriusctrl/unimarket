import { afterEach, describe, expect, it, vi } from "vitest";

describe("loadApiEnv", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("loads optional env files once and ignores missing files", async () => {
    const loadEnvFile = vi.fn((path: string) => {
      if (path.endsWith(".env.local")) {
        const error = new Error("missing");
        Object.assign(error, { code: "ENOENT" });
        throw error;
      }
    });
    Object.assign(process, { loadEnvFile });

    const { loadApiEnv } = await import("../src/env.js");
    loadApiEnv();
    loadApiEnv();

    expect(loadEnvFile).toHaveBeenCalledTimes(2);
    expect(loadEnvFile.mock.calls[0]?.[0]).toContain(".env.local");
    expect(loadEnvFile.mock.calls[1]?.[0]).toContain(".env");
  });

  it("rethrows non-ENOENT load errors", async () => {
    const loadEnvFile = vi.fn(() => {
      const error = new Error("permission denied");
      Object.assign(error, { code: "EACCES" });
      throw error;
    });
    Object.assign(process, { loadEnvFile });

    const { loadApiEnv } = await import("../src/env.js");
    expect(() => loadApiEnv()).toThrow("permission denied");
  });
});
