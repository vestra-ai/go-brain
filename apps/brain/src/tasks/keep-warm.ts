/**
 * Keeps a trip's computer awake while its people ask for travel, so an ixigo.com search never waits on a sleeping box (a
 * box takes 3 to 5.5 s to wake). Called only through travel's warmForTravel. One warm asks Bash to hold the box awake for
 * 2 minutes once it is up (keep_ms); travel intent that comes when the hold has under 20 s left extends it with one more. That is about one call per 100 s per
 * trip, inside /v1's rate, and each counts as one wake toward Go's warm limit.
 */
export const KEEP_MS = 120_000;
/** A hold with less than this left is extended by the next travel intent in the trip. */
export const EXTEND_WITHIN_MS = 20_000;
const HOLDS_MAX = 500;

export interface KeepWarmDeps {
  /** The trip's browser's warm with a hold (browsers.warm). */
  warm: (tripId: string, keepMs: number) => Promise<unknown>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
}

export interface KeepWarm {
  /** Travel intent in this trip: hold its computer awake for the next two minutes. */
  touch(tripId: string): void;
}

export function createKeepWarm(d: KeepWarmDeps): KeepWarm {
  /** When each trip's hold ends, as Go asked for it. */
  const holds = new Map<string, number>();
  return {
    touch(tripId) {
      const nowMs = d.now().getTime();
      const ends = holds.get(tripId) ?? 0;
      if (nowMs < ends - EXTEND_WITHIN_MS) return;
      holds.delete(tripId);
      holds.set(tripId, nowMs + KEEP_MS);
      while (holds.size > HOLDS_MAX) {
        const oldest = holds.keys().next().value;
        if (oldest === undefined) break;
        holds.delete(oldest);
      }
      d.warm(tripId, KEEP_MS).catch((err: unknown) => {
        // The warm limit, or the box won't wake: no hold, so the next line asks again.
        holds.delete(tripId);
        d.log.warn({ err, tripId }, 'tasks: holding the computer awake did not start');
      });
    },
  };
}
