import type { Quote } from "./types.js";

export const getExecutionPrice = (quote: Pick<Quote, "price" | "bid" | "ask">, side: "buy" | "sell"): number =>
  side === "buy" ? quote.ask ?? quote.price : quote.bid ?? quote.price;
