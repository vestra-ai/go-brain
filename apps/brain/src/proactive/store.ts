// What Go noticed on its own, held until the bar says it may act, and the per-trip signals the bar
// reads: unprompted posts today, hushes, nudges people ignored. Also the notice cards Go posted.
import type { NoticeCard } from '@go/contract';
import type pg from 'pg';
import type { z } from 'zod';
import { DEFAULT_TZ, isValidTz } from './clock.js';
import { ACTIONS, type Action, type Candidate, type Source } from './policy.js';

export type NoticeIn = z.input<typeof NoticeCard>;

export interface Signals {
  postsToday: number;
  lastProactivePostAt: Date | null;
  hushCount: number;
  lastHushAt: Date | null;
  ignoredCount: number;
}
export interface SavedNotice { tripId: string; cardId: string; messageId: string | null; card: NoticeIn }
export interface ToCheck { tripId: string; dedupeKey: string; decidedAt: Date }

type CandidateRow = {
  trip_id: string;
  dedupe_key: string;
  source: Source;
  topic: string;
  due_at: Date;
  expires_at: Date | null;
  importance: number;
  confidence: number;
  urgency: number;
  useful: string[];
  person_ids: string[];
  facts: Record<string, unknown>;
  simulated: boolean;
  small: boolean;
  forced: boolean;
  asked: boolean;
};

const isAction = (a: string): a is Action => (ACTIONS as readonly string[]).includes(a);

function toCandidate(r: CandidateRow): Candidate {
  return {
    tripId: r.trip_id,
    dedupeKey: r.dedupe_key,
    source: r.source,
    topic: r.topic,
    dueAt: r.due_at,
    expiresAt: r.expires_at,
    importance: r.importance,
    confidence: r.confidence,
    urgency: r.urgency,
    useful: r.useful.filter(isAction),
    personIds: r.person_ids,
    facts: r.facts,
    simulated: r.simulated,
    small: r.small,
    ...(r.forced ? { forced: true } : {}),
    ...(r.asked ? { asked: true } : {}),
  };
}

const COLS = 'trip_id, dedupe_key, source, topic, due_at, expires_at, importance, confidence, urgency, useful, person_ids, facts, simulated, small, forced, asked';
const PLACES = '$1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16';
const values = (c: Candidate): unknown[] => [
  c.tripId, c.dedupeKey, c.source, c.topic, c.dueAt, c.expiresAt, c.importance, c.confidence, c.urgency,
  c.useful, c.personIds, JSON.stringify(c.facts), c.simulated, c.small, c.forced === true, c.asked === true,
];

export class ProactiveStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Adds something Go noticed. A key seen before is never added again: Go never repeats a nudge. */
  async add(c: Candidate): Promise<'added' | 'exists'> {
    const r = await this.pool.query(
      `insert into proactive_candidates (${COLS}) values (${PLACES}) on conflict (trip_id, dedupe_key) do nothing`,
      values(c),
    );
    return r.rowCount === 1 ? 'added' : 'exists';
  }

  /** Timers: plans one, or moves a pending one to its new time. A decided one stays decided. */
  async plan(c: Candidate): Promise<void> {
    await this.pool.query(
      `insert into proactive_candidates (${COLS}) values (${PLACES})
       on conflict (trip_id, dedupe_key) do update set
         due_at = excluded.due_at, expires_at = excluded.expires_at, person_ids = excluded.person_ids,
         facts = excluded.facts, useful = excluded.useful, status = 'pending', reason = null, decided_at = null
       where proactive_candidates.status = 'pending'
          or (proactive_candidates.status = 'dropped' and proactive_candidates.reason in ('replanned', 'trip_gone'))`,
      values(c),
    );
  }

  /** Timers no longer planned (the vote closed early, the dates moved) stop waiting. */
  async dropUnplanned(tripId: string, keep: string[], now: Date): Promise<number> {
    const r = await this.pool.query(
      `update proactive_candidates set status = 'dropped', reason = 'replanned', decided_at = $3
       where trip_id = $1 and source = 'timer' and status = 'pending' and not (dedupe_key = any($2::text[]))`,
      [tripId, keep, now],
    );
    return r.rowCount ?? 0;
  }

  /**
   * Retires every pending candidate (timers included) of a trip the Server no longer has (trips.gone_at), so the
   * promoter never reads it again. A re-plan revives a timer if the trip comes back.
   */
  async retireGone(now: Date): Promise<number> {
    const r = await this.pool.query(
      `update proactive_candidates c set status = 'dropped', reason = 'trip_gone', decided_at = $1
       from trips t where t.trip_id = c.trip_id and t.gone_at is not null and c.status = 'pending'`,
      [now],
    );
    return r.rowCount ?? 0;
  }

  async due(now: Date, limit = 50): Promise<Candidate[]> {
    const r = await this.pool.query<CandidateRow>(
      `select ${COLS} from proactive_candidates where status = 'pending' and due_at <= $1 order by trip_id, due_at limit $2`,
      [now, limit],
    );
    return r.rows.map(toCandidate);
  }

  /** Each of the trip's watches and its newest change key, for the "is this watch nudge still true" check. */
  async watchKeys(tripId: string): Promise<Map<string, string | null>> {
    const r = await this.pool.query<{ watch_id: string; last_change_key: string | null }>(
      `select watch_id, last_change_key from watches where trip_id = $1`,
      [tripId],
    );
    return new Map(r.rows.map((w) => [w.watch_id, w.last_change_key]));
  }

  /** One trip's due candidates (the stage fire promotes its trip at once). */
  async dueFor(tripId: string, now: Date): Promise<Candidate[]> {
    const r = await this.pool.query<CandidateRow>(
      `select ${COLS} from proactive_candidates where trip_id = $1 and status = 'pending' and due_at <= $2 order by due_at`,
      [tripId, now],
    );
    return r.rows.map(toCandidate);
  }

  async promote(c: Candidate, d: { allowed: Action[]; forPersonIds: string[]; counted: boolean; localDay: string }, now: Date): Promise<void> {
    await this.pool.query(
      `update proactive_candidates set status = 'promoted', reason = null, allowed = $3, for_person_ids = $4,
         counted = $5, decided_at = $6, local_day = $7, person_ids = $8
       where trip_id = $1 and dedupe_key = $2 and status = 'pending'`,
      [c.tripId, c.dedupeKey, d.allowed, d.forPersonIds, d.counted, now, d.localDay, c.personIds],
    );
  }

  async defer(c: Candidate, until: Date, reason: string): Promise<void> {
    await this.pool.query(
      `update proactive_candidates set due_at = $3, reason = $4 where trip_id = $1 and dedupe_key = $2 and status = 'pending'`,
      [c.tripId, c.dedupeKey, until, reason],
    );
  }

  async drop(c: Candidate, reason: string, now: Date): Promise<void> {
    await this.pool.query(
      `update proactive_candidates set status = 'dropped', reason = $3, decided_at = $4
       where trip_id = $1 and dedupe_key = $2 and status = 'pending'`,
      [c.tripId, c.dedupeKey, reason, now],
    );
  }

  async status(tripId: string, key: string): Promise<{ status: string; reason: string | null; allowed: Action[] | null; counted: boolean; dueAt: Date } | null> {
    const r = await this.pool.query<{ status: string; reason: string | null; allowed: string[] | null; counted: boolean; due_at: Date }>(
      `select status, reason, allowed, counted, due_at from proactive_candidates where trip_id = $1 and dedupe_key = $2`,
      [tripId, key],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      status: row.status,
      reason: row.reason,
      allowed: row.allowed ? row.allowed.filter(isAction) : null,
      counted: row.counted,
      dueAt: row.due_at,
    };
  }

  /** Posts are counted per batch (one promotion instant), so things batched into one turn spend one post. */
  async signals(tripId: string, localDay: string): Promise<Signals> {
    const posts = await this.pool.query<{ n: number; last: Date | null }>(
      `select (select count(distinct decided_at)::int from proactive_candidates
                where trip_id = $1 and status = 'promoted' and counted and local_day = $2) as n,
              (select max(decided_at) from proactive_candidates
                where trip_id = $1 and status = 'promoted' and counted) as last`,
      [tripId, localDay],
    );
    const t = await this.pool.query<{ hush_count: number; last_hush_at: Date | null; ignored_count: number }>(
      `select hush_count, last_hush_at, ignored_count from proactive_trips where trip_id = $1`,
      [tripId],
    );
    const p = posts.rows[0];
    const s = t.rows[0];
    return {
      postsToday: p?.n ?? 0,
      lastProactivePostAt: p?.last ?? null,
      hushCount: s?.hush_count ?? 0,
      lastHushAt: s?.last_hush_at ?? null,
      ignoredCount: s?.ignored_count ?? 0,
    };
  }

  async tripTz(tripId: string): Promise<string> {
    const r = await this.pool.query<{ tz: string | null }>(`select tz from trips where trip_id = $1`, [tripId]);
    const tz = r.rows[0]?.tz;
    return tz && isValidTz(tz) ? tz : DEFAULT_TZ;
  }

  /** Whether Go has the trip: live, gone (the Server no longer has it, trips.gone_at), or null for one it never had. */
  async tripState(tripId: string): Promise<'live' | 'gone' | null> {
    const r = await this.pool.query<{ gone: boolean }>(`select gone_at is not null as gone from trips where trip_id = $1`, [tripId]);
    const row = r.rows[0];
    return row ? (row.gone ? 'gone' : 'live') : null;
  }

  async hush(tripId: string, now: Date): Promise<void> {
    await this.pool.query(
      `insert into proactive_trips (trip_id, hush_count, last_hush_at, updated_at) values ($1, 1, $2, $2)
       on conflict (trip_id) do update set hush_count = proactive_trips.hush_count + 1, last_hush_at = $2, updated_at = $2`,
      [tripId, now],
    );
  }

  async ignored(tripId: string, now: Date): Promise<void> {
    await this.pool.query(
      `insert into proactive_trips (trip_id, ignored_count, updated_at) values ($1, 1, $2)
       on conflict (trip_id) do update set ignored_count = proactive_trips.ignored_count + 1, updated_at = $2`,
      [tripId, now],
    );
  }

  /** Admin only (rehearsals): today's posts stop counting against the budget. */
  async resetBudget(tripId: string, localDay: string): Promise<number> {
    const r = await this.pool.query(
      `update proactive_candidates set counted = false where trip_id = $1 and local_day = $2 and counted`,
      [tripId, localDay],
    );
    return r.rowCount ?? 0;
  }

  async toCheckForIgnored(before: Date, limit = 100): Promise<ToCheck[]> {
    const r = await this.pool.query<{ trip_id: string; dedupe_key: string; decided_at: Date }>(
      `select trip_id, dedupe_key, decided_at from proactive_candidates
       where status = 'promoted' and counted and ignore_checked_at is null and decided_at < $1
       order by decided_at limit $2`,
      [before, limit],
    );
    return r.rows.map((x) => ({ tripId: x.trip_id, dedupeKey: x.dedupe_key, decidedAt: x.decided_at }));
  }

  async ignoreChecked(tripId: string, key: string, now: Date): Promise<void> {
    await this.pool.query(`update proactive_candidates set ignore_checked_at = $3 where trip_id = $1 and dedupe_key = $2`, [tripId, key, now]);
  }

  async saveNotice(n: SavedNotice): Promise<void> {
    await this.pool.query(
      `insert into proactive_notices (trip_id, card_id, message_id, card) values ($1, $2, $3, $4)
       on conflict (trip_id, card_id) do update set card = excluded.card`,
      [n.tripId, n.cardId, n.messageId, JSON.stringify(n.card)],
    );
  }

  async notice(tripId: string, cardId: string): Promise<SavedNotice | null> {
    const r = await this.pool.query<{ message_id: string | null; card: NoticeIn }>(
      `select message_id, card from proactive_notices where trip_id = $1 and card_id = $2`,
      [tripId, cardId],
    );
    const row = r.rows[0];
    return row ? { tripId, cardId, messageId: row.message_id, card: row.card } : null;
  }
}
