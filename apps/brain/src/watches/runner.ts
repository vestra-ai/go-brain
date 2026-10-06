// Scheduled cheap checks. Each due watch sends its stored StatusQuery to P4's Travel.status as it is, compares
// the answer with its last reading, and a change worth a nudge becomes a proactive candidate keyed by the
// change, so the same change is never nudged twice.
import type pg from 'pg';
import type { Candidate } from '../proactive/policy.js';
import type { ProactiveStore } from '../proactive/store.js';
import type { StatusQuery, StatusResult, Travel } from '../travel/travel.js';
import { diffReading, type WatchChange, type WatchKind } from './diff.js';

type WatchRow = {
  watch_id: string;
  trip_id: string;
  kind: WatchKind;
  query: StatusQuery;
  person_ids: string[];
  label: string;
  last_reading: StatusResult | null;
  last_change_key: string | null;
  ends_at: Date;
  errors: number;
  notice_card_id: string | null;
};

const MIN = 60_000;
/** The proactive topic for each watch kind; the wake text (Task 5) reads these. */
const TOPIC: Readonly<Record<WatchKind, string>> = { flight: 'flight_status', pnr: 'pnr_status' };

export function nextCheckIn(reading: StatusResult, endsAt: Date, now: Date): number {
  if (reading.kind === 'flight') {
    const hours = (Date.parse(reading.expectedDepartAt) - now.getTime()) / 3600_000;
    if (hours <= 3) return 5 * MIN;
    if (hours <= 24) return 20 * MIN;
    return 120 * MIN;
  }
  // A train ticket's watch ends when the train leaves.
  const hours = (endsAt.getTime() - now.getTime()) / 3600_000;
  if (hours <= 6) return 30 * MIN;
  if (hours <= 48) return 120 * MIN;
  return 360 * MIN;
}

export function backoffMs(errors: number): number {
  return Math.min(60, 2 ** errors) * MIN;
}

function toCandidate(w: WatchRow, change: WatchChange, reading: StatusResult, now: Date): Candidate {
  return {
    tripId: w.trip_id,
    dedupeKey: change.changeKey,
    source: 'watch',
    topic: TOPIC[w.kind],
    dueAt: now,
    expiresAt: w.ends_at,
    importance: change.importance,
    confidence: change.confidence,
    urgency: change.urgency,
    useful: change.useful,
    personIds: w.person_ids,
    facts: {
      ...change.facts,
      watchId: w.watch_id,
      label: w.label,
      checkedAt: reading.checkedAt,
      ...(w.notice_card_id ? { noticeCardId: w.notice_card_id } : {}),
    },
    simulated: false,
    small: change.small,
  };
}

export interface WatchRunnerDeps {
  pool: pg.Pool;
  /** P4's travel layer; null turns watches off. */
  travel: Pick<Travel, 'status'> | null;
  store: ProactiveStore;
  now: () => Date;
  log: { warn(obj: object, msg: string): void };
}

export function createWatchRunner(d: WatchRunnerDeps): { tick(): Promise<number> } {
  let running: Promise<number> | null = null;

  async function once(): Promise<number> {
    const travel = d.travel;
    if (!travel) return 0;
    const now = d.now();
    const due = await d.pool.query<WatchRow>(
      `select watch_id, trip_id, kind, query, person_ids, label, last_reading, last_change_key, ends_at, errors, notice_card_id
       from watches where active and next_check_at <= $1 order by next_check_at limit 20`,
      [now],
    );
    let changes = 0;
    for (const w of due.rows) {
      if (now.getTime() >= w.ends_at.getTime()) {
        await d.pool.query(`update watches set active = false where watch_id = $1`, [w.watch_id]);
        continue;
      }
      let reading: StatusResult;
      try {
        reading = await travel.status(w.query);
      } catch (err) {
        const errors = w.errors + 1;
        d.log.warn({ err, watchId: w.watch_id }, 'watches: a check failed; backing off');
        await d.pool.query(
          `update watches set errors = $2, last_error = $3, next_check_at = $4 where watch_id = $1`,
          [w.watch_id, errors, (err instanceof Error ? err.message : String(err)).slice(0, 300), new Date(now.getTime() + backoffMs(errors))],
        );
        continue;
      }
      const change = diffReading(
        { watchId: w.watch_id, kind: w.kind, label: w.label, hasNotice: w.notice_card_id !== null, hasPeople: w.person_ids.length > 0, endsAt: w.ends_at },
        w.last_reading,
        reading,
        now,
      );
      let lastKey = w.last_change_key;
      if (change && change.changeKey !== w.last_change_key) {
        if ((await d.store.add(toCandidate(w, change, reading, now))) === 'added') changes += 1;
        lastKey = change.changeKey;
      }
      await d.pool.query(
        `update watches set last_reading = $2, last_change_key = $3, errors = 0, last_error = null, next_check_at = $4 where watch_id = $1`,
        [w.watch_id, JSON.stringify(reading), lastKey, new Date(now.getTime() + nextCheckIn(reading, w.ends_at, now))],
      );
    }
    return changes;
  }

  return {
    tick(): Promise<number> {
      if (!running) running = once().finally(() => { running = null; });
      return running;
    },
  };
}
