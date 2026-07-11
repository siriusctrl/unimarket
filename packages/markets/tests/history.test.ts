import { describe, expect, it } from "vitest";

import {
  buildPriceHistoryResult,
  floorTimestampToInterval,
  resampleCandles,
  resolvePriceHistoryRange,
  summarizeCandles,
} from "../src/history.js";
import { MarketAdapterError, type CandleData, type PriceHistorySupport } from "../src/types.js";

const SUPPORT: PriceHistorySupport = {
  nativeIntervals: ["1m", "5m", "15m", "1h", "4h", "1d"],
  supportedIntervals: ["1m", "5m", "15m", "1h", "4h", "1d"],
  defaultInterval: "1h",
  supportedLookbacks: ["1h", "4h", "1d", "7d", "30d"],
  defaultLookbacks: {
    "1m": "4h",
    "5m": "1d",
    "15m": "1d",
    "1h": "7d",
    "4h": "30d",
    "1d": "30d",
  },
  maxCandles: 300,
  supportsCustomRange: true,
  supportsResampling: true,
};

describe("price history helpers", () => {
  it("resolves lookback ranges from explicit interval and asOf", () => {
    const asOf = "2026-03-08T00:00:00.000Z";

    const result = resolvePriceHistoryRange(SUPPORT, {
      interval: "4h",
      lookback: "30d",
      asOf,
    });

    expect(result.interval).toBe("4h");
    expect(result.range).toEqual({
      mode: "lookback",
      lookback: "30d",
      asOf,
      startTime: "2026-02-06T00:00:00.000Z",
      endTime: asOf,
    });
  });

  it("falls back to configured default lookbacks", () => {
    const result = resolvePriceHistoryRange(SUPPORT, {
      interval: "5m",
      asOf: "2026-03-08T00:00:00.000Z",
    });

    expect(result.range.mode).toBe("lookback");
    expect(result.range.lookback).toBe("1d");
    expect(result.range.startTime).toBe("2026-03-07T00:00:00.000Z");
  });

  it("resolves supported custom ranges", () => {
    const result = resolvePriceHistoryRange(SUPPORT, {
      interval: "1h",
      startTime: "2026-03-01T00:00:00.000Z",
      endTime: "2026-03-08T00:00:00.000Z",
    });

    expect(result).toEqual({
      interval: "1h",
      range: {
        mode: "custom",
        lookback: null,
        asOf: "2026-03-08T00:00:00.000Z",
        startTime: "2026-03-01T00:00:00.000Z",
        endTime: "2026-03-08T00:00:00.000Z",
      },
    });
  });

  it("rejects unsupported or malformed ranges", () => {
    expect(() =>
      resolvePriceHistoryRange(
        { ...SUPPORT, supportsCustomRange: false },
        { startTime: "2026-03-01T00:00:00.000Z", endTime: "2026-03-08T00:00:00.000Z" },
      ),
    ).toThrowError(new MarketAdapterError("INVALID_INPUT", "Custom startTime/endTime ranges are not supported"));

    expect(() => resolvePriceHistoryRange(SUPPORT, { startTime: "2026-03-01T00:00:00.000Z" })).toThrowError(
      new MarketAdapterError("INVALID_INPUT", "startTime and endTime must be provided together"),
    );

    expect(() =>
      resolvePriceHistoryRange(SUPPORT, {
        startTime: "2026-03-08T00:00:00.000Z",
        endTime: "2026-03-01T00:00:00.000Z",
      }),
    ).toThrowError(new MarketAdapterError("INVALID_INPUT", "endTime must be greater than startTime"));

    expect(() => resolvePriceHistoryRange(SUPPORT, { asOf: "not-a-date" })).toThrowError(
      new MarketAdapterError("INVALID_INPUT", "asOf must be a valid datetime"),
    );
  });

  it("rejects unsupported intervals, lookbacks, and oversized ranges", () => {
    expect(() => resolvePriceHistoryRange(SUPPORT, { interval: "1w" as never })).toThrowError(
      new MarketAdapterError("INVALID_INPUT", "Unsupported interval: 1w"),
    );

    expect(() => resolvePriceHistoryRange(SUPPORT, { lookback: "90d" as never })).toThrowError(
      new MarketAdapterError("INVALID_INPUT", "Unsupported lookback: 90d"),
    );

    expect(() =>
      resolvePriceHistoryRange(
        { ...SUPPORT, maxCandles: 2 },
        { interval: "1m", startTime: "2026-03-01T00:00:00.000Z", endTime: "2026-03-01T00:03:00.000Z" },
      ),
    ).toThrowError(new MarketAdapterError("INVALID_INPUT", "Requested range exceeds max 2 candles for interval 1m"));

    expect(() =>
      resolvePriceHistoryRange(
        { ...SUPPORT, defaultLookbacks: { ...SUPPORT.defaultLookbacks, "1d": undefined } },
        { interval: "1d" },
      ),
    ).not.toThrow();

    expect(() =>
      resolvePriceHistoryRange(
        {
          ...SUPPORT,
          defaultInterval: "1d",
          defaultLookbacks: { "1m": "4h", "5m": "1d", "15m": "1d", "1h": "7d", "4h": "30d" },
        },
        { interval: "1d" },
      ),
    ).toThrowError(new MarketAdapterError("INVALID_INPUT", "No default lookback configured for interval 1d"));
  });

  it("returns short candle arrays as-is", () => {
    const candles: CandleData[] = [{
      timestamp: "2026-03-08T00:00:00.000Z",
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 10,
    }];

    expect(resampleCandles([], "1h")).toEqual([]);
    expect(resampleCandles(candles, "1h")).toBe(candles);
  });

  it("resamples candles into sorted buckets and skips invalid timestamps", () => {
    const result = resampleCandles(
      [
        {
          timestamp: "2026-03-08T01:50:00.000Z",
          open: 105,
          high: 110,
          low: 100,
          close: 108,
          volume: 4,
        },
        {
          timestamp: "2026-03-08T00:10:00.000Z",
          open: 90,
          high: 100,
          low: 80,
          close: 95,
          volume: 2,
        },
        {
          timestamp: "not-a-date",
          open: 0,
          high: 0,
          low: 0,
          close: 0,
          volume: 999,
        },
        {
          timestamp: "2026-03-08T00:40:00.000Z",
          open: 95,
          high: 120,
          low: 85,
          close: 118,
          volume: 3,
        },
      ],
      "1h",
    );

    expect(result).toEqual([
      {
        timestamp: "2026-03-08T00:00:00.000Z",
        open: 90,
        high: 120,
        low: 80,
        close: 118,
        volume: 5,
      },
      {
        timestamp: "2026-03-08T01:00:00.000Z",
        open: 105,
        high: 110,
        low: 100,
        close: 108,
        volume: 4,
      },
    ]);
  });

  it("uses UTC calendar boundaries for weekly and monthly candles", () => {
    expect(new Date(floorTimestampToInterval(Date.parse("2026-01-01T18:00:00.000Z"), "1w")).toISOString())
      .toBe("2025-12-29T00:00:00.000Z");
    expect(new Date(floorTimestampToInterval(Date.parse("2026-02-28T23:59:59.000Z"), "1mo")).toISOString())
      .toBe("2026-02-01T00:00:00.000Z");

    const monthly = resampleCandles([
      { timestamp: "2026-01-31T00:00:00.000Z", open: 10, high: 12, low: 9, close: 11, volume: 3 },
      { timestamp: "2026-02-01T00:00:00.000Z", open: 11, high: 14, low: 10, close: 13, volume: 5 },
    ], "1mo");
    expect(monthly.map((candle) => candle.timestamp)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
    ]);
  });

  it("summarizes empty, zero-open, and populated candles", () => {
    expect(summarizeCandles([])).toEqual({
      open: null,
      close: null,
      change: null,
      changePct: null,
      high: null,
      low: null,
      volume: null,
      candleCount: 0,
    });

    const zeroOpen = summarizeCandles([
      {
        timestamp: "2026-03-08T00:00:00.000Z",
        open: 0,
        high: 2,
        low: 0,
        close: 1,
        volume: 3,
      },
    ]);
    expect(zeroOpen.changePct).toBeNull();

    const candles: CandleData[] = [
      {
        timestamp: "2026-03-08T00:00:00.000Z",
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 3,
      },
      {
        timestamp: "2026-03-08T01:00:00.000Z",
        open: 11,
        high: 15,
        low: 8,
        close: 14,
        volume: 4,
      },
    ];

    expect(summarizeCandles(candles)).toEqual({
      open: 10,
      close: 14,
      change: 4,
      changePct: 40,
      high: 15,
      low: 8,
      volume: 7,
      candleCount: 2,
    });
  });

  it("builds result payloads with derived summaries and default resample marker", () => {
    const range = {
      mode: "lookback" as const,
      lookback: "7d" as const,
      asOf: "2026-03-08T00:00:00.000Z",
      startTime: "2026-03-01T00:00:00.000Z",
      endTime: "2026-03-08T00:00:00.000Z",
    };
    const candles: CandleData[] = [
      {
        timestamp: "2026-03-08T00:00:00.000Z",
        open: 10,
        high: 12,
        low: 9,
        close: 11,
        volume: 3,
      },
    ];

    expect(buildPriceHistoryResult({ reference: "BTC", interval: "1h", range, candles })).toEqual({
      reference: "BTC",
      interval: "1h",
      resampledFrom: null,
      range,
      candles,
      summary: {
        open: 10,
        close: 11,
        change: 1,
        changePct: 10,
        high: 12,
        low: 9,
        volume: 3,
        candleCount: 1,
      },
    });
  });
});
