/**
 * The trip's computer stays awake while its group is talking, so a Log in tap or a search after a quiet minute never pays
 * a 5 to 15 s wake (the box idles about 9 s after its last activity and its runner lets go about 46 s later, p5's
 * measures, 8 Oct). A trip is active while a person posted in it in the last AWAKE_QUIET_MS; Go's own posts never count.
 * While it is active, Go asks Bash to hold its box awake for AWAKE_KEEP_MS (POST /v1/users/{id}/warm with keep_ms) every
 * AWAKE_EVERY_MS, the first at once, fire and forget, never in a turn's way. After AWAKE_QUIET_MS of quiet it stops, and
 * the box sleeps by itself as before; the next line starts it again at once.
 *
 * Bash holds a box only with keep_ms: a warm without it wakes a sleeping box and does nothing to one that is up (Bash
 * warm.ts; the runner's activity-manager holdFor). So every beat asks for AWAKE_KEEP_MS, twice the beat, and a beat that
 * comes late still lands inside the last hold.
 *
 * Level-triggered: one beat a trip, keyed by the trip, never stacking; each beat reads the trip's last line and decides
 * again. A restart picks the active trips back up from their last person's line in the database (catchUp), not from
 * memory. A trip that is gone, or a TRAVEL_MODE that reads no ixigo.com, never warms. A failed hold is logged once a
 * trip until the trip has gone quiet.
 */
import type pg from 'pg';
import type { TripEvent } from '../door/methods.js';

export const AWAKE_QUIET_MS = 10 * 60_000;
export const AWAKE_EVERY_MS = 30_000;
/** Each beat's hold: twice the beat, so a late beat still lands inside the last one (Bash's keep_ms, at most 120 s). */
export const AWAKE_KEEP_MS = 2 * AWAKE_EVERY_MS;

export interface TripAwakeDeps {
  /** Bash's warm with keep_ms for the trip's browser, the person's computer (browsers.keepAwake). */
  keep: (tripId: string, keepMs: number) => Promise<unknown>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
  /** Whether the trip's computer is worth holding now: Go reads ixigo.com on it (TRAVEL_MODE ixigo_web). */
  on: () => boolean;
  /** Whether the Server has let the trip go (trips.gone_at). */
  gone: (tripId: string) => Promise<boolean>;
  /** Every trip a person posted in since then, with their last line's time: the catch-up after a restart. */
  recent: (since: Date) => Promise<Array<{ tripId: string; at: Date }>>;
}

export interface TripAwake {
  /** The trip log's events (tripLog.onEvent): a person's new line is heard now; Go's own lines and the rest, never. */
  onEvent(ev: TripEvent): void;
  /** A person's line in the trip, at that time: its computer is held awake from now until AWAKE_QUIET_MS after it. */
  heard(tripId: string, at: Date): void;
  /** After a restart: the trips a person posted in within the last AWAKE_QUIET_MS go on being held. */
  catchUp(): Promise<void>;
  /** Stops every beat (Go is shutting down). */
  stop(): void;
}

interface Beat {
  /** The trip's last person's line, in ms. */
  lastAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** A failed hold was logged in this active stretch. */
  warned: boolean;
}

export function createTripAwake(d: TripAwakeDeps): TripAwake {
  const beats = new Map<string, Beat>();
  let stopped = false;

  const quiet = (b: Beat): boolean => d.now().getTime() - b.lastAt >= AWAKE_QUIET_MS;

  /** One beat: hold the box if the trip is still active, then the next beat; or let the trip go. */
  async function beat(tripId: string): Promise<void> {
    const b = beats.get(tripId);
    if (!b || stopped) return;
    b.timer = null;
    if (quiet(b) || !d.on() || (await d.gone(tripId).catch(() => false))) {
      beats.delete(tripId);
      return;
    }
    d.keep(tripId, AWAKE_KEEP_MS).catch((err: unknown) => {
      if (b.warned) return;
      b.warned = true;
      d.log.warn({ err: String(err), tripId }, "tasks: holding the trip's computer awake while its group talks did not work");
    });
    if (!stopped && beats.get(tripId) === b) b.timer = setTimeout(() => void beat(tripId), AWAKE_EVERY_MS).unref();
  }

  function heard(tripId: string, at: Date): void {
    const atMs = at.getTime();
    const b = beats.get(tripId);
    if (b) {
      b.lastAt = Math.max(b.lastAt, atMs);
      return;
    }
    const fresh: Beat = { lastAt: atMs, timer: null, warned: false };
    if (quiet(fresh) || stopped) return;
    beats.set(tripId, fresh);
    void beat(tripId);
  }

  return {
    onEvent(ev) {
      if (ev.type === 'message.created' && ev.data.message.author.kind === 'person') heard(ev.trip_id, d.now());
    },
    heard,
    async catchUp() {
      const since = new Date(d.now().getTime() - AWAKE_QUIET_MS);
      for (const r of await d.recent(since)) heard(r.tripId, r.at);
    },
    stop() {
      stopped = true;
      for (const b of beats.values()) if (b.timer) clearTimeout(b.timer);
      beats.clear();
    },
  };
}

/** Every trip still with the Server that a person posted in since then, with their last line's time (its sent_at). */
export async function recentTalk(pool: pg.Pool, since: Date): Promise<Array<{ tripId: string; at: Date }>> {
  const { rows } = await pool.query<{ trip_id: string; at: Date | null }>(
    `select m.trip_id, max((m.payload->>'sent_at')::timestamptz) as at
       from messages m join trips t on t.trip_id = m.trip_id
      where t.gone_at is null and t.active_at >= $1 and m.person_id is not null
      group by m.trip_id`,
    [since],
  );
  return rows.flatMap((r) => (r.at && r.at >= since ? [{ tripId: r.trip_id, at: r.at }] : []));
}
