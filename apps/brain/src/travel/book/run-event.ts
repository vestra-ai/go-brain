/**
 * What the engine says about each run as it goes, for the run strip beside Go's browser (Go Live): which recipe ran at
 * which speed, the calls it made and how long they took, and how it ended. Places and dates, paths and numbers only:
 * never a person, a query, a body or a header (a PNR rides in a query).
 *
 * A run is one recipe at one speed. A lookup is a run of its own, its parent the search it finds a place for. A speed
 * that fails ends its run with fell_to and why, and the next speed opens a new run that names it in fell_from. A
 * composite (speed steps) is a run of its own too: each of its steps is a run that names it in step_of, with its lane
 * (the entry it runs for: a home city), and they run side by side; a lookup inside a step has the step as its parent.
 *
 * Calls and steps come from what Bash says about each call (runners.ts's FetchTrace): the calls it kept, when the
 * computer woke, when the page showed and its first data came, and where a call that failed stopped. Pictures come as a
 * page sends them, only of the pages Go may show (frame-pages.ts).
 */
import { newUlid } from '../../door/ulid.js';
import { clip } from '../cards.js';
import { isFramePage } from '../frame-pages.js';
import { TravelError } from '../mcp-travel.js';
import type { LiveFrame } from '../recipes/progress.js';
import { IXIGO } from '../recipes/recipe.js';
import type { FetchTrace } from '../recipes/runners.js';
import type { Speed } from './engine.js';
import { dateAs } from './expr.js';
import type { RecipeFile } from './format.js';

export type RunEvent =
  | {
      type: 'run_start'; run_id: string; parent?: string; fell_from?: string; step_of?: string; lane?: string;
      recipe_id: string; label: string; speed: Speed; at: string;
    }
  /** method: only for a call Go made itself (the fast speed); a page's own calls come back without theirs. */
  | { type: 'call'; run_id: string; method?: 'GET' | 'POST'; path: string; status: number; at_ms: number; ms?: number }
  | { type: 'step'; run_id: string; text: string; at_ms: number }
  | { type: 'run_end'; run_id: string; ok: boolean; ms: number; rows?: number; picked?: string; fell_to?: 'page'; why?: string }
  /** A page's pictures, for the browser pane: page is its path, at_ms from the run's start. */
  | { type: 'frames'; run_id: string; frames: Array<{ label: string; at_ms: number; page: string; jpeg_base64: string }> };

/** Where a run's events go: the trip's run log. */
export type OnRun = (tripId: string, e: RunEvent) => void;

/** An address as the strip shows it: its path, with the host when it is not ixigo's, and never its query. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url, IXIGO);
    return u.origin === IXIGO ? u.pathname : `${u.host}${u.pathname}`;
  } catch {
    return '';
  }
}

/**
 * A run's name on the strip: the places and dates it was asked for ("Jaipur → Udaipur · 20 Oct"), else its title. Never
 * a text input: those are a person's own words (a PNR, a name), even where a recipe means a place by them.
 */
export function labelOf(recipe: RecipeFile, given: Record<string, unknown>): string {
  const of = (kind: string): string[] =>
    Object.entries(recipe.inputs)
      .filter(([name, input]) => input.kind === kind && typeof given[name] === 'string')
      .map(([name]) => (given[name] as string).trim());
  const places = of('place').map((p) => clip(p, 40));
  const dates = of('date').filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).map((d) => dateAs(d, 'D Mon'));
  return [places.join(' → '), dates.join(' → ')].filter((s) => s.length > 0).join(' · ') || clip(recipe.title, 60);
}

/** Why a run ended badly, short: Go's own words for a travel error, and nothing of anything else. */
export const whyOf = (err: unknown): string => (err instanceof TravelError ? clip(`${err.code}: ${err.message}`, 160) : 'failed');

/** One run on the strip, from its start: its calls and steps timed from then, and one end. */
export interface RunLine {
  id: string;
  /** What a Bash call said about itself, as the run's steps and calls, in time order. */
  trace(t: FetchTrace): void;
  /** The pictures a browser fetch that began at fetchStarted sent; those of a page Go never shows are dropped. */
  frames(frames: LiveFrame[], fetchStarted: number): void;
  step(text: string): void;
  /** The run's one end; any later end is nothing. */
  end(e: { ok: boolean; rows?: number; picked?: string; fell_to?: 'page'; why?: string }): void;
}

export function runLine(
  emit: (e: RunEvent) => void,
  now: () => Date,
  start: { recipe_id: string; label: string; speed: Speed; parent?: string; fell_from?: string; step_of?: string; lane?: string },
): RunLine {
  const started = now().getTime();
  const run_id = newUlid(started);
  let ended = false;
  const since = (): number => now().getTime() - started;
  emit({ type: 'run_start', run_id, ...start, at: new Date(started).toISOString() });
  return {
    id: run_id,
    trace(t) {
      const at = (ms: number): number => t.started_at - started + ms;
      const said: Array<Extract<RunEvent, { type: 'step' | 'call' }>> = [];
      if (t.woke && t.timings) said.push({ type: 'step', run_id, text: 'computer woke', at_ms: at(t.timings.wake_ms) });
      if (typeof t.timings?.nav_ms === 'number') said.push({ type: 'step', run_id, text: 'page showed', at_ms: at(t.timings.nav_ms) });
      if (typeof t.timings?.first_capture_ms === 'number') said.push({ type: 'step', run_id, text: 'first data', at_ms: at(t.timings.first_capture_ms) });
      for (const c of t.calls) {
        said.push({ type: 'call', run_id, ...(c.method ? { method: c.method } : {}), path: pathOf(c.url), status: c.status, at_ms: at(c.at_ms ?? t.elapsed_ms), ...(c.ms !== undefined ? { ms: c.ms } : {}) });
      }
      if (t.failed) said.push({ type: 'step', run_id, text: `stopped: ${t.failed.why}${t.failed.status ? ` (${t.failed.status})` : ''}`, at_ms: at(t.elapsed_ms) });
      for (const e of said.sort((a, b) => a.at_ms - b.at_ms)) emit(e);
    },
    frames(frames, fetchStarted) {
      const shown = frames
        .filter((f) => isFramePage(f.page_url))
        .map((f) => ({ label: f.label, at_ms: fetchStarted - started + f.at_ms, page: pathOf(f.page_url), jpeg_base64: f.jpeg_base64 }));
      if (shown.length > 0) emit({ type: 'frames', run_id, frames: shown });
    },
    step: (text) => emit({ type: 'step', run_id, text, at_ms: since() }),
    end(e) {
      if (ended) return;
      ended = true;
      emit({ type: 'run_end', run_id, ok: e.ok, ms: since(), ...(e.rows !== undefined ? { rows: e.rows } : {}), ...(e.picked ? { picked: e.picked } : {}), ...(e.fell_to ? { fell_to: e.fell_to } : {}), ...(e.why ? { why: e.why } : {}) });
    },
  };
}
