import type { Message } from '../door/methods.js';
import type { TripPack } from '../trips/pack.js';

/** Lane B (P2) owns this file; P1 ships the all-unsure stub so the rest of Go can be built first. */
export type Sure<T> = { value: T; sure: true } | { value: T | null; sure: false };

export interface ReflexRead {
  forGo: Sure<boolean>;
  complete: Sure<boolean>;
  size: Sure<'quick' | 'big'>;
  taskId: Sure<string | null>;
  fact: Sure<boolean>;
  recordKind: Sure<'agreed' | 'open' | 'doing' | null>;
  reaction: Sure<string | null>;
  risky: Sure<boolean>;
  opening: Sure<boolean>;
  /** Why question 8 raised caution. Set by P2's reflex. */
  riskWhy?: Array<'spend' | 'steer' | 'secret'>;
  /** The reflex_reads row of this read. Set by P2's reflex. */
  readId?: string;
}

export interface Reflex {
  read(msg: Message, ctx: { pack: TripPack; runningTasks: Array<{ id: string; brief: string }> }): Promise<ReflexRead>;
}

const unsure = { value: null, sure: false } as const;

/** All nine answers unsure: the composer decides everything, exactly as if Jev were not there. */
export const UNSURE_READ: ReflexRead = {
  forGo: unsure,
  complete: unsure,
  size: unsure,
  taskId: unsure,
  fact: unsure,
  recordKind: unsure,
  reaction: unsure,
  risky: unsure,
  opening: unsure,
};

export const unsureReflex: Reflex = {
  read: async () => UNSURE_READ,
};
