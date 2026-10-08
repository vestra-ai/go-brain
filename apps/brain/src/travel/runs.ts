/**
 * The run log: each trip's recipe runs as the engine tells them (book/run-event.ts), for the live view (live.ts). In
 * memory only: the last events of each trip, and the newest runs' pictures.
 *
 * It adds one thing the engine doesn't know: which runs went at once. A run with no parent and no fell_from opens a
 * group, or joins the one still going; a lookup joins its search's group, and a speed that fell joins its first speed's.
 * When the last run of a group ends, the group ends, with its wall time and the sum of its runs' times, so a viewer can
 * set one against the other.
 */
import type { RunEvent } from './book/run-event.js';

type RunStart = Extract<RunEvent, { type: 'run_start' }>;

/** What a viewer reads: the engine's events, a run's start with its group, and a group's end. */
export type LiveEvent =
  | Exclude<RunEvent, { type: 'run_start' }>
  | (RunStart & { group_id: string })
  | { type: 'group_end'; group_id: string; runs: number; wall_ms: number; sum_ms: number };

export interface RunLog {
  /** The engine's onRun. Never throws back into a run. */
  record(tripId: string, e: RunEvent): void;
  /** The trip's last events, oldest first, then the newest runs' pictures: what a new viewer is shown first. */
  recent(tripId: string): LiveEvent[];
  /** Every event of the trip from now on; returns the unsubscribe. */
  subscribe(tripId: string, fn: (e: LiveEvent) => void): () => void;
}

/** Events kept per trip, and runs whose pictures are kept. */
export const KEPT_EVENTS = 300;
export const KEPT_FRAME_RUNS = 4;
/** Trips kept at once; one nobody watches, with the oldest event, goes first. */
const KEPT_TRIPS = 200;
/** A group still going takes a new run only this soon after its last event: one left open by a lost run never grows. */
export const GROUP_JOIN_MS = 60_000;

interface Group {
  id: string;
  started: number;
  last: number;
  /** The runs still going, and a fallen speed's next one, which keeps the group open until it starts. */
  going: Set<string>;
  runs: number;
  sum: number;
}

interface TripRuns {
  events: LiveEvent[];
  frames: Map<string, Extract<RunEvent, { type: 'frames' }>>;
  subs: Set<(e: LiveEvent) => void>;
  groupOf: Map<string, Group>;
  open: Group | null;
  last: number;
}

export function createRunLog(o: { now: () => Date; log?: { warn(obj: object, msg: string): void } }): RunLog {
  const trips = new Map<string, TripRuns>();
  let groups = 0;

  const tripOf = (tripId: string): TripRuns => {
    let t = trips.get(tripId);
    if (!t) {
      t = { events: [], frames: new Map(), subs: new Set(), groupOf: new Map(), open: null, last: 0 };
      trips.set(tripId, t);
      while (trips.size > KEPT_TRIPS) {
        const oldest = [...trips.entries()].filter(([, v]) => v.subs.size === 0).sort((a, b) => a[1].last - b[1].last)[0];
        if (!oldest) break;
        trips.delete(oldest[0]);
      }
    }
    return t;
  };

  const tell = (t: TripRuns, tripId: string, e: LiveEvent): void => {
    if (e.type === 'frames') {
      t.frames.delete(e.run_id);
      t.frames.set(e.run_id, e);
      while (t.frames.size > KEPT_FRAME_RUNS) t.frames.delete(t.frames.keys().next().value!);
    } else {
      t.events.push(e);
      if (t.events.length > KEPT_EVENTS) t.events.splice(0, t.events.length - KEPT_EVENTS);
    }
    for (const fn of t.subs) {
      try {
        fn(e);
      } catch (err) {
        o.log?.warn({ err: String(err).slice(0, 200), tripId }, 'travel: a live viewer failed on a run event');
      }
    }
  };

  /** The group a run's start joins: its parent's or first speed's, the one still going, or a new one. */
  function join(t: TripRuns, e: RunStart, at: number): Group {
    const kin = e.parent ?? e.fell_from;
    const theirs = kin ? t.groupOf.get(kin) : undefined;
    if (theirs) return theirs;
    if (t.open && t.open.going.size > 0 && at - t.open.last < GROUP_JOIN_MS) return t.open;
    groups += 1;
    t.open = { id: `grp_${at.toString(36)}_${groups}`, started: at, last: at, going: new Set(), runs: 0, sum: 0 };
    return t.open;
  }

  return {
    record(tripId, e) {
      try {
        const t = tripOf(tripId);
        const at = o.now().getTime();
        t.last = at;
        if (e.type === 'run_start') {
          const g = join(t, e, at);
          t.groupOf.set(e.run_id, g);
          g.last = at;
          // A lookup's time is inside its search's: it never counts. A fallen speed's next one carries the recipe on.
          if (!e.parent) {
            if (e.fell_from) g.going.delete(`next:${e.fell_from}`);
            else g.runs += 1;
            g.going.add(e.run_id);
          }
          tell(t, tripId, { ...e, group_id: g.id });
          return;
        }
        tell(t, tripId, e);
        if (e.type !== 'run_end') return;
        const g = t.groupOf.get(e.run_id);
        if (!g || !g.going.delete(e.run_id)) return;
        g.last = at;
        g.sum += e.ms;
        if (e.fell_to) g.going.add(`next:${e.run_id}`);
        if (g.going.size > 0) return;
        if (t.open === g) t.open = null;
        tell(t, tripId, { type: 'group_end', group_id: g.id, runs: g.runs, wall_ms: at - g.started, sum_ms: g.sum });
      } catch (err) {
        o.log?.warn({ err: String(err).slice(0, 200), tripId }, 'travel: the run log failed on a run event');
      }
    },
    recent(tripId) {
      const t = trips.get(tripId);
      return t ? [...t.events, ...t.frames.values()] : [];
    },
    subscribe(tripId, fn) {
      const t = tripOf(tripId);
      t.subs.add(fn);
      return () => {
        t.subs.delete(fn);
      };
    },
  };
}
