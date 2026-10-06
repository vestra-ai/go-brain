import type pg from 'pg';
import type { TripEvent } from '../door/methods.js';
import type { Log } from '../log.js';

export interface TripLog {
  append(ev: TripEvent): Promise<'new' | 'duplicate'>;
  lastSeq(tripId: string): Promise<number>;
  /** Lanes react to trip changes (memory mirror, tasks, money). Called in change-number order per trip. */
  onEvent(fn: (ev: TripEvent) => void | Promise<void>): void;
}

export type TripLogImpl = TripLog & { emit(ev: TripEvent): Promise<void> };

export function createTripLog(o: { pool: pg.Pool; log: Log; now: () => Date }): TripLogImpl {
  const listeners: Array<(ev: TripEvent) => void | Promise<void>> = [];
  return {
    async append(ev) {
      const c = await o.pool.connect();
      try {
        await c.query('begin');
        const r = await c.query(
          `insert into trip_events (event_id, trip_id, seq, type, payload, received_at)
           values ($1, $2, $3, $4, $5::jsonb, $6) on conflict (event_id) do nothing`,
          [ev.event_id, ev.trip_id, ev.seq, ev.type, JSON.stringify(ev), o.now()],
        );
        if (r.rowCount === 1) {
          await c.query(
            `insert into trips (trip_id, last_seq, active_at) values ($1, $2, $3)
             on conflict (trip_id) do update set last_seq = greatest(trips.last_seq, excluded.last_seq), active_at = excluded.active_at`,
            [ev.trip_id, ev.seq, o.now()],
          );
        } else {
          // event_id is unique per Server by contract, so the same id for another trip is the Server's mistake. It is
          // ignored like any repeat (an event is never applied to a trip it was not written for), and said out loud.
          const first = await c.query<{ trip_id: string }>('select trip_id from trip_events where event_id = $1', [ev.event_id]);
          const firstTripId = first.rows[0]?.trip_id;
          if (firstTripId !== undefined && firstTripId !== ev.trip_id) {
            o.log.warn({ eventId: ev.event_id, tripId: ev.trip_id, firstTripId }, 'an event id came again for another trip: ignored');
          }
        }
        await c.query('commit');
        return r.rowCount === 1 ? 'new' : 'duplicate';
      } catch (e) {
        await c.query('rollback');
        throw e;
      } finally {
        c.release();
      }
    },
    async lastSeq(tripId) {
      const { rows } = await o.pool.query<{ last_seq: number }>('select last_seq from trips where trip_id = $1', [tripId]);
      return rows[0]?.last_seq ?? 0;
    },
    onEvent(fn) {
      listeners.push(fn);
    },
    async emit(ev) {
      for (const fn of listeners) {
        try {
          await fn(ev);
        } catch (e) {
          o.log.error({ err: e, event: ev.event_id, type: ev.type }, 'a trip log listener failed');
        }
      }
    },
  };
}
