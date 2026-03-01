type CacheValue<T> = {
  value: T;
  expiresAt: number;
};

export class TtlCache {
  private readonly store = new Map<string, CacheValue<unknown>>();

  get<T>(key: string): T | undefined {
    const item = this.store.get(key);
    if (!item) {
      return undefined;
    }

    if (Date.now() >= item.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return item.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }
}
