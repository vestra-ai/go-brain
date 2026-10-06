// The daily model budget: a hard cap, in USD, on what this Go's model calls may cost in one UTC day
// (MODEL_DAILY_BUDGET_USD; unset means no cap). Every model call reserves an upper-bound estimate first, which fails
// once it would pass the cap, and settles to its real cost after, finished or not. The settled costs are kept in
// model_spend and read back at boot and on a slow interval, so a restart starts from them.
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Log } from './log.js';

export class OverBudget extends Error {
  constructor() {
    super("over today's model budget");
    this.name = 'OverBudget';
  }
}

export interface Budget {
  /** The cap for one UTC day, in USD, or null for no cap. */
  readonly capUsd: number | null;
  /** True while there is room left today: no cap, or what is spent and held is still under it. */
  allows(): boolean;
  /** What today's model calls (UTC) cost so far, in USD: the settled calls and those still running (at their estimate). */
  spentToday(): number;
  /**
   * Holds `usd` (an upper-bound estimate) for one model call, or null when it would take today past the cap. The check
   * and the hold happen at once, so calls running at the same moment can never all pass near the cap.
   */
  reserve(o: { purpose: string; model: string; usd: number }): Reservation | null;
  /** Reads today's settled total back from the database: at boot, and on a slow interval. */
  refresh(): Promise<void>;
}

export interface Reservation {
  /**
   * The call is over: its real cost from the usage it reported, or null when no usage arrived (the call failed before
   * Anthropic said anything), and then the hold is kept as spent. Recorded once, in model_spend. Never throws.
   */
  settle(actualUsd: number | null): Promise<void>;
}

/** "2026-10-06" for any moment of that UTC day. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** The request id of the one "today's limit" line in a trip on a UTC day: the same on every try, so the Server posts it once. */
export function limitRequestId(tripId: string, day: string): string {
  return `go_limit_${createHash('sha256').update(`${tripId}\u0000${day}`).digest('hex').slice(0, 32)}`;
}

export function createBudget(o: { pool: pg.Pool; now: () => Date; capUsd: number | null; log: Log }): Budget {
  let day = utcDay(o.now());
  /** Settled today. */
  let spent = 0;
  /** Held by calls still running. */
  let held = 0;
  /** A new UTC day starts from nothing settled; calls still running keep their holds. */
  const today = (): void => {
    const d = utcDay(o.now());
    if (d !== day) {
      day = d;
      spent = 0;
    }
  };
  return {
    capUsd: o.capUsd,
    allows() {
      today();
      return o.capUsd === null || spent + held < o.capUsd;
    },
    spentToday() {
      today();
      return spent + held;
    },
    reserve({ purpose, model, usd }) {
      today();
      if (o.capUsd !== null && spent + held + usd > o.capUsd) return null;
      held += usd;
      let settled = false;
      return {
        async settle(actualUsd) {
          if (settled) return;
          settled = true;
          held = Math.max(0, held - usd);
          const cost = actualUsd ?? usd;
          today();
          spent += cost;
          try {
            await o.pool.query('insert into model_spend (at, purpose, model, cost_usd) values ($1, $2, $3, $4)', [o.now(), purpose, model, cost]);
          } catch (err) {
            o.log.warn({ err, purpose }, 'budget: keeping a model call cost failed; the total in this process still has it');
          }
        },
      };
    },
    async refresh() {
      const now = o.now();
      const { rows } = await o.pool.query<{ usd: string }>(
        'select coalesce(sum(cost_usd), 0)::text as usd from model_spend where at >= $1',
        [new Date(`${utcDay(now)}T00:00:00Z`)],
      );
      today();
      // Never below this process's own total: a cost settled here may not be in the database yet.
      spent = Math.max(spent, Number(rows[0]?.usd ?? 0));
    },
  };
}
