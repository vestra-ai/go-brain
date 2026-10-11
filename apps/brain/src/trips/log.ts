import type pg from 'pg';
import type { TripEvent } from '../door/methods.js';
import type { Log } from '../log.js';

export interface TripLog {
  /**
   * Keeps the event once: 'new', or 'duplicate' for an event_id already kept. `from` is the socket's Server instance (and
   * the Server's own name) that sent it, and the trip's home moves to it on every event, a repeat too: only the Server
   * that has a trip sends its events, and a Server's instance is its container, new on every redeploy (prod, 11 Oct
   * 07:24Z: every older trip waited for the old instance, "no socket from the Server is open").
   */
  append(ev: TripEvent, from?: { instance: string; server?: string | null }): Promise<'new' | 'duplicate'>;
  lastSeq(tripId: string): Promise<number>;
  /** Lanes react to trip changes (memory mirror, tasks, money). Called in change-number order per trip. */
  onEvent(fn: (ev: TripEvent) => void | Promise<void>): void;
}

export type TripLogImpl = TripLog & { emit(ev: TripEvent): Promise<void> };

export function createTripLog(o: {
  pool: pg.Pool;
  log: Log;
  now: () => Date;
  /** Connections of append's own (production): send_event's answer never waits for one the work holds. */
  appendPool?: pg.Pool;
}): TripLogImpl {
  const listeners: Array<(ev: TripEvent) => void | Promise<void>> = [];
  return {
    async append(ev, from) {
      // One statement, so the event and its trip's change number are kept together in one round trip, on the append's
      // own connections (appendPool): send_event's answer never queues behind the work of earlier events (GO-TEAM-FINAL
      // §6, 10 Oct: mandate.set took 2,142 ms, the promise is 2 s). The trip's home is the socket the event came on.
      const db = o.appendPool ?? o.pool;
      const r = await db.query(
        `with kept as (
           insert into trip_events (event_id, trip_id, seq, type, payload, received_at)
           values ($1, $2, $3, $4, $5::jsonb, $6) on conflict (event_id) do nothing
           returning trip_id
         )
         insert into trips (trip_id, last_seq, active_at, server_instance, server_name)
         select trip_id, $3::int, $6::timestamptz, $7::text, $8::text from kept
         on conflict (trip_id) do update set
           last_seq = greatest(trips.last_seq, excluded.last_seq),
           active_at = excluded.active_at,
           server_instance = coalesce(excluded.server_instance, trips.server_instance),
           server_name = case when excluded.server_instance is null then trips.server_name else excluded.server_name end`,
        [ev.event_id, ev.trip_id, ev.seq, ev.type, JSON.stringify(ev), o.now(), from?.instance ?? null, from?.server ?? null],
      );
      if (r.rowCount === 1) return 'new';
      // A repeat sent again from a socket of a new instance (the Server redeployed, then resent) moves the trip there too.
      if (from) {
        await db.query(
          `update trips set server_instance = $2, server_name = $3
            where trip_id = $1 and (server_instance is distinct from $2 or server_name is distinct from $3)`,
          [ev.trip_id, from.instance, from.server ?? null],
        );
      }
      // event_id is unique per Server by contract, so the same id for another trip is the Server's mistake. It is
      // ignored like any repeat (an event is never applied to a trip it was not written for), and said out loud.
      const first = await db.query<{ trip_id: string }>('select trip_id from trip_events where event_id = $1', [ev.event_id]);
      const firstTripId = first.rows[0]?.trip_id;
      if (firstTripId !== undefined && firstTripId !== ev.trip_id) {
        o.log.warn({ eventId: ev.event_id, tripId: ev.trip_id, firstTripId }, 'an event id came again for another trip: ignored');
      }
      return 'duplicate';
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
