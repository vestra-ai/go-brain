// Keeps a live card fresh without flooding the Server: at most one update every `minGapMs`, always the
// latest, in order, and the final card always lands.
import type { Schedule } from '../proactive/clock.js';

export class CardUpdater<C> {
  private latest: C | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;
  private cancelTimer: (() => void) | null = null;
  private stopped = false;

  constructor(
    private readonly send: (card: C) => Promise<void>,
    private readonly o: { now: () => Date; schedule: Schedule; minGapMs: number; log: { warn(obj: object, msg: string): void } },
  ) {}

  update(card: C): void {
    if (this.stopped) return;
    this.latest = card;
    this.pump();
  }

  /** Drops anything pending, waits for an update in flight, then sends this card. */
  async final(card: C): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.latest = null;
    if (this.inFlight) await this.inFlight;
    await this.send(card);
  }

  private pump(): void {
    if (this.stopped || this.inFlight || this.cancelTimer || this.latest === null) return;
    const wait = this.lastSentAt + this.o.minGapMs - this.o.now().getTime();
    if (wait > 0) {
      this.cancelTimer = this.o.schedule(() => {
        this.cancelTimer = null;
        this.pump();
      }, wait);
      return;
    }
    const card = this.latest;
    this.latest = null;
    this.lastSentAt = this.o.now().getTime();
    this.inFlight = this.send(card)
      .catch((err: unknown) => this.o.log.warn({ err }, 'calls: a live card update failed'))
      .finally(() => {
        this.inFlight = null;
        this.pump();
      });
  }
}
