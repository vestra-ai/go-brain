/**
 * Keeps a trip's computer awake while people talk travel, so an ixigo.com search never waits on a sleeping box. A box
 * takes about 5.5 s to wake and sleeps again about 7 s after a warm, so Go warms it every 5 s, for 2 minutes after the
 * last travel line. Its first warm wakes the box and goes through the computer's warm limit like any other; the pings
 * after it keep an awake box up. At most WARM_LIMIT trips are kept at once.
 */
import { WARM_LIMIT } from './computer.js';

export const KEEP_WARM_EVERY_MS = 5_000;
export const KEEP_WARM_FOR_MS = 120_000;

export interface KeepWarmDeps {
  /** The first warm: a wake, counted toward Go's warm limit (computer.warm). */
  wake: (tripId: string) => Promise<unknown>;
  /** A warm for a box being kept up: no cooldown (computer.ping). */
  ping: (tripId: string) => Promise<unknown>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
  everyMs?: number;
  forMs?: number;
  limit?: number;
}

export interface KeepWarm {
  /** Travel talk in this trip: keep its computer awake for the next two minutes. */
  touch(tripId: string): void;
  /** One round of pings; the timer runs it every 5 s (tests run it by hand). */
  tick(): Promise<void>;
  /** The trips being kept awake now. */
  kept(): string[];
  stop(): void;
}

export function createKeepWarm(d: KeepWarmDeps): KeepWarm {
  const everyMs = d.everyMs ?? KEEP_WARM_EVERY_MS;
  const forMs = d.forMs ?? KEEP_WARM_FOR_MS;
  const limit = d.limit ?? WARM_LIMIT;
  const until = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const keeper: KeepWarm = {
    touch(tripId) {
      const ends = d.now().getTime() + forMs;
      if (until.has(tripId)) {
        until.set(tripId, ends);
        return;
      }
      if (until.size >= limit) return;
      until.set(tripId, ends);
      d.wake(tripId).catch((err: unknown) => {
        // The warm limit, or the box will not wake: Go stops keeping it, and the next travel line tries again.
        until.delete(tripId);
        d.log.warn({ err, tripId }, 'tasks: keeping the computer warm did not start');
      });
      if (!timer) {
        timer = setInterval(() => void keeper.tick(), everyMs);
        timer.unref();
      }
    },
    async tick() {
      const nowMs = d.now().getTime();
      for (const [tripId, ends] of [...until]) {
        if (nowMs > ends) {
          until.delete(tripId);
          continue;
        }
        await d.ping(tripId).catch((err: unknown) => d.log.warn({ err, tripId }, 'tasks: a keep-warm ping failed'));
      }
      if (until.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    kept: () => [...until.keys()],
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      until.clear();
    },
  };
  return keeper;
}
