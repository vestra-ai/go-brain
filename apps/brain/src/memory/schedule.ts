/** Per-trip timers: run once after a quiet spell, but never later than a longest wait. */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
export const realTimers: Timers = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clear: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface Debouncer {
  after(key: string, ms: number, fn: () => void, maxWaitMs?: number): void;
  cancel(key: string): void;
  /** Clears every waiting timer; registerMemory hands this to brain.onStop. */
  cancelAll(): void;
  pending(key: string): boolean;
}

export function createDebouncer(timers: Timers, now: () => number): Debouncer {
  const slots = new Map<string, { handle: unknown; firstAt: number }>();
  return {
    after(key, ms, fn, maxWaitMs) {
      const had = slots.get(key);
      const firstAt = had?.firstAt ?? now();
      if (had) timers.clear(had.handle);
      const wait = maxWaitMs === undefined ? ms : Math.max(0, Math.min(ms, firstAt + maxWaitMs - now()));
      const handle = timers.set(() => {
        slots.delete(key);
        fn();
      }, wait);
      slots.set(key, { handle, firstAt });
    },
    cancel(key) {
      const had = slots.get(key);
      if (!had) return;
      timers.clear(had.handle);
      slots.delete(key);
    },
    cancelAll() {
      for (const s of slots.values()) timers.clear(s.handle);
      slots.clear();
    },
    pending(key) {
      return slots.has(key);
    },
  };
}
