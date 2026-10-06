/**
 * Numbers other lanes put on the proof board. A source has a name; adding one with a name that
 * exists replaces it, so P5 can swap the default payments number for the vault's own.
 */
import type pg from 'pg';

export interface StatsWindow { from: Date; to: Date; hours: number }
export interface StatValue { value: number | null; of?: number; note?: string }
export interface StatsSource {
  name: string;
  /** What the board shows above the number. No em dashes, no model or vendor names. */
  label: string;
  order: number;
  /** Which way is good: 'zero' means anything above 0 is a failure. */
  good: 'zero' | 'low' | 'high';
  read(pool: pg.Pool, w: StatsWindow): Promise<StatValue>;
}

export class StatsRegistry {
  private readonly byName = new Map<string, StatsSource>();
  add(s: StatsSource): void {
    this.byName.set(s.name, s);
  }
  list(): StatsSource[] {
    return [...this.byName.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }
}

/** Bookings Go recorded and the Server accepted, with an amount, and how many lacked the Server's approval id. */
export const bookingsWithoutApproval: StatsSource = {
  name: 'payments_without_both_keys',
  label: 'Payments without both keys',
  order: 100,
  good: 'zero',
  async read(pool) {
    const { rows } = await pool.query<{ total: number; missing: number }>(
      `select count(*)::int as total,
              count(*) filter (where coalesce(params->>'approval_id', '') = '')::int as missing
         from go_requests
        where method = 'add_booking'
          and answered_at is not null
          and error is null
          and coalesce((params->>'amount_minor')::bigint, 0) > 0`,
    );
    const r = rows[0] ?? { total: 0, missing: 0 };
    return { value: r.missing, of: r.total, note: "All time. Bookings Go recorded without the Server's signed approval." };
  },
};

const registries = new WeakMap<object, StatsRegistry>();

/** The board's sources for one running brain. Lanes call this from their register function. */
export function statsRegistry(brain: object): StatsRegistry {
  let r = registries.get(brain);
  if (r === undefined) {
    r = new StatsRegistry();
    r.add(bookingsWithoutApproval);
    registries.set(brain, r);
  }
  return r;
}
