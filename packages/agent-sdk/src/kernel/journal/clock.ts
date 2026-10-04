import { randomUUID } from 'node:crypto';

/** Injectable time + identity so the journal core is pure and deterministic in tests. */
export interface Clock {
  now(): string;   // ISO timestamp
  uuid(): string;  // unique entry id
}

/** Deterministic clock for tests: monotonic ids, fixed timestamp. */
export function sequentialClock(fixedIso: string): Clock {
  let n = 0;
  return { now: () => fixedIso, uuid: () => `entry-${n++}` };
}

/** Real clock for production. randomUUID is allowed here (impure boundary, not pure core). */
export function systemClock(): Clock {
  return {
    now: () => new Date().toISOString(),
    uuid: () => randomUUID(),
  };
}
