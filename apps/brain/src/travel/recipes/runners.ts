/**
 * How Go reads a page in the trip's own browser: Bash's browser fetch, a model-free call. The page opens in a background
 * tab, its steps are worked, and the page's own data calls come back with the address it ended on, in 3 to 8 s. The
 * recipe engine (book/engine.ts) decides what to open and reads what comes back. The /v1 agent job is for the long tail,
 * beyond the recipe book.
 */
import { V1Error, type V1Client } from '../../tasks/v1-client.js';
import { TravelError } from '../mcp-travel.js';
import type { LiveFrame, OnProgress } from './progress.js';
import { bodiesFor, IXIGO, type Capture, type CaptureSpec, type FetchPlan } from './recipe.js';

/** A page's own call, as a recipe's fast speed makes it: a path on ixigo, or a full https address the deployment allows. */
export interface PageCall {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

/**
 * What a Bash call says about itself, for the run strip (book/run-event.ts): the calls it kept and, for a page, where its
 * time went. Statuses, times and addresses only (the strip drops their queries); a failure by its status and code.
 */
export interface FetchTrace {
  /** When the call to Bash was made, in epoch ms. */
  started_at: number;
  elapsed_ms: number;
  woke?: boolean;
  /** In ms from when the call reached Bash. */
  timings?: { wake_ms: number; nav_ms: number | null; first_capture_ms: number | null; done_ms: number } | null;
  calls: Array<{ method?: 'GET' | 'POST'; url: string; status: number; at_ms?: number; ms?: number }>;
  /** A call that failed: its status (504, 409, …) and Bash's code, or where a timeout stopped ("ran out of time at 3 type"). */
  failed?: { status: number; why: string };
}

/** onProgress: pictures of the page, for the live search card; onTrace: where the time went, for the run strip. Both
 *  called, never awaited. */
export interface ReadOptions { signal?: AbortSignal; onProgress?: OnProgress; onTrace?: (t: FetchTrace) => void }

export interface RecipeRunner {
  name: 'browser_fetch';
  /** Opens a page, works its steps and brings back the calls the plan keeps, and the address the page ended on. */
  read(tripId: string, url: string, plan: FetchPlan, o?: ReadOptions): Promise<{ captures: Capture[]; finalUrl: string }>;
  /**
   * Makes a page's own call from the trip's warm ixigo tab (Bash's page_fetch), keeping the tab open for the next one;
   * with no tab kept, it opens ixigo's home first. The call's answer, as a capture.
   */
  pageFetch?(tripId: string, call: PageCall, o?: Omit<ReadOptions, 'onProgress'>): Promise<Capture>;
}

export interface RunnerDeps {
  v1: Pick<V1Client, 'call'>;
  computer: { userIdFor(tripId: string): string; ensureUser(tripId: string): Promise<string> };
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log: { warn(obj: object, msg: string): void };
}

const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

export const OUT_OF_CREDIT = "Go's account for the trip's computer is out of credit.";

// ── the browser fetch ────────────────────────────────────────────────────────

/**
 * How long Bash may take, the box's wake included: Bash's most. It answers as soon as the captures are in, so this only
 * matters for a sleeping box, where a stays search ran past 13 s on staging.
 */
export const FETCH_TIMEOUT_MS = 20_000;
/** A person used the browser in the last 4 s: Go waits that out once, then gives up. */
export const IN_USE_WAIT_MS = 4_000;
/** How long a page call may take before the run falls to the page speed: it answers in about 0.4 s on a warm tab. */
export const FAST_TIMEOUT_MS = 5_000;
/** How long the warm ixigo tab stays open after a page call: the next call within it needs no page load. */
export const WARM_TAB_MS = 120_000;

interface FetchAnswer {
  final_url: string;
  elapsed_ms: number;
  woke: boolean;
  timings?: FetchTrace['timings'];
  captures: Capture[];
  frames?: LiveFrame[];
  /** With a timeout: where the fetch was when the time ran out ("3 type"). */
  step?: string;
}

const isFrame = (f: unknown): f is LiveFrame =>
  typeof f === 'object' && f !== null && typeof (f as LiveFrame).jpeg_base64 === 'string' && typeof (f as LiveFrame).page_url === 'string';

/** The pictures a timed-out fetch did take, which Bash sends with its partial captures. */
function partialFrames(err: V1Error): LiveFrame[] {
  const frames = (err.detail?.['partial'] as { frames?: unknown } | undefined)?.frames;
  return Array.isArray(frames) ? frames.filter(isFrame) : [];
}

const isCapture = (c: unknown): c is Capture =>
  typeof c === 'object' && c !== null && typeof (c as Capture).url === 'string' && typeof (c as Capture).body === 'string' && typeof (c as Capture).status === 'number';

/** A failed fetch as Go says it; on a timeout, the captures it did get when every required one is among them. */
function fetchFailed(err: V1Error, what: { id: string; capture: CaptureSpec[] }, tripId: string, log: RunnerDeps['log']): Capture[] {
  if (err.status === 504) {
    const partial = (err.detail?.['partial'] as { captures?: unknown } | undefined)?.captures;
    const got = Array.isArray(partial) ? partial.filter(isCapture).map((c) => ({ ...c, truncated: c.truncated === true })) : [];
    if (what.capture.every((c) => !c.required || bodiesFor(got, c.match).length > 0)) return got;
    throw new TravelError('unreachable', 'ixigo took too long to answer. Try again in a moment.');
  }
  if (err.status === 402) throw new TravelError('refused', OUT_OF_CREDIT);
  if (err.status === 409) throw new TravelError('unreachable', "Someone is using the trip's computer's browser. Try again in a moment.");
  if (err.status === 503) throw new TravelError('unreachable', "The trip's computer did not wake up in time. Try again in a moment.");
  if (err.status === 400 || err.status === 403) {
    // Go's own setup or request is wrong (ixigo.com not allowed, a bad recipe): the admin log says so, the room hears less.
    log.warn({ tripId, page: what.id, code: err.code, message: err.message }, 'travel: the browser fetch refused a page');
    throw new TravelError('refused', err.status === 403 ? "The trip's computer is not allowed on ixigo.com yet." : 'This ixigo search could not start.');
  }
  throw new TravelError('unreachable', err.message.slice(0, 200));
}

export function createBrowserFetchRunner(d: RunnerDeps): RecipeRunner {
  const sleep = d.sleep ?? nap;
  /** One browser fetch: the page opened, its steps worked, and the calls the plan names kept. */
  async function fetchPage(
    tripId: string,
    url: string,
    plan: FetchPlan,
    what: { id: string; capture: CaptureSpec[] },
    o: ReadOptions,
  ): Promise<{ captures: Capture[]; finalUrl: string }> {
    const body = {
      url,
      // required is Go's own: Bash waits for every capture, and Go decides what a timed-out fetch can still answer.
      capture: plan.capture.map((c) => ({
        match: c.match,
        ...(c.max_bytes ? { max_bytes: c.max_bytes } : {}),
        ...(c.min_count ? { min_count: c.min_count } : {}),
        ...(c.max_count ? { max_count: c.max_count } : {}),
      })),
      ...(plan.steps ? { steps: plan.steps } : {}),
      timeout_ms: plan.timeoutMs ?? FETCH_TIMEOUT_MS,
      // Pictures of the page as it loads, about one every 700 ms, for the live search card, and one once it settles when
      // the recipe says how long that takes.
      frames: plan.settleMs ? { settle_ms: plan.settleMs } : {},
    };
    let userId = d.computer.userIdFor(tripId);
    for (let tries = 0; ; tries++) {
      const startedAt = d.now().getTime();
      try {
        const answer = await d.v1.call<FetchAnswer>('POST', `/v1/users/${userId}/browser/fetch`, { body, ...(o.signal ? { signal: o.signal } : {}) });
        // Pictures of the page come when Bash sends them; until then the card shows its steps alone.
        if (Array.isArray(answer.frames) && answer.frames.length > 0) o.onProgress?.({ type: 'frames', frames: answer.frames });
        o.onTrace?.({
          started_at: startedAt, elapsed_ms: answer.elapsed_ms, woke: answer.woke, timings: answer.timings ?? null,
          calls: answer.captures.map((c) => ({ url: c.url, status: c.status, at_ms: c.at_ms })),
        });
        return { captures: answer.captures, finalUrl: typeof answer.final_url === 'string' ? answer.final_url : url };
      } catch (err) {
        if (!(err instanceof V1Error)) throw err;
        // Once only: a trip whose user /v1 does not have yet, or a person who just used the browser.
        if (tries === 0 && err.status === 404 && err.code === 'user_not_found') {
          userId = await d.computer.ensureUser(tripId);
          continue;
        }
        if (tries === 0 && err.status === 409 && err.code === 'browser_in_use') {
          await sleep(IN_USE_WAIT_MS);
          continue;
        }
        // A timed-out fetch's pictures go to the card as a finished one's do, whatever its captures can answer.
        if (err.status === 504) {
          const frames = partialFrames(err);
          if (frames.length > 0) o.onProgress?.({ type: 'frames', frames });
        }
        o.onTrace?.(failedTrace(startedAt, d.now().getTime(), err));
        return { captures: fetchFailed(err, what, tripId, d.log), finalUrl: url };
      }
    }
  }

  /** One page call from the warm tab; with none kept, the same call on a tab opened at ixigo's home. */
  async function pageFetch(tripId: string, call: PageCall, o: Omit<ReadOptions, 'onProgress'>): Promise<Capture> {
    const step = { op: 'page_fetch', url: call.url, method: call.method, ...(call.headers ? { headers: call.headers } : {}), ...(call.body ? { body: call.body } : {}), capture_as: 'fast', max_bytes: 1_000_000 };
    const ask = (open: boolean) =>
      d.v1.call<FetchAnswer>('POST', `/v1/users/${d.computer.userIdFor(tripId)}/browser/fetch`, {
        body: { ...(open ? { url: `${IXIGO}/` } : {}), steps: [step], keep_open_ms: WARM_TAB_MS, timeout_ms: FAST_TIMEOUT_MS },
        ...(o.signal ? { signal: o.signal } : {}),
      });
    let answer: FetchAnswer;
    let startedAt = d.now().getTime();
    try {
      answer = await ask(false);
    } catch (err) {
      if (!(err instanceof V1Error) || !(err.status === 409 && err.code === 'no_open_tab')) {
        o.onTrace?.(failedTrace(startedAt, d.now().getTime(), err));
        throw pageCallFailed(err);
      }
      startedAt = d.now().getTime();
      try {
        answer = await ask(true);
      } catch (again) {
        o.onTrace?.(failedTrace(startedAt, d.now().getTime(), again));
        throw pageCallFailed(again);
      }
    }
    const got = answer.captures.find((c) => c.match === 'fast');
    // The call's own time is when its answer was in, from when Bash had the ask: the tab was already open.
    o.onTrace?.({
      started_at: startedAt, elapsed_ms: answer.elapsed_ms, woke: answer.woke, timings: answer.timings ?? null,
      calls: got ? [{ method: call.method, url: got.url || call.url, status: got.status, at_ms: got.at_ms, ms: got.at_ms }] : [],
      ...(got ? {} : { failed: { status: 0, why: 'no answer to the page call' } }),
    });
    if (!got || got.status < 200 || got.status >= 300 || got.truncated) throw new TravelError('unreachable', `ixigo's page call answered ${got ? got.status : 'nothing'}.`);
    return got;
  }

  return {
    name: 'browser_fetch',
    async read(tripId, url, plan, o = {}) {
      return fetchPage(tripId, url, plan, { id: new URL(url).pathname, capture: plan.capture }, o);
    },
    pageFetch: (tripId, call, o = {}) => pageFetch(tripId, call, o),
  };
}

/**
 * A Bash call that failed, for the run strip: its status and code, never its message. A timeout carries what the page did
 * before the time ran out (Bash's partial): when the computer woke, when the page showed, the calls kept, where it stopped.
 */
function failedTrace(startedAt: number, endedAt: number, err: unknown): FetchTrace {
  if (!(err instanceof V1Error)) return { started_at: startedAt, elapsed_ms: endedAt - startedAt, calls: [], failed: { status: 0, why: 'failed' } };
  const partial: Partial<FetchAnswer> = (err.status === 504 ? (err.detail?.['partial'] as Partial<FetchAnswer> | undefined) : undefined) ?? {};
  const { step, elapsed_ms: elapsed, woke, timings, captures } = partial;
  const why = err.status === 504 ? `ran out of time${typeof step === 'string' ? ` at ${step}` : ''}` : err.code;
  return {
    started_at: startedAt,
    elapsed_ms: typeof elapsed === 'number' ? elapsed : endedAt - startedAt,
    ...(typeof woke === 'boolean' ? { woke } : {}),
    timings: timings ?? null,
    calls: Array.isArray(captures) ? captures.filter(isCapture).map((c) => ({ url: c.url, status: c.status, at_ms: c.at_ms })) : [],
    failed: { status: err.status, why },
  };
}

/** A page call that failed, as a TravelError: the run then falls to the page speed. */
function pageCallFailed(err: unknown): TravelError {
  if (err instanceof TravelError) return err;
  if (err instanceof V1Error) return new TravelError(err.status === 402 ? 'refused' : 'unreachable', err.status === 402 ? OUT_OF_CREDIT : err.message.slice(0, 200));
  return new TravelError('unreachable', String(err).slice(0, 200));
}
