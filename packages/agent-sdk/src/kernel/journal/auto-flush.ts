/**
 * Continue anywhere (spec §6.3) — the Journal's `autoFlushMs` timers. A trailing debounce that every
 * append pushes back, with a max wait of twice it that only the first append of a quiet stretch arms
 * (later appends never push it back): appends under autoFlushMs apart, a busy turn, still mirror at
 * least every 2 × autoFlushMs instead of waiting for a quiet gap. Whichever fires first clears both
 * and flushes. Both are unref'd, so a pending flush never holds a process open.
 */
export class AutoFlushTimers {
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private maxWait: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly flush: () => void) {}

  /** An append landed: push the debounce back, and arm the max wait if this stretch has none. */
  arm(ms: number): void {
    clearTimeout(this.debounce);
    this.debounce = unrefd(setTimeout(this.fire, ms));
    this.maxWait ??= unrefd(setTimeout(this.fire, 2 * ms));
  }

  /** Forget both: one fired, or the journal dropped its queue (Journal.reset). */
  clear(): void {
    clearTimeout(this.debounce);
    clearTimeout(this.maxWait);
    this.debounce = this.maxWait = undefined;
  }

  private readonly fire = (): void => {
    this.clear();
    this.flush();
  };
}

function unrefd<T>(timer: T): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}
