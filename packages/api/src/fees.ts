const toMarketEnvKey = (marketId: string): string => {
  return marketId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
};

const parseRate = (raw: string | undefined, variableName: string): number => {
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed >= 1) {
    throw new Error(`${variableName} must be a number in [0, 1)`);
  }
  return parsed;
};

export const getTakerFeeRate = (marketId: string): number => {
  const marketKey = `${toMarketEnvKey(marketId)}_TAKER_FEE_RATE`;
  const marketRateRaw = process.env[marketKey];
  if (marketRateRaw !== undefined && marketRateRaw.trim() !== "") {
    return parseRate(marketRateRaw, marketKey);
  }

  return parseRate(process.env.DEFAULT_TAKER_FEE_RATE, "DEFAULT_TAKER_FEE_RATE");
};
