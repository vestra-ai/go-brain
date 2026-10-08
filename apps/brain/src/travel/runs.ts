/**
 * The run log: each ixigo recipe run as it happens, for the live view (live.ts). The engine reports through a run's
 * handle and never waits on it; nothing here changes how a run goes, and a handle never throws back into the engine.
 *
 * Per trip, in memory only: the last events and the newest runs' pictures. Runs of a trip that overlap in time are one
 * group (they ran in parallel), so a viewer can set the group's wall time against the sum of its runs. A lookup (a
 * place typed into ixigo's box for a search) is a run of its own under its search, in the search's group.
 *
 * What a run did, never what it read: recipe ids, speeds, a call's host and path (never its query, where a PNR or a
 * person's details would ride), statuses, times and row counts. Pictures only of search, results and details pages
 * (frame-pages.ts), as on the live card.
 */
import { randomBytes } from 'node:crypto';
import { isFramePage } from './frame-pages.js';
import type { LiveFrame } from './recipes/progress.js';

/** fast: the page's own call from the trip's warm tab; page: a page opened in the trip's browser. */
export type RunSpeed = 'fast' | 'page';

/** One call a run made, as a viewer sees it. */
export interface RunCall {
  method: string;
  /** Host and path, with no query; ixigo's own host is left out ("/hotels/api/v6/search"). */
  path: string;
  status: number;
  /** When it finished, in ms from the run's start. */
  at_ms: number;
  /** How long it took, when the speed knows (a page call does; a page's own calls only say when they finished). */
  ms?: number;
}

export interface RunFrame {
  label: string;
  at_ms: number;
  /** The page's host and path. */
  page: string;
  jpeg_base64: string;
}

export type RunEvent =
  | { type: 'run_start'; run_id: string; group_id: string; parent?: string; recipe_id: string; label: string; at: string }
  /** The run tries a speed: a fast run that fails tries the page next. */
  | { type: 'attempt'; run_id: string; speed: RunSpeed; at_ms: number }
  | ({ type: 'call'; run_id: string; speed: RunSpeed } & RunCall)
  /** A moment of a page run: the page showed, the computer woke, a speed fell to the next. */
  | { type: 'step'; run_id: string; text: string; at_ms: number }
  /** The run's own title once its inputs are filled ("Delhi to Goa trains, Fri 6 Nov"). */
  | { type: 'named'; run_id: string; label: string }
  | { type: 'run_end'; run_id: string; ok: boolean; speed: RunSpeed | 'link' | 'kept' | null; ms: number; rows?: number; why?: string }
  | { type: 'group_end'; group_id: string; runs: number; wall_ms: number; sum_ms: number }
  | { type: 'frames'; run_id: string; frames: RunFrame[] };

/** What a Bash call says about itself: its calls and, for a page, where its time went. */
export interface FetchTrace {
  speed: RunSpeed;
  /** When the call to Bash was made, in epoch ms. */
  started_at: number;
  elapsed_ms: number;
  woke?: boolean;
  /** For a page: in ms after the call arrived at Bash. */
  timings?: { wake_ms: number; nav_ms: number | null; first_capture_ms: number | null; done_ms: number } | null;
  calls: Array<{ method?: string; url: string; status: number; at_ms?: number; ms?: number }>;
  /** A call that failed: its status (504, 409, …) and how Go says it. */
  failed?: { status: number; why: string };
}

export interface RunHandle {
  readonly id: string;
  attempt(speed: RunSpeed): void;
  trace(t: FetchTrace): void;
  step(text: string): void;
  named(label: string): void;
  frames(frames: LiveFrame[]): void;
  /** A lookup under this run: in its group, not counted in the group's sum. */
  child(recipeId: string, label: string): RunHandle;
  end(ok: boolean, o?: { speed?: RunSpeed | 'link' | 'kept' | null; rows?: number; why?: string }): void;
}

export interface RunLog {
  start(tripId: string, recipeId: string, label: string): RunHandle;
  /** The trip's last events, oldest first, and the newest runs' pictures: what a new viewer is shown first. */
  recent(tripId: string): RunEvent[];
  /** Every event of the trip from now on; returns the unsubscribe. */
  subscribe(tripId: string, fn: (e: RunEvent) => void): () => void;
}

/** Events kept per trip, and runs whose pictures are kept. */
export const KEPT_EVENTS = 300;
export const KEPT_FRAME_RUNS = 4;
/** Trips kept at once; the one with the oldest event goes first. */
const KEPT_TRIPS = 200;
const LABEL_MAX = 80;

const IXIGO_HOST = 'www.ixigo.com';

/** A call's host and path, never its query: ixigo's own host is left out. Something unreadable is "(a call)". */
export function pathOf(url: string): string {
  try {
    const u = new URL(url, `https://${IXIGO_HOST}`);
    return u.hostname === IXIGO_HOST ? u.pathname : `${u.hostname}${u.pathname}`;
  } catch {
    return '(a call)';
  }
}

interface TripRuns {
  events: RunEvent[];
  /** Pictures by run, newest last. */
  frames: Map<string, RunFrame[]>;
  subs: Set<(e: RunEvent) => void>;
  /** The group runs are joining now: open while one of its top-level runs is still going. */
  group: { id: string; started: number; going: Set<string>; runs: number; sum: number } | null;
  last: number;
}

export function createRunLog(o: { now: () => Date; mint?: (prefix: string) => string; log?: { warn(obj: object, msg: string): void } }): RunLog {
  const mint = o.mint ?? ((prefix: string) => `${prefix}${randomBytes(5).toString('hex')}`);
  const trips = new Map<string, TripRuns>();

  const tripOf = (tripId: string): TripRuns => {
    let t = trips.get(tripId);
    if (!t) {
      t = { events: [], frames: new Map(), subs: new Set(), group: null, last: 0 };
      trips.set(tripId, t);
      while (trips.size > KEPT_TRIPS) {
        const oldest = [...trips.entries()].filter(([, v]) => v.subs.size === 0).sort((a, b) => a[1].last - b[1].last)[0];
        if (!oldest) break;
        trips.delete(oldest[0]);
      }
    }
    return t;
  };

  const emit = (tripId: string, e: RunEvent): void => {
    const t = tripOf(tripId);
    t.last = o.now().getTime();
    if (e.type === 'frames') {
      t.frames.delete(e.run_id);
      t.frames.set(e.run_id, e.frames);
      while (t.frames.size > KEPT_FRAME_RUNS) t.frames.delete(t.frames.keys().next().value!);
    } else {
      t.events.push(e);
      if (t.events.length > KEPT_EVENTS) t.events.splice(0, t.events.length - KEPT_EVENTS);
    }
    for (const fn of t.subs) {
      try {
        fn(e);
      } catch (err) {
        o.log?.warn({ err, tripId }, 'travel: a live viewer failed on a run event');
      }
    }
  };

  function handle(tripId: string, recipeId: string, label: string, parent?: { id: string; group: string }): RunHandle {
    const t = tripOf(tripId);
    const id = mint('run_');
    const started = o.now().getTime();
    const sinceStart = (): number => o.now().getTime() - started;
    let group: string;
    if (parent) {
      group = parent.group;
    } else {
      if (!t.group) t.group = { id: mint('grp_'), started, going: new Set(), runs: 0, sum: 0 };
      t.group.going.add(id);
      t.group.runs += 1;
      group = t.group.id;
    }
    emit(tripId, {
      type: 'run_start', run_id: id, group_id: group, ...(parent ? { parent: parent.id } : {}), recipe_id: recipeId,
      label: label.slice(0, LABEL_MAX), at: new Date(started).toISOString(),
    });
    let ended = false;
    let speedNow: RunSpeed | null = null;
    const h: RunHandle = {
      id,
      attempt(speed) {
        if (ended) return;
        speedNow = speed;
        emit(tripId, { type: 'attempt', run_id: id, speed, at_ms: sinceStart() });
      },
      trace(tr) {
        if (ended) return;
        const offset = tr.started_at - started;
        const at = (ms: number | null | undefined): number | null => (typeof ms === 'number' ? offset + ms : null);
        if (tr.woke && tr.timings?.wake_ms) emit(tripId, { type: 'step', run_id: id, text: `The computer woke (${tr.timings.wake_ms} ms)`, at_ms: at(tr.timings.wake_ms)! });
        const nav = at(tr.timings?.nav_ms);
        if (nav !== null) emit(tripId, { type: 'step', run_id: id, text: 'The page showed', at_ms: nav });
        for (const c of tr.calls) {
          emit(tripId, {
            type: 'call', run_id: id, speed: tr.speed, method: c.method ?? 'GET', path: pathOf(c.url), status: c.status,
            at_ms: at(c.at_ms) ?? offset + tr.elapsed_ms, ...(typeof c.ms === 'number' ? { ms: c.ms } : {}),
          });
        }
        if (tr.failed) emit(tripId, { type: 'step', run_id: id, text: `${tr.speed}: ${tr.failed.status}, ${tr.failed.why}`.slice(0, 160), at_ms: offset + tr.elapsed_ms });
      },
      step(text) {
        if (!ended) emit(tripId, { type: 'step', run_id: id, text: text.slice(0, 160), at_ms: sinceStart() });
      },
      named(name) {
        if (!ended) emit(tripId, { type: 'named', run_id: id, label: name.slice(0, LABEL_MAX) });
      },
      frames(list) {
        const shown = list
          .filter((f) => isFramePage(f.page_url))
          .map((f) => ({ label: f.label, at_ms: f.at_ms, page: pathOf(f.page_url), jpeg_base64: f.jpeg_base64 }));
        if (shown.length > 0) emit(tripId, { type: 'frames', run_id: id, frames: shown });
      },
      child(childRecipe, childLabel) {
        return handle(tripId, childRecipe, childLabel, { id, group });
      },
      end(ok, e = {}) {
        if (ended) return;
        ended = true;
        const ms = sinceStart();
        const speed = e.speed === undefined ? speedNow : e.speed;
        emit(tripId, {
          type: 'run_end', run_id: id, ok, speed, ms,
          ...(typeof e.rows === 'number' ? { rows: e.rows } : {}), ...(e.why ? { why: e.why.slice(0, 160) } : {}),
        });
        const g = t.group;
        if (parent || !g || g.id !== group) return;
        g.going.delete(id);
        g.sum += ms;
        if (g.going.size > 0) return;
        t.group = null;
        emit(tripId, { type: 'group_end', group_id: g.id, runs: g.runs, wall_ms: o.now().getTime() - g.started, sum_ms: g.sum });
      },
    };
    return h;
  }

  return {
    start: (tripId, recipeId, label) => handle(tripId, recipeId, label),
    recent(tripId) {
      const t = trips.get(tripId);
      if (!t) return [];
      return [...t.events, ...[...t.frames.entries()].map(([runId, frames]) => ({ type: 'frames' as const, run_id: runId, frames }))];
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
