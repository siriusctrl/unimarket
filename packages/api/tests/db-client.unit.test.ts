import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_DB_PATH = process.env.DB_PATH;
const ORIGINAL_DB_URL = process.env.DB_URL;

const loadModule = async ({
  env = {},
  executeImpl,
}: {
  env?: Record<string, string | undefined>;
  executeImpl?: (statement: string) => Promise<void>;
} = {}) => {
  vi.resetModules();
  process.env.DB_PATH = ORIGINAL_DB_PATH;
  process.env.DB_URL = ORIGINAL_DB_URL;
  for (const [key, value] of Object.entries(env)) {
    if (key !== "DB_PATH" && key !== "DB_URL") continue;
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const sqlite = {
    execute: vi.fn((statement: string) => executeImpl?.(statement) ?? Promise.resolve()),
  };
  const createClient = vi.fn(() => sqlite);
  const drizzle = vi.fn(() => ({ mocked: true }));

  vi.doMock("@libsql/client", () => ({ createClient }));
  vi.doMock("drizzle-orm/libsql", () => ({ drizzle }));
  vi.doMock("../src/db/schema.js", () => ({}));

  const mod = await import("../src/db/client.js");
  return { ...mod, sqlite, createClient, drizzle };
};

afterEach(() => {
  vi.restoreAllMocks();
  process.env.DB_PATH = ORIGINAL_DB_PATH;
  process.env.DB_URL = ORIGINAL_DB_URL;
});

describe("db client", () => {
  it("prefixes DB_PATH values without a scheme", async () => {
    const { createClient } = await loadModule({ env: { DB_PATH: "tmp/unimarket.sqlite", DB_URL: undefined } });
    expect(createClient).toHaveBeenCalledWith({ url: "file:tmp/unimarket.sqlite" });
  });

  it("uses DB_URL as-is when it already has a scheme", async () => {
    const { createClient } = await loadModule({ env: { DB_URL: "file:/tmp/custom.sqlite", DB_PATH: undefined } });
    expect(createClient).toHaveBeenCalledWith({ url: "file:/tmp/custom.sqlite" });
  });

  it("ignores duplicate-column additive migrations and continues", async () => {
    const { migrate, sqlite } = await loadModule({
      executeImpl: async (statement) => {
        if (statement.includes("ADD COLUMN taker_fee_rate")) {
          throw new Error("duplicate column name: taker_fee_rate");
        }
      },
    });

    await expect(migrate()).resolves.toBeUndefined();
    expect(sqlite.execute).toHaveBeenCalled();
  });

  it("rethrows non-duplicate additive migration errors", async () => {
    const { migrate } = await loadModule({
      executeImpl: async (statement) => {
        if (statement.includes("ADD COLUMN fee")) {
          throw new Error("boom");
        }
      },
    });

    await expect(migrate()).rejects.toThrow("boom");
  });
});
