import type { FundingDirection } from "./admin-api";

const fundingRateFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  signDisplay: "exceptZero",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});

const annualizedFundingRateFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  signDisplay: "exceptZero",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export const formatFundingRate = (rate: number | null | undefined): string => {
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    return "N/A";
  }

  return fundingRateFormatter.format(rate);
};

export const formatAnnualizedFundingRate = (rate: number | null | undefined): string => {
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    return "N/A";
  }

  return annualizedFundingRateFormatter.format(rate);
};

export const describeFundingDirection = (
  direction: FundingDirection | null | undefined,
  rate: number | null | undefined,
): string => {
  if (direction === "long_pays_short") return "Longs pay shorts";
  if (direction === "short_pays_long") return "Shorts pay longs";

  if (typeof rate === "number") {
    if (rate > 0) return "Longs pay shorts";
    if (rate < 0) return "Shorts pay longs";
  }

  return "No funding transfer";
};

export const formatFundingTime = (value: string | null | undefined): string => {
  if (!value) {
    return "unknown";
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(timestamp));
};

export const formatFundingCadence = (intervalHours: number | null | undefined): string => {
  if (typeof intervalHours !== "number" || !Number.isFinite(intervalHours) || intervalHours <= 0) {
    return "unknown cadence";
  }

  const minutes = intervalHours * 60;
  if (Number.isInteger(minutes) && minutes < 60) {
    return `${minutes}m`;
  }

  if (Number.isInteger(minutes) && minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }

  return `${intervalHours.toFixed(intervalHours < 1 ? 2 : 1)}h`;
};
