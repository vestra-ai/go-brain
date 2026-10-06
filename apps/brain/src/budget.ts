// The daily model budget: a hard cap, in USD, on what this Go's model calls may cost in one UTC day
// (MODEL_DAILY_BUDGET_USD; unset means no cap). Every model call checks it first and records its cost after. The total
// is kept in process, and read back from model_spend at boot and on a slow interval, so a restart starts from it.
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
  /** True when a model call may go ahead: there is no cap, or today's spend is still under it. */
  allows(): boolean;
  /** What today's model calls (UTC) have cost so far, in USD. */
  spentToday(): number;
  /** One model call's cost: added at once, and kept in the database. Never throws. */
  spend(o: { purpose: string; model: string; usd: number }): Promise<void>;
  /** Reads today's total back from the database: at boot, and on a slow interval. */
  refresh(): Promise<void>;
}

/** "2026-10-06" for any moment of that UTC day. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** The request id of the one "today's limit" line in a trip on a UTC day: the same on every try, so the Server posts it once. */
export function limitRequestId(tripId: string, day: string): string {
  return `go_limit_${createHash('sha256').update(`${tripId}\u0000${day}`).digest('hex').slice(0, 32)}`;
}

export function createBudget(o: { pool: pg.Pool; now: () => Date; capUsd: number | null; log: Log }): Budget {
  let day = utcDay(o.now());
  let spent = 0;
  /** A new UTC day starts from nothing. */
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
      return o.capUsd === null || spent < o.capUsd;
    },
    spentToday() {
      today();
      return spent;
    },
    async spend({ purpose, model, usd }) {
      today();
      spent += usd;
      try {
        await o.pool.query('insert into model_spend (at, purpose, model, cost_usd) values ($1, $2, $3, $4)', [o.now(), purpose, model, usd]);
      } catch (err) {
        o.log.warn({ err, purpose }, 'budget: keeping a model call cost failed; the total in this process still has it');
      }
    },
    async refresh() {
      const now = o.now();
      const { rows } = await o.pool.query<{ usd: string }>(
        'select coalesce(sum(cost_usd), 0)::text as usd from model_spend where at >= $1',
        [new Date(`${utcDay(now)}T00:00:00Z`)],
      );
      today();
      // Never below this process's own total: a cost added here may not be in the database yet.
      spent = Math.max(spent, Number(rows[0]?.usd ?? 0));
    },
  };
}
