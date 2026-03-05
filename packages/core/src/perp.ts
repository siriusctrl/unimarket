import { TradingError } from "./engine.js";

export type PerpPosition = {
  quantity: number;
  avgCost: number;
  margin: number;
  leverage: number;
  maintenanceMarginRatio: number;
};

export type PerpExecutionInput = {
  balance: number;
  position?: PerpPosition | null;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  leverage: number;
  maintenanceMarginRatio: number;
  reduceOnly?: boolean;
  takerFeeRate?: number;
};

export type PerpExecutionResult = {
  nextBalance: number;
  nextPosition: PerpPosition | null;
  realizedPnl: number;
  feePaid: number;
};

const roundCurrency = (value: number): number => Number(value.toFixed(6));

const signedDelta = (side: "buy" | "sell", quantity: number): number => {
  return side === "buy" ? quantity : -quantity;
};

const notional = (quantityAbs: number, price: number): number => {
  return quantityAbs * price;
};

const initialMargin = (quantityAbs: number, price: number, leverage: number): number => {
  return notional(quantityAbs, price) / leverage;
};

const realizedPnlForClose = (positionQty: number, avgCost: number, executionPrice: number, closeQtyAbs: number): number => {
  if (positionQty > 0) {
    // long close
    return closeQtyAbs * (executionPrice - avgCost);
  }
  // short close
  return closeQtyAbs * (avgCost - executionPrice);
};

export const calculatePerpUnrealizedPnl = (position: Pick<PerpPosition, "quantity" | "avgCost">, markPrice: number): number => {
  return roundCurrency((markPrice - position.avgCost) * position.quantity);
};

export const calculatePerpMaintenanceMargin = (
  position: Pick<PerpPosition, "quantity" | "maintenanceMarginRatio">,
  markPrice: number,
): number => {
  return roundCurrency(Math.abs(position.quantity) * markPrice * position.maintenanceMarginRatio);
};

export const calculatePerpPositionEquity = (
  position: Pick<PerpPosition, "quantity" | "avgCost" | "margin">,
  markPrice: number,
): number => {
  const unrealized = calculatePerpUnrealizedPnl(position, markPrice);
  return roundCurrency(position.margin + unrealized);
};

export const calculatePerpLiquidationPrice = (
  position: Pick<PerpPosition, "quantity" | "avgCost" | "margin" | "maintenanceMarginRatio">,
): number | null => {
  if (position.quantity === 0) return null;

  const absQty = Math.abs(position.quantity);
  const mmr = position.maintenanceMarginRatio;

  if (position.quantity > 0) {
    const denominator = absQty * (1 - mmr);
    if (denominator <= 0) return null;
    const liq = (absQty * position.avgCost - position.margin) / denominator;
    return liq > 0 && Number.isFinite(liq) ? roundCurrency(liq) : null;
  }

  const denominator = absQty * (1 + mmr);
  if (denominator <= 0) return null;
  const liq = (position.margin + absQty * position.avgCost) / denominator;
  return liq > 0 && Number.isFinite(liq) ? roundCurrency(liq) : null;
};

const validateExecutionInput = (input: PerpExecutionInput): void => {
  if (!(input.quantity > 0)) {
    throw new TradingError("INVALID_INPUT", "quantity must be greater than 0");
  }
  if (!(input.price > 0)) {
    throw new TradingError("INVALID_INPUT", "price must be greater than 0");
  }
  if (!(input.leverage > 0)) {
    throw new TradingError("INVALID_INPUT", "leverage must be greater than 0");
  }
  if (!(input.maintenanceMarginRatio >= 0) || !(input.maintenanceMarginRatio < 1)) {
    throw new TradingError("INVALID_INPUT", "maintenanceMarginRatio must be within [0, 1)");
  }
};

export const executePerpFill = (input: PerpExecutionInput): PerpExecutionResult => {
  validateExecutionInput(input);

  const reduceOnly = input.reduceOnly ?? false;
  const takerFeeRate = input.takerFeeRate ?? 0;
  if (takerFeeRate < 0 || takerFeeRate >= 1 || Number.isNaN(takerFeeRate)) {
    throw new TradingError("INVALID_INPUT", "takerFeeRate must be within [0, 1)");
  }
  const current = input.position ?? null;
  const delta = signedDelta(input.side, input.quantity);
  const feePaid = roundCurrency(notional(Math.abs(input.quantity), input.price) * takerFeeRate);

  if (current) {
    if (current.quantity === 0) {
      throw new TradingError("INVALID_POSITION", "position quantity cannot be zero");
    }
    if (current.margin < 0) {
      throw new TradingError("INVALID_POSITION", "position margin cannot be negative");
    }
  }

  if (reduceOnly) {
    if (!current) {
      throw new TradingError("INVALID_ORDER", "reduceOnly order requires an existing position");
    }
    if (Math.sign(current.quantity) === Math.sign(delta)) {
      throw new TradingError("INVALID_ORDER", "reduceOnly order must reduce current position");
    }
    if (Math.abs(delta) > Math.abs(current.quantity)) {
      throw new TradingError("INVALID_ORDER", "reduceOnly order cannot flip position");
    }
  }

  if (!current) {
    const requiredMargin = initialMargin(Math.abs(delta), input.price, input.leverage);
    if (input.balance < requiredMargin + feePaid) {
      throw new TradingError("INSUFFICIENT_MARGIN", "Insufficient balance for initial margin");
    }
    return {
      nextBalance: roundCurrency(input.balance - requiredMargin - feePaid),
      nextPosition: {
        quantity: delta,
        avgCost: roundCurrency(input.price),
        margin: roundCurrency(requiredMargin),
        leverage: roundCurrency(input.leverage),
        maintenanceMarginRatio: roundCurrency(input.maintenanceMarginRatio),
      },
      realizedPnl: 0,
      feePaid,
    };
  }

  const currentQty = current.quantity;
  const currentAbs = Math.abs(currentQty);
  const deltaAbs = Math.abs(delta);
  const sameDirection = Math.sign(currentQty) === Math.sign(delta);

  // Increase same-direction exposure.
  if (sameDirection) {
    if (Math.abs(current.leverage - input.leverage) > 1e-9) {
      throw new TradingError("LEVERAGE_MISMATCH", "Cannot increase position with a different leverage");
    }

    const requiredMargin = initialMargin(deltaAbs, input.price, current.leverage);
    if (input.balance < requiredMargin + feePaid) {
      throw new TradingError("INSUFFICIENT_MARGIN", "Insufficient balance for initial margin");
    }

    const nextAbs = currentAbs + deltaAbs;
    const nextAvg = (currentAbs * current.avgCost + deltaAbs * input.price) / nextAbs;

    return {
      nextBalance: roundCurrency(input.balance - requiredMargin - feePaid),
      nextPosition: {
        quantity: currentQty + delta,
        avgCost: roundCurrency(nextAvg),
        margin: roundCurrency(current.margin + requiredMargin),
        leverage: current.leverage,
        maintenanceMarginRatio: current.maintenanceMarginRatio,
      },
      realizedPnl: 0,
      feePaid,
    };
  }

  // Reduce or flip.
  const closeAbs = Math.min(currentAbs, deltaAbs);
  const realized = realizedPnlForClose(currentQty, current.avgCost, input.price, closeAbs);
  const releasedMargin = current.margin * (closeAbs / currentAbs);
  let balanceAfterClose = input.balance + releasedMargin + realized - feePaid;

  if (Math.abs(deltaAbs - currentAbs) < 1e-9) {
    // Flat after close.
    return {
      nextBalance: roundCurrency(Math.max(balanceAfterClose, 0)),
      nextPosition: null,
      realizedPnl: roundCurrency(realized),
      feePaid,
    };
  }

  if (deltaAbs < currentAbs) {
    // Partial reduce, keep current direction and leverage.
    const remainingQty = currentQty + delta;
    const remainingMargin = current.margin - releasedMargin;
    return {
      nextBalance: roundCurrency(Math.max(balanceAfterClose, 0)),
      nextPosition: {
        quantity: remainingQty,
        avgCost: current.avgCost,
        margin: roundCurrency(remainingMargin),
        leverage: current.leverage,
        maintenanceMarginRatio: current.maintenanceMarginRatio,
      },
      realizedPnl: roundCurrency(realized),
      feePaid,
    };
  }

  // Flip: close old side, then open remaining notional on opposite side.
  const openingAbs = deltaAbs - currentAbs;
  const requiredMargin = initialMargin(openingAbs, input.price, input.leverage);
  if (balanceAfterClose < requiredMargin) {
    throw new TradingError("INSUFFICIENT_MARGIN", "Insufficient balance for flipped position initial margin");
  }
  balanceAfterClose -= requiredMargin;

  return {
    nextBalance: roundCurrency(Math.max(balanceAfterClose, 0)),
    nextPosition: {
      quantity: Math.sign(delta) * openingAbs,
      avgCost: roundCurrency(input.price),
      margin: roundCurrency(requiredMargin),
      leverage: roundCurrency(input.leverage),
      maintenanceMarginRatio: roundCurrency(input.maintenanceMarginRatio),
    },
    realizedPnl: roundCurrency(realized),
    feePaid,
  };
};
