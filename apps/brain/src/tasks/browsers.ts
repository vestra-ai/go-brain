/**
 * The person's browser: the Chrome a trip reads ixigo.com in, one per Server and trip organizer, so one ixigo
 * login serves every trip of theirs (Keshav, 9 Oct: "I dont want to login again and again"). A computer per trip made
 * each new trip ask again, and ixigo keeps one session an account: a login on a new trip's computer ended the last
 * one's (staging, 9 Oct: the morning box's token 401 by 17:43, after a 14:52 login elsewhere).
 *
 * Everything that uses the browser comes here: recipe reads, the login hand-off and its Watch, the live view, the keep
 * awake while people talk and the warm for travel. Jobs stay on the trip's own user (computer.ts): their conversations,
 * TRIP_TOKEN and MCP token are the trip's alone, and a job never books or pays, so it never needs the login.
 *
 * A Server is known by the name its socket gives (?server=), the same on every replica, so all of its replicas share the
 * person's browser; a Server that gives none is known by the instance that brought the trip (?instance=), as before.
 *
 * A trip's browser is fixed the first time the trip uses one (trip_browsers), so an organizer who changes later never
 * moves it. Whether the browser is logged in to ixigo is kept here, by status only (in or out, and when ixigo said so):
 * the login on any trip of theirs is the login on all of them.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Packs } from '../trips/pack.js';
import type { TasksRuntime } from './env.js';
import type { V1Client } from './v1-client.js';

/** Vestra wakes at most 10 computers per org at once; Go keeps two for everyone else. */
export const WARM_LIMIT = 8;
const WARM_WINDOW_MS = 90_000;
const WARM_COOLDOWN_MS = 60_000;
/** The browsers Go saw up most recently, at most this many. */
const SEEN_UP_MAX = 500;
/** The instance the door gives a socket that names none. */
const NO_INSTANCE = 'default';
/** One organizer under two Server names within this long is said in the log: their Server's replicas name themselves apart. */
const TWO_NAMES_MS = 24 * 3600_000;

/**
 * /v1 user ids allow letters, digits and ._:@- only, so the Server's name (its ?server=, else the instance) and the
 * person are hashed.
 */
export function browserUserIdFor(name: string, personId: string): string {
  return `gobrowser-${createHash('sha256').update(`${name}:${personId}`).digest('hex').slice(0, 32)}`;
}

/** Where the browser's ixigo login stands, as ixigo last said it: in or out, and when. Null before it ever said. */
export interface BrowserLogin {
  login: 'in' | 'out' | null;
  at: Date | null;
  loggedInAt: Date | null;
}

export interface Browsers {
  /** The /v1 user whose browser the trip uses, made on /v1 if it is not yet. */
  userFor(tripId: string): Promise<string>;
  /** The same user made again on /v1 (one /v1 said it does not know). */
  again(tripId: string): Promise<string>;
  /**
   * keepMs: hold the browser's computer awake that long once it is up (Bash's keep_ms, at most 120 s); a later warm
   * extends the hold. A hold is asked for on purpose (keep-warm.ts), so it is never skipped as a repeat; it still counts
   * toward WARM_LIMIT.
   */
  warm(tripId: string, o?: { keepMs?: number }): Promise<'ready' | 'waking' | 'skipped'>;
  /**
   * Holds the computer awake keepMs once it is up: the keepalive while a trip's people talk (awake.ts). One Go saw up
   * within its own last hold is not waking, so that warm skips Go's wake limit; any other counts, as a wake.
   */
  keepAwake(tripId: string, keepMs: number): Promise<'ready' | 'waking'>;
  /** Where the trip's browser's ixigo login stands; null for a browser ixigo never answered on. Reads nothing on /v1. */
  login(tripId: string): Promise<BrowserLogin | null>;
  /** ixigo said in or out on the trip's browser, now. */
  setLogin(tripId: string, login: 'in' | 'out'): Promise<void>;
  /** The browsers logged in whose login ixigo last confirmed before `before`, each with its newest live trip. */
  loggedInSince(before: Date): Promise<Array<{ userId: string; tripId: string; at: Date }>>;
}

export interface BrowsersDeps {
  pool: pg.Pool;
  v1: V1Client;
  packs: Pick<Packs, 'get'>;
  env: Pick<TasksRuntime, 'VESTRA_DEPLOYMENT_ID'>;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
}

export function createBrowsers(d: BrowsersDeps): Browsers {
  let warmsIssued: number[] = [];
  /** When each browser last answered keepAwake as up ('ready'). */
  const seenUp = new Map<string, number>();
  /** Trips whose browser is made on /v1: their user, read once. */
  const ready = new Map<string, string>();

  /** Go's own count of computers waking (WARM_LIMIT in WARM_WINDOW_MS): throws when it is full. */
  function countWake(nowMs: number, then: string): void {
    warmsIssued = warmsIssued.filter((t) => nowMs - t < WARM_WINDOW_MS);
    if (warmsIssued.length >= WARM_LIMIT) throw new Error(`warm_limit: too many computers are waking; ${then}`);
    warmsIssued.push(nowMs);
  }

  /**
   * The trip's browser, stored the first time: its organizer's under the Server's own name, or under the instance (the
   * Server's socket that brought the trip) when the Server gives no name.
   */
  async function idFor(tripId: string): Promise<{ userId: string; readyAt: Date | null }> {
    const mapped = async () => (await d.pool.query<{ v1_user_id: string; user_ready_at: Date | null }>(
      'select b.v1_user_id, b.user_ready_at from trip_browsers t join browsers b using (v1_user_id) where t.trip_id = $1',
      [tripId],
    )).rows[0];
    const known = await mapped();
    if (known) return { userId: known.v1_user_id, readyAt: known.user_ready_at };
    const trip = await d.pool.query<{ server_instance: string | null; server_name: string | null }>(
      'select server_instance, server_name from trips where trip_id = $1',
      [tripId],
    );
    const instance = trip.rows[0]?.server_instance ?? NO_INSTANCE;
    const server = trip.rows[0]?.server_name ?? null;
    const personId = (await d.packs.get(tripId)).trip.organizer_person_id;
    const userId = server ? ((await adopt(server, personId)) ?? browserUserIdFor(server, personId)) : browserUserIdFor(instance, personId);
    await d.pool.query(
      `insert into browsers (v1_user_id, server_instance, server_name, person_id, created_at) values ($1, $2, $3, $4, $5)
       on conflict (v1_user_id) do nothing`,
      [userId, instance, server, personId, d.now()],
    );
    const made = await d.pool.query('insert into trip_browsers (trip_id, v1_user_id, created_at) values ($1, $2, $3) on conflict (trip_id) do nothing', [tripId, userId, d.now()]);
    if ((made.rowCount ?? 0) > 0) await sayTwoNames(personId, server ?? instance);
    // Two first uses at once store one: the one stored is the trip's.
    const stored = await mapped();
    return { userId: stored!.v1_user_id, readyAt: stored!.user_ready_at };
  }

  /**
   * The organizer's browser under a Server that gives its name: the one it already has, or, the first time, the one they
   * had under that Server's instances before it gave a name (the one logged in most recently), which becomes the
   * Server's. So nobody logs in again when their Server starts sending ?server=. Null when they have neither.
   */
  async function adopt(server: string, personId: string): Promise<string | null> {
    const { rows } = await d.pool.query<{ v1_user_id: string; server_name: string | null }>(
      `select v1_user_id, server_name from browsers
       where person_id = $1
         and (server_name = $2 or (server_name is null and server_instance in (select server_instance from trips where server_name = $2)))
       order by server_name is null, logged_in_at desc nulls last, created_at, v1_user_id
       limit 1`,
      [personId, server],
    );
    const found = rows[0];
    if (!found) return null;
    if (found.server_name === null) {
      await d.pool.query('update browsers set server_name = $2 where v1_user_id = $1 and server_name is null', [found.v1_user_id, server]);
    }
    return found.v1_user_id;
  }

  /**
   * One organizer under two Server names within a day: the Server must keep one name across its restarts and replicas
   * (its ?server=, or its ?instance= when it sends no server), or the person gets one browser, and one ixigo login, per
   * name. Said once a new trip maps, never acted on.
   */
  async function sayTwoNames(personId: string, name: string): Promise<void> {
    const { rows } = await d.pool.query<{ name: string }>(
      `select distinct coalesce(b.server_name, b.server_instance) as name from trip_browsers t join browsers b using (v1_user_id)
       where b.person_id = $1 and coalesce(b.server_name, b.server_instance) <> $2 and t.created_at > $3`,
      [personId, name, new Date(d.now().getTime() - TWO_NAMES_MS)],
    );
    if (rows.length > 0) {
      d.log.warn(
        { personId, name, others: rows.map((r) => r.name) },
        'browsers: one organizer under two Server names within a day: each name gets its own browser and its own ixigo login',
      );
    }
  }

  /** The browser's /v1 user, with the go-trip-task deployment (as the trip's own user is made); safe to repeat. */
  async function make(tripId: string, userId: string): Promise<string> {
    await d.v1.call('POST', '/v1/users', {
      admin: true,
      idempotencyKey: `go-browser-${userId}`,
      body: { user_id: userId, name: 'Go browser for a trip organizer', timezone: 'Asia/Kolkata', metadata: { go_browser: true, go_first_trip_id: tripId } },
    });
    // A repeat POST ignores the profile, so the deployment is set with PATCH every time this runs.
    await d.v1.call('PATCH', `/v1/users/${userId}`, { admin: true, body: { default_deployment: d.env.VESTRA_DEPLOYMENT_ID } });
    await d.pool.query('update browsers set user_ready_at = $2 where v1_user_id = $1', [userId, d.now()]);
    ready.set(tripId, userId);
    return userId;
  }

  async function userFor(tripId: string): Promise<string> {
    const cached = ready.get(tripId);
    if (cached) return cached;
    const { userId, readyAt } = await idFor(tripId);
    if (readyAt) {
      ready.set(tripId, userId);
      return userId;
    }
    return make(tripId, userId);
  }

  return {
    userFor,

    async again(tripId) {
      ready.delete(tripId);
      return make(tripId, (await idFor(tripId)).userId);
    },

    async warm(tripId, o = {}) {
      const userId = await userFor(tripId);
      const nowMs = d.now().getTime();
      const { rows } = await d.pool.query<{ warm_at: Date | null }>('select warm_at from browsers where v1_user_id = $1', [userId]);
      const warmAt = rows[0]?.warm_at;
      if (!o.keepMs && warmAt && nowMs - warmAt.getTime() < WARM_COOLDOWN_MS) return 'skipped';
      countWake(nowMs, 'setup tries again on its next pass');
      const r = await d.v1.call<{ status: 'ready' | 'waking' }>('POST', `/v1/users/${userId}/warm`, o.keepMs ? { body: { keep_ms: o.keepMs } } : {});
      await d.pool.query('update browsers set warm_at = $2 where v1_user_id = $1', [userId, d.now()]);
      return r.status;
    },

    async keepAwake(tripId, keepMs) {
      const userId = await userFor(tripId);
      const nowMs = d.now().getTime();
      const up = seenUp.get(userId);
      if (up === undefined || nowMs - up >= keepMs) countWake(nowMs, 'the keepalive tries again on its next beat');
      const r = await d.v1.call<{ status: 'ready' | 'waking' }>('POST', `/v1/users/${userId}/warm`, { body: { keep_ms: keepMs } });
      seenUp.delete(userId);
      if (r.status === 'ready') {
        seenUp.set(userId, nowMs);
        while (seenUp.size > SEEN_UP_MAX) {
          const oldest = seenUp.keys().next().value;
          if (oldest === undefined) break;
          seenUp.delete(oldest);
        }
      }
      return r.status;
    },

    async login(tripId) {
      const { userId } = await idFor(tripId);
      const { rows } = await d.pool.query<{ login: 'in' | 'out' | null; login_at: Date | null; logged_in_at: Date | null }>(
        'select login, login_at, logged_in_at from browsers where v1_user_id = $1',
        [userId],
      );
      const r = rows[0];
      return r && r.login ? { login: r.login, at: r.login_at, loggedInAt: r.logged_in_at } : null;
    },

    async setLogin(tripId, login) {
      const { userId } = await idFor(tripId);
      await d.pool.query(
        `update browsers set login = $2, login_at = $3,
           logged_in_at = case when $2 = 'in' and login is distinct from 'in' then $3 else logged_in_at end
         where v1_user_id = $1`,
        [userId, login, d.now()],
      );
    },

    async loggedInSince(before) {
      const { rows } = await d.pool.query<{ v1_user_id: string; trip_id: string; login_at: Date }>(
        `select distinct on (b.v1_user_id) b.v1_user_id, t.trip_id, b.login_at
         from browsers b join trip_browsers t using (v1_user_id) join trips tr on tr.trip_id = t.trip_id
         where b.login = 'in' and b.login_at < $1 and tr.gone_at is null
         order by b.v1_user_id, tr.active_at desc`,
        [before],
      );
      return rows.map((r) => ({ userId: r.v1_user_id, tripId: r.trip_id, at: r.login_at }));
    },
  };
}
