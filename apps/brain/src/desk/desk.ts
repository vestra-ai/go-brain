import type pg from 'pg';
import { newUlid } from '../door/ulid.js';
import type { Log } from '../log.js';

export type DeskKind = 'message' | 'trip_change' | 'tap' | 'task' | 'timer' | 'watch' | 'opening' | 'setup';

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
  /** Wake a trip in-process when its item is due. Tests turn it off and drive the desk with tick(). */
  inProcessWake?: boolean;
}

export type DeskImpl = Desk & {
  setRunner(run: TurnRunner, giveUp: TurnRunner): void;
  /** For the pre-post check: message items that arrived while a turn ran join that turn. */
  claimNew(tripId: string, turnId: string): Promise<DeskItem[]>;
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
const toItem = (r: Row): DeskItem => ({ id: r.id, tripId: r.trip_id, kind: r.kind, ref: r.ref, dueAt: r.due_at, payload: r.payload });

export function createDesk(o: DeskOptions): DeskImpl {
  const maxWaitMs = o.maxWaitMs ?? 6_000;
  const pollMs = o.pollMs ?? 1_000;
  const leaseMs = o.leaseMs ?? 60_000;
  const retryDelays = o.retryDelaysMs ?? [1_000, 4_000];
  const maxAttempts = o.maxAttempts ?? 3;
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
    const due = rows.filter((r) => r.due_at.getTime() <= now);
    if (due.length === 0) return null;
    // A turn that took items and never finished runs again first, under the same turn id, so its writes repeat their request ids.
    const crashed = due.find((r) => r.turn_id !== null)?.turn_id ?? null;
    const take = crashed
      ? rows.filter((r) => r.turn_id === crashed)
      : rows.filter((r) => r.turn_id === null && (r.due_at.getTime() <= now || r.kind === 'message'));
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
      o.log.warn({ err: e, trip: b.tripId, turn: b.turnId, attempt: b.attempt }, 'a turn failed');
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
