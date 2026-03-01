export const INITIAL_BALANCE = 100_000;

export type Position = {
  quantity: number;
  avgCost: number;
};

export type ExecutionInput = {
  balance: number;
  position?: Position | null;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  allowShort?: boolean;
};

export type ExecutionResult = {
  nextBalance: number;
  nextPosition: Position | null;
  realizedPnl: number;
};

export class TradingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const roundCurrency = (value: number): number => Number(value.toFixed(6));

export const executeFill = (input: ExecutionInput): ExecutionResult => {
  const allowShort = input.allowShort ?? false;
  const current = input.position ?? { quantity: 0, avgCost: 0 };
  const gross = input.quantity * input.price;

  if (input.side === "buy") {
    if (input.balance < gross) {
      throw new TradingError("INSUFFICIENT_BALANCE", "Insufficient balance for this order");
    }

    const newQuantity = current.quantity + input.quantity;
    const weightedCost = current.quantity * current.avgCost + gross;
    const nextAvgCost = newQuantity === 0 ? 0 : weightedCost / newQuantity;

    return {
      nextBalance: roundCurrency(input.balance - gross),
      nextPosition: { quantity: newQuantity, avgCost: roundCurrency(nextAvgCost) },
      realizedPnl: 0,
    };
  }

  if (!allowShort && current.quantity < input.quantity) {
    throw new TradingError("INSUFFICIENT_POSITION", "Cannot sell more than current position");
  }

  const nextQuantity = current.quantity - input.quantity;
  const realizedPnl = input.quantity * (input.price - current.avgCost);

  return {
    nextBalance: roundCurrency(input.balance + gross),
    nextPosition:
      nextQuantity === 0
        ? null
        : {
            quantity: nextQuantity,
            avgCost: current.avgCost,
          },
    realizedPnl: roundCurrency(realizedPnl),
  };
};

export const calculateUnrealizedPnl = (position: Position, markPrice: number): number => {
  return roundCurrency((markPrice - position.avgCost) * position.quantity);
};

export const calculateMarketValue = (position: Position, markPrice: number): number => {
  return roundCurrency(position.quantity * markPrice);
};
