import type pg from 'pg';
import { SocketCallError } from '../door/rpc.js';
import { newUlid } from '../door/ulid.js';
import type { Log } from '../log.js';
import { TripGoneError } from '../trips/gone.js';

export type DeskKind = 'message' | 'trip_change' | 'tap' | 'task' | 'timer' | 'watch' | 'opening' | 'setup' | 'search';

export interface DeskItem {
  id: string;
  tripId: string;
  kind: DeskKind;
  ref: string;
  dueAt: Date;
  payload: unknown;
}

/** The only way to make Go think. */
export interface Desk {
  /** `id` makes put idempotent. */
  put(item: Omit<DeskItem, 'id'> & { id?: string }): Promise<void>;
  /** Drops waiting items with this ref; items a running turn already took stay with it. */
  cancel(tripId: string, ref: string): Promise<void>;
  /** The trip's Server is back (an event of its came): a turn waiting on it runs now, with whatever came meanwhile. */
  wake?(tripId: string): Promise<void>;
}

export interface TurnInput {
  tripId: string;
  turnId: string;
  items: DeskItem[];
  attempt: number;
}
export type TurnRunner = (t: TurnInput) => Promise<void>;

export interface DeskOptions {
  pool: pg.Pool;
  log: Log;
  now: () => Date;
  /** This copy of the service; leases carry its name. */
  holder: string;
  /** A waiting message is pushed back by each new one, but never past this after it arrived. */
  maxWaitMs?: number;
  pollMs?: number;
  leaseMs?: number;
  retryDelaysMs?: readonly number[];
  maxAttempts?: number;
  /** A turn whose trip's Server can't be reached waits at most this long, from its oldest item, before it is dropped. */
  awayMaxMs?: number;
  /** Wake a trip in-process when its item is due. Tests turn it off and drive the desk with tick(). */
  inProcessWake?: boolean;
}

export type DeskImpl = Desk & {
  setRunner(run: TurnRunner, giveUp: TurnRunner): void;
  /** For the pre-post check: message items that arrived while a turn ran join that turn. */
  claimNew(tripId: string, turnId: string): Promise<DeskItem[]>;
  /** Gives items a turn took back to the desk, for a turn of their own once this one ends. */
  release(turnId: string, ids: string[]): Promise<void>;
  /** One poll: runs every trip with something due. */
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
};

interface Row {
  id: string;
  trip_id: string;
  kind: DeskKind;
  ref: string;
  due_at: Date;
  payload: unknown;
  turn_id: string | null;
  attempts: number;
}

const COLUMNS = 'id, trip_id, kind, ref, due_at, payload, turn_id, attempts';
/** The error a turn waiting on its trip's Server is marked with (wake finds it). */
const AWAY = 'away:';
/** How long such a turn waits between tries: a quarter of how long it has waited, within these bounds. */
const AWAY_GAP_MS = { min: 30_000, max: 5 * 60_000 };
const toItem = (r: Row): DeskItem => ({ id: r.id, tripId: r.trip_id, kind: r.kind, ref: r.ref, dueAt: r.due_at, payload: r.payload });

export function createDesk(o: DeskOptions): DeskImpl {
  const maxWaitMs = o.maxWaitMs ?? 6_000;
  const pollMs = o.pollMs ?? 1_000;
  const leaseMs = o.leaseMs ?? 60_000;
  const retryDelays = o.retryDelaysMs ?? [1_000, 4_000];
  const maxAttempts = o.maxAttempts ?? 3;
  const awayMaxMs = o.awayMaxMs ?? 6 * 60 * 60_000;
  const inProcessWake = o.inProcessWake ?? true;
  let runTurn: TurnRunner | null = null;
  let giveUp: TurnRunner | null = null;
  const running = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const timers = new Set<NodeJS.Timeout>();
  let poller: NodeJS.Timeout | null = null;
  let stopped = false;

  function schedule(tripId: string, dueAt: Date): void {
    if (stopped || !inProcessWake) return;
    const ms = Math.max(0, dueAt.getTime() - o.now().getTime()) + 5;
    if (ms > 2 ** 31 - 1) return; // far off: the poller finds it
    const t = setTimeout(() => {
      timers.delete(t);
      void runTrip(tripId);
    }, ms);
    timers.add(t);
  }

  async function takeLease(tripId: string): Promise<boolean> {
    const now = o.now();
    // A lease with an expiry: a copy that dies mid-turn frees the trip when its lease runs out.
    const r = await o.pool.query(
      `insert into trip_leases (trip_id, holder, until) values ($1, $2, $3)
       on conflict (trip_id) do update set holder = excluded.holder, until = excluded.until
       where trip_leases.until < $4 or trip_leases.holder = excluded.holder
       returning trip_id`,
      [tripId, o.holder, new Date(now.getTime() + leaseMs), now],
    );
    return r.rowCount === 1;
  }

  async function nextBatch(tripId: string): Promise<TurnInput | null> {
    const now = o.now().getTime();
    const { rows } = await o.pool.query<Row>(
      `select ${COLUMNS} from desk_items where trip_id = $1 and done_at is null order by due_at, id`,
      [tripId],
    );
    const isDue = (r: Row): boolean => r.due_at.getTime() <= now;
    // A turn that took items and never finished runs again first, under the same turn id, so its writes repeat their request ids.
    // While it waits for its retry no other turn starts for the trip (one would answer its messages twice); when it runs, the
    // messages that arrived meanwhile join it, so one turn covers everything.
    const crashed = rows.find((r) => r.turn_id !== null)?.turn_id ?? null;
    if (crashed ? !rows.some((r) => r.turn_id === crashed && isDue(r)) : !rows.some(isDue)) return null;
    const take = crashed
      ? rows.filter((r) => r.turn_id === crashed || (r.turn_id === null && r.kind === 'message'))
      : rows.filter((r) => r.turn_id === null && (isDue(r) || r.kind === 'message'));
    const turnId = crashed ?? `turn_${newUlid(now)}`;
    const taken = await o.pool.query<{ attempts: number }>(
      'update desk_items set turn_id = $2, attempts = attempts + 1 where id = any($1::text[]) and done_at is null returning attempts',
      [take.map((r) => r.id), turnId],
    );
    if (taken.rows.length === 0) return null;
    return { tripId, turnId, items: take.map(toItem), attempt: Math.max(...taken.rows.map((r) => r.attempts)) };
  }

  async function runBatch(run: TurnRunner, b: TurnInput): Promise<void> {
    try {
      await run(b);
      await o.pool.query('update desk_items set done_at = $2, error = null where turn_id = $1 and done_at is null', [b.turnId, o.now()]);
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      // The Server no longer has the trip: no retry, and no giving-up line, which would go to a room that isn't there.
      if (e instanceof TripGoneError) {
        await o.pool.query('update desk_items set done_at = $2, error = $3 where turn_id = $1 and done_at is null', [b.turnId, o.now(), message]);
        return;
      }
      o.log.warn({ err: e, trip: b.tripId, turn: b.turnId, attempt: b.attempt }, 'a turn failed');
      // The trip's Server can't be reached (its socket is gone, or silent): no try can post, so none is spent and Go never
      // gives up on the asks. The turn keeps its id and waits; the Server's next event for the trip wakes it (wake), else
      // it tries again on a widening gap, so every ask it holds is answered in one reply once the trip is back (prod,
      // 11 Oct: four asks to Go in Manali, 07:26 to 07:32, were given up in seconds on a stranded socket).
      if (e instanceof SocketCallError && e.code === 503) {
        const { rows } = await o.pool.query<{ since: Date | null }>(
          'select min(created_at) as since from desk_items where turn_id = $1 and done_at is null',
          [b.turnId],
        );
        const waited = o.now().getTime() - (rows[0]?.since?.getTime() ?? o.now().getTime());
        if (waited > awayMaxMs) {
          await o.pool.query('update desk_items set done_at = $2, error = $3 where turn_id = $1 and done_at is null', [
            b.turnId,
            o.now(),
            `the trip's Server was away too long: ${message}`,
          ]);
          return;
        }
        const gap = Math.min(AWAY_GAP_MS.max, Math.max(AWAY_GAP_MS.min, Math.round(waited / 4)));
        const dueAt = new Date(o.now().getTime() + gap);
        await o.pool.query(
          'update desk_items set attempts = greatest(attempts - 1, 0), due_at = $2, error = $3 where turn_id = $1 and done_at is null',
          [b.turnId, dueAt, `${AWAY} ${message}`],
        );
        schedule(b.tripId, dueAt);
        return;
      }
      if (b.attempt >= maxAttempts) {
        try {
          await giveUp?.(b);
        } catch (g) {
          o.log.error({ err: g, turn: b.turnId }, 'giving up failed too');
        }
        await o.pool.query('update desk_items set done_at = $2, error = $3 where turn_id = $1 and done_at is null', [
          b.turnId,
          o.now(),
          `gave up after ${b.attempt} attempts: ${message}`,
        ]);
        return;
      }
      const wait = retryDelays[Math.min(b.attempt - 1, retryDelays.length - 1)] ?? 1_000;
      const dueAt = new Date(o.now().getTime() + wait);
      await o.pool.query('update desk_items set due_at = $2, error = $3 where turn_id = $1 and done_at is null', [b.turnId, dueAt, message]);
      schedule(b.tripId, dueAt);
    }
  }

  async function drain(tripId: string): Promise<void> {
    const run = runTurn;
    if (!run || stopped) return;
    if (!(await takeLease(tripId))) return;
    try {
      for (let i = 0; i < 20 && !stopped; i++) {
        const batch = await nextBatch(tripId);
        if (!batch) break;
        await o.pool.query('update trip_leases set until = $3 where trip_id = $1 and holder = $2', [
          tripId,
          o.holder,
          new Date(o.now().getTime() + leaseMs),
        ]);
        await runBatch(run, batch);
      }
    } finally {
      await o.pool.query('delete from trip_leases where trip_id = $1 and holder = $2', [tripId, o.holder]);
    }
  }

  /** One composer turn per trip at a time in this copy; the lease covers the other copies. */
  function runTrip(tripId: string): Promise<void> {
    const cur = running.get(tripId);
    if (cur) {
      again.add(tripId);
      return cur;
    }
    const p = drain(tripId)
      .catch((e: unknown) => o.log.error({ err: e, trip: tripId }, 'the desk failed on a trip'))
      .finally(() => {
        running.delete(tripId);
        if (again.delete(tripId) && !stopped) void runTrip(tripId);
      });
    running.set(tripId, p);
    return p;
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    const { rows } = await o.pool.query<{ trip_id: string }>(
      'select distinct trip_id from desk_items where done_at is null and due_at <= $1 limit 100',
      [o.now()],
    );
    await Promise.all(rows.map((r) => runTrip(r.trip_id)));
  }

  return {
    async put(item) {
      const id = item.id ?? `dk_${newUlid(o.now().getTime())}`;
      await o.pool.query(
        `insert into desk_items (id, trip_id, kind, ref, due_at, payload, created_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7) on conflict (id) do nothing`,
        [id, item.tripId, item.kind, item.ref, item.dueAt, JSON.stringify(item.payload ?? {}), o.now()],
      );
      if (item.kind === 'message' && item.dueAt.getTime() > o.now().getTime()) {
        // The wait: a new message pushes the trip's waiting messages back to its own due time, never past maxWaitMs after each arrived.
        await o.pool.query(
          `update desk_items set due_at = least($2::timestamptz, created_at + make_interval(secs => $3::double precision))
           where trip_id = $1 and kind = 'message' and done_at is null and turn_id is null and due_at < $2 and due_at > $4`,
          [item.tripId, item.dueAt, maxWaitMs / 1_000, o.now()],
        );
      }
      schedule(item.tripId, item.dueAt);
    },
    async wake(tripId) {
      const r = await o.pool.query(
        'update desk_items set due_at = $2 where trip_id = $1 and done_at is null and turn_id is not null and error like $3 and due_at > $2',
        [tripId, o.now(), `${AWAY}%`],
      );
      if ((r.rowCount ?? 0) > 0) schedule(tripId, o.now());
    },
    async cancel(tripId, ref) {
      await o.pool.query(
        `update desk_items set done_at = $3, error = 'cancelled' where trip_id = $1 and ref = $2 and done_at is null and turn_id is null`,
        [tripId, ref, o.now()],
      );
    },
    setRunner(run, give) {
      runTurn = run;
      giveUp = give;
    },
    async claimNew(tripId, turnId) {
      const { rows } = await o.pool.query<Row>(
        `update desk_items set turn_id = $2, attempts = attempts + 1
         where trip_id = $1 and kind = 'message' and done_at is null and turn_id is null
         returning ${COLUMNS}`,
        [tripId, turnId],
      );
      return rows.map(toItem).sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.id.localeCompare(b.id));
    },
    async release(turnId, ids) {
      if (ids.length === 0) return;
      await o.pool.query(
        `update desk_items set turn_id = null, attempts = greatest(attempts - 1, 0)
         where turn_id = $1 and id = any($2::text[]) and done_at is null`,
        [turnId, ids],
      );
    },
    tick,
    start() {
      stopped = false;
      poller = setInterval(() => {
        void tick().catch((e: unknown) => o.log.error({ err: e }, 'the desk poll failed'));
      }, pollMs);
      // Never keeps the process alive; buildBrain stops it through brain.onStop (desk.stop).
      poller.unref();
    },
    async stop() {
      stopped = true;
      if (poller) clearInterval(poller);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      await Promise.all([...running.values()]);
    },
  };
}
