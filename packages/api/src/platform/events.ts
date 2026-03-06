export type EventType =
  | "system.ready"
  | "order.filled"
  | "order.cancelled"
  | "position.settled"
  | "funding.applied"
  | "position.liquidated";

type UserScopedEventType = Exclude<EventType, "system.ready">;

type BaseEvent<TType extends UserScopedEventType, TData extends Record<string, unknown>> = {
  type: TType;
  userId: string;
  accountId: string;
  orderId?: string;
  data: TData;
};

export type OrderFilledEvent = BaseEvent<
  "order.filled",
  {
    market: string;
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    executionPrice: number;
    filledAt: string;
    limitPrice: number | null;
  }
>;

export type OrderCancelledEvent = BaseEvent<
  "order.cancelled",
  {
    market: string;
    symbol: string;
    side: string;
    quantity: number;
    reasoning: string;
    cancelledAt: string;
  }
>;

export type PositionSettledEvent = BaseEvent<
  "position.settled",
  {
    market: string;
    symbol: string;
    quantity: number;
    settlementPrice: number;
    proceeds: number;
    settledAt: string;
  }
>;

export type FundingAppliedEvent = BaseEvent<
  "funding.applied",
  {
    market: string;
    symbol: string;
    quantity: number;
    fundingRate: number;
    payment: number;
    appliedAt: string;
  }
>;

export type PositionLiquidatedEvent = BaseEvent<
  "position.liquidated",
  {
    liquidationId: string;
    market: string;
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    triggerPrice: number;
    executionPrice: number;
    triggerPositionEquity: number;
    maintenanceMargin: number;
    grossPayout: number;
    feeCharged: number;
    netPayout: number;
    cancelledReduceOnlyOrderIds: string[];
    liquidatedAt: string;
  }
>;

export type SystemReadyEvent = {
  type: "system.ready";
  data: { version: string; connectedAt: string };
};

export type TradingEvent =
  | SystemReadyEvent
  | OrderFilledEvent
  | OrderCancelledEvent
  | PositionSettledEvent
  | FundingAppliedEvent
  | PositionLiquidatedEvent;
export type EmittedTradingEvent = Exclude<TradingEvent, SystemReadyEvent>;
export type SequencedTradingEvent = EmittedTradingEvent & { id: string; emittedAt: string };
export type TradingEventListener = (event: SequencedTradingEvent) => void;

const ALL_USERS_CHANNEL = "*";
export const ALL_EVENTS_SUBSCRIBER = ALL_USERS_CHANNEL;

class EventBus {
  static readonly ALL_USERS = ALL_USERS_CHANNEL;
  private listenersByUserId = new Map<string, Set<TradingEventListener>>();
  private sequence = 0;
  private readonly maxHistory = 1000;
  private history: SequencedTradingEvent[] = [];

  emit(event: EmittedTradingEvent): SequencedTradingEvent {
    this.sequence += 1;
    const sequenced: SequencedTradingEvent = {
      ...event,
      id: String(this.sequence),
      emittedAt: new Date().toISOString(),
    };

    this.history.push(sequenced);
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }

    this.dispatch(sequenced.userId, sequenced);
    this.dispatch(ALL_EVENTS_SUBSCRIBER, sequenced);
    return sequenced;
  }

  subscribe(userId: string, callback: TradingEventListener): () => void {
    const listeners = this.listenersByUserId.get(userId) ?? new Set<TradingEventListener>();
    listeners.add(callback);
    this.listenersByUserId.set(userId, listeners);
    return () => this.unsubscribe(userId, callback);
  }

  unsubscribe(userId: string, callback: TradingEventListener): void {
    const listeners = this.listenersByUserId.get(userId);
    if (!listeners) return;
    listeners.delete(callback);
    if (listeners.size === 0) {
      this.listenersByUserId.delete(userId);
    }
  }

  replay(userId: string, sinceEventId: number): SequencedTradingEvent[] {
    return this.history.filter((event) => {
      const id = Number(event.id);
      if (!Number.isFinite(id) || id <= sinceEventId) {
        return false;
      }

      if (userId === ALL_EVENTS_SUBSCRIBER) {
        return true;
      }

      return event.userId === userId;
    });
  }

  private dispatch(userId: string, event: SequencedTradingEvent): void {
    const listeners = this.listenersByUserId.get(userId);
    if (!listeners) return;

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[eventBus] listener error", error);
      }
    }
  }
}

export const eventBus = new EventBus();
