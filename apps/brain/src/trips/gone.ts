// A trip the Server no longer has (the try room forgets old trips, a trip is deleted): Go marks it gone the first time
// the Server answers a read of it with 404 not_found, and every sweep leaves it alone. 5xx and timeouts are not an
// answer, so they keep their retries. Only the trip's own Server instance can say so: another Server sharing this Go
// (a drill, a rehearsal) never had the trip, so its 404 says nothing about it. From the mark on, Go never reads the
// trip again on its own: loading its pack throws TripGoneError instead. An event from the Server for the trip, or a
// successful read_trip, clears the mark.
import type pg from 'pg';
import type { ToServerMethod } from '../door/methods.js';
import { SocketCallError } from '../door/rpc.js';
import type { Log } from '../log.js';

/** The reads whose 404 not_found means the trip itself is gone (a 404 on a write can be a card or a vote). */
const TRIP_READS: ReadonlySet<ToServerMethod> = new Set<ToServerMethod>(['read_trip', 'read_messages']);

/** Thrown instead of reading a trip Go marked gone. Work for it ends here: nothing to retry, nobody in the room to tell. */
export class TripGoneError extends Error {
  constructor(readonly tripId: string) {
    super(`The Server no longer has trip ${tripId}.`);
    this.name = 'TripGoneError';
  }
}

export const isNotFound = (err: unknown): boolean => err instanceof SocketCallError && err.code === 404 && err.dataCode === 'not_found';

const tripOf = (params: Record<string, unknown>): string | null => (typeof params.trip_id === 'string' && params.trip_id ? params.trip_id : null);

export interface GoneTrips {
  /** For the link's onFail: a read of a trip its own instance refused with 404 not_found marks the trip gone. */
  failed(method: ToServerMethod, params: Record<string, unknown>, err: unknown, instance: string | null): Promise<void>;
  /** For the link's onResult: a trip Go could read is not gone. */
  answered(method: ToServerMethod, params: Record<string, unknown>): Promise<void>;
}

export function createGoneTrips(o: { pool: pg.Pool; log: Log; now: () => Date; dropped: (tripId: string) => void }): GoneTrips {
  return {
    async failed(method, params, err, instance) {
      const tripId = tripOf(params);
      if (!tripId || !TRIP_READS.has(method) || !isNotFound(err)) return;
      const { rows } = await o.pool.query<{ server_instance: string | null }>('select server_instance from trips where trip_id = $1', [tripId]);
      const own = rows[0]?.server_instance ?? null;
      if (own !== null && own !== instance) {
        o.log.info({ trip: tripId, own, answered: instance }, 'a 404 from another Server instance: the trip is not gone');
        return;
      }
      const r = await o.pool.query(
        `insert into trips (trip_id, gone_at) values ($1, $2)
         on conflict (trip_id) do update set gone_at = excluded.gone_at where trips.gone_at is null`,
        [tripId, o.now()],
      );
      o.dropped(tripId);
      if ((r.rowCount ?? 0) > 0) o.log.warn({ trip: tripId }, 'the Server no longer has this trip: Go stops its sweeps, timers and watches');
    },
    async answered(method, params) {
      const tripId = tripOf(params);
      if (method !== 'read_trip' || !tripId) return;
      const r = await o.pool.query('update trips set gone_at = null where trip_id = $1 and gone_at is not null', [tripId]);
      if ((r.rowCount ?? 0) > 0) o.log.info({ trip: tripId }, 'the Server has this trip again: Go picks it back up');
    },
  };
}
