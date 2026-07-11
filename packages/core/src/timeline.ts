type TimelineEventBase<TType extends string, TData> = {
  type: TType;
  data: TData;
  reasoning: string | null;
  createdAt: string;
};

export type OrderTimelineEvent = TimelineEventBase<"order" | "order.cancelled", {
  id: string;
  symbol: string;
  market: string;
  side: string;
  quantity: number;
  status: string;
  filledPrice: number | null;
  filledAt: string | null;
  cancelledAt: string | null;
  symbolName: string | null;
}>;

export type JournalTimelineEvent = TimelineEventBase<"journal", {
  id: string;
  content: string;
  tags: string[];
}>;

export type FundingTimelineEvent = TimelineEventBase<"funding.applied", {
  id: string;
  market: string;
  symbol: string;
  quantity: number;
  fundingRate: number;
  payment: number;
  appliedAt: string;
  symbolName: string | null;
}>;

export type LiquidationTimelineEvent = TimelineEventBase<"position.liquidated", {
  id: string;
  market: string;
  symbol: string;
  side: string;
  quantity: number;
  triggerPrice: number;
  executionPrice: number;
  triggerPositionEquity: number;
  maintenanceMargin: number;
  grossPayout: number;
  feeCharged: number;
  netPayout: number;
  liquidatedAt: string;
  cancelledReduceOnlyOrderIds: string[];
  symbolName: string | null;
}>;

export type TimelineEventRecord =
  | OrderTimelineEvent
  | JournalTimelineEvent
  | FundingTimelineEvent
  | LiquidationTimelineEvent;

export type TimelineEventType = TimelineEventRecord["type"];
