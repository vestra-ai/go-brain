import type pg from 'pg';
import type { Log } from '../log.js';

export interface SetupStep {
  name: string;
  /** Runs only once this step is done. */
  after?: string;
  run(tripId: string): Promise<void>;
}

/** Level-triggered setup: every step is safe to repeat, and its done time is kept in trip_setup. */
export interface Setup {
  /** P1 adds 'brain.ready'; P4 adds 'computer.user' and 'computer.warm'. */
  addStep(step: SetupStep): void;
  /** Runs every step not done yet, in order. Safe to repeat. */
  ensureTrip(tripId: string): Promise<void>;
}

export type SetupImpl = Setup & {
  /** ensureTrip in the background, for a trip not known to be ready; at most once every 30 s per trip. */
  ensureSoon(tripId: string): void;
  isReady(tripId: string): boolean;
  /** Finishes setups that stopped halfway; runs every 2 minutes. Returns how many trips it tried. */
  sweep(): Promise<number>;
};

export function createSetup(o: { pool: pg.Pool; log: Log; now: () => Date; retryMs?: number }): SetupImpl {
  const retryMs = o.retryMs ?? 30_000;
  const steps: SetupStep[] = [];
  const ready = new Set<string>();
  const lastTry = new Map<string, number>();
  const inflight = new Map<string, Promise<void>>();

  /** Steps in an order where each comes after the one it waits for. */
  function ordered(): SetupStep[] {
    const names = new Set(steps.map((s) => s.name));
    const placed = new Set<string>();
    const out: SetupStep[] = [];
    let moved = true;
    while (moved) {
      moved = false;
      for (const s of steps) {
        if (placed.has(s.name)) continue;
        if (!s.after || placed.has(s.after) || !names.has(s.after)) {
          out.push(s);
          placed.add(s.name);
          moved = true;
        }
      }
    }
    return out;
  }

  async function mark(tripId: string, step: string, error: string | null): Promise<void> {
    await o.pool.query(
      `insert into trip_setup (trip_id, step, done_at, error, tried_at) values ($1, $2, $3, $4, $5)
       on conflict (trip_id, step) do update set done_at = excluded.done_at, error = excluded.error, tried_at = excluded.tried_at`,
      [tripId, step, error === null ? o.now() : null, error, o.now()],
    );
  }

  async function run(tripId: string): Promise<void> {
    lastTry.set(tripId, o.now().getTime());
    await o.pool.query('insert into trips (trip_id, created_at) values ($1, $2) on conflict (trip_id) do nothing', [tripId, o.now()]);
    const { rows } = await o.pool.query<{ step: string }>('select step from trip_setup where trip_id = $1 and done_at is not null', [tripId]);
    const done = new Set(rows.map((r) => r.step));
    for (const s of ordered()) {
      if (done.has(s.name)) continue;
      if (s.after && !done.has(s.after)) {
        await mark(tripId, s.name, `waits for ${s.after}`);
        continue;
      }
      try {
        await s.run(tripId);
        await mark(tripId, s.name, null);
        done.add(s.name);
      } catch (e) {
        await mark(tripId, s.name, (e instanceof Error ? e.message : String(e)).slice(0, 500));
        o.log.warn({ err: e, trip: tripId, step: s.name }, 'a setup step failed; the sweep tries again');
      }
    }
    if (steps.every((s) => done.has(s.name))) ready.add(tripId);
  }

  function ensureTrip(tripId: string): Promise<void> {
    const cur = inflight.get(tripId);
    if (cur) return cur;
    const p = run(tripId).finally(() => inflight.delete(tripId));
    inflight.set(tripId, p);
    return p;
  }

  return {
    addStep(step) {
      if (steps.some((s) => s.name === step.name)) throw new Error(`setup step ${step.name} is already added`);
      steps.push(step);
      ready.clear(); // a new step is not done anywhere yet
    },
    ensureTrip,
    ensureSoon(tripId) {
      if (ready.has(tripId) || inflight.has(tripId)) return;
      const last = lastTry.get(tripId);
      if (last !== undefined && o.now().getTime() - last < retryMs) return;
      void ensureTrip(tripId).catch((e: unknown) => o.log.error({ err: e, trip: tripId }, 'setup failed'));
    },
    isReady: (tripId) => ready.has(tripId),
    async sweep() {
      if (steps.length === 0) return 0;
      const { rows } = await o.pool.query<{ trip_id: string }>(
        `select t.trip_id from trips t
         where exists (
           select 1 from unnest($1::text[]) as s(step)
           where not exists (select 1 from trip_setup ts where ts.trip_id = t.trip_id and ts.step = s.step and ts.done_at is not null))
         order by t.active_at desc limit 50`,
        [steps.map((s) => s.name)],
      );
      for (const r of rows) await ensureTrip(r.trip_id);
      return rows.length;
    },
  };
}
