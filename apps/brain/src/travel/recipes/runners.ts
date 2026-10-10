/**
 * How Go reads a page in the trip's own browser: Bash's browser fetch, a model-free call. The page opens in a background
 * tab, its steps are worked, and the page's own data calls come back with the address it ended on, in 3 to 8 s. The
 * recipe engine (book/engine.ts) decides what to open and reads what comes back. The /v1 agent job is for the long tail,
 * beyond the recipe book.
 */
import { V1Error, type V1Client } from '../../tasks/v1-client.js';
import { TravelError } from '../mcp-travel.js';
import type { LiveFrame, OnProgress } from './progress.js';
import { bodiesFor, IXIGO, type Capture, type CaptureSpec, type FetchPlan, type Step } from './recipe.js';

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
export interface ReadOptions {
  signal?: AbortSignal;
  onProgress?: OnProgress;
  onTrace?: (t: FetchTrace) => void;
  /** Its place among fetches waiting for one of the computer's slots: lower goes first (a composite's trains before its
   *  buses); the same, first come first served. None is 0. */
  priority?: number;
  /** The run's id, which Bash's browser watch names the fetch's tab by, so the live view labels the tab's tile with its run. */
  tag?: string;
  /**
   * A page a person is waiting on: its tab stays open on its page after the answer, as the trip's warm tab (WARM_TAB_MS).
   * ixigo draws what it answered about 2 s after its data (8 Oct probe: the hotel list 2.1 s after the accommodations
   * call), after Bash has answered, so a tab closed at the answer only ever showed the live view ixigo's skeleton. The
   * answer never waits for the drawing; the next page call runs in this tab with no page load.
   */
  keepOpen?: boolean;
  /** With keepOpen, for a live card: one more picture of the kept tab once ixigo has drawn it (LOOK_AFTER_MS, `drawn`). */
  look?: boolean;
  /**
   * A person watches: the page opens on the browser's stage (Bash's stage), in front, in the one tab every watched read
   * uses (STAGE_TAB), its steps done where the room's live view sees them, and the page left on screen STAGE_MS after.
   */
  stage?: boolean;
  /**
   * The trip account's own page (an auth: login recipe's: My Trips, the help centre's bookings): a tab the browser watch
   * never shows, stage or not (Bash's private), and no picture of it taken. A Bash that predates private refuses it, and
   * the read fails: never read where the room could see it (the lead, 10 Oct).
   */
  private?: boolean;
  /**
   * The caller reads another way when the page catches nothing (a filtered stays search reads its page again unfiltered,
   * backend.ts): such a page is never asked twice here, and throws NothingCaughtError.
   */
  fallsBack?: boolean;
  /** What the read is, for the log when its time runs out: its recipe, its conditions, its yes-or-no lets. No words, no dates. */
  about?: Record<string, string | boolean | string[]>;
}

export interface RecipeRunner {
  name: 'browser_fetch';
  /** Opens a page, works its steps and brings back the calls the plan keeps, and the address the page ended on. */
  read(tripId: string, url: string, plan: FetchPlan, o?: ReadOptions): Promise<{ captures: Capture[]; finalUrl: string }>;
  /**
   * Makes a page's own call from the trip's warm ixigo tab (Bash's page_fetch), keeping the tab open for the next one;
   * with no tab kept, it opens ixigo's home first. The call's answer, as a capture.
   */
  pageFetch?(tripId: string, call: PageCall, o?: Omit<ReadOptions, 'onProgress'>): Promise<Capture>;
  /** Whether page calls are worth trying now: false for a while after a Bash without page_fetch refused one. */
  canPageFetch?(): boolean;
  /** A new trip's computer's first ixigo visit, before anyone asks (COLD_COMPUTER below). Throws when ixigo did not answer. */
  prime?(tripId: string): Promise<void>;
  /**
   * A hand-off the person finishes themselves (the ixigo login), with no model: the page opens in FRONT of their window on
   * the trip's computer (Bash's front), its steps run, and its tab stays there for them, kept under `tab`. A page that ran
   * out of time stays open for them all the same, with what it caught. `check`: one call from inside the page before the
   * steps (one byte, its status, as capture `check`). Throws a TravelError when Bash would not open it. challenged: the
   * page stayed on Cloudflare's check (CLOUDFLARE), and the caller closes it: it is never the person's. device: desktop
   * opens the site's desktop page (Bash's front_device), the one every other fetch on the browser reads; a Bash without
   * it opens the phone page, and the answer says which ran.
   */
  handOff?(
    tripId: string, url: string, plan: FetchPlan, o: { keepOpenMs: number; tab: string; check?: PageCall; device?: 'desktop' },
  ): Promise<{ captures: Capture[]; challenged?: true; device?: 'phone' | 'desktop' }>;
  /** Closes a hand-off's tab, so the person's own window is on top again; nothing when it is already gone. */
  release?(tripId: string, tab: string): Promise<void>;
  /**
   * Steps on the page the stage already holds (Bash's url-less fetch on the stage tab), with the calls the page they lead
   * to makes caught as for a read: a person's click on what the room is watching, a stay's card on the results opening its
   * page in the same tab. What Bash answers, as read() gives it; a stage with no page open is a TravelError.
   */
  onStage?(tripId: string, plan: FetchPlan, o?: ReadOptions): Promise<{ captures: Capture[]; finalUrl: string }>;
  /** When a page this trip's computer opened last met Cloudflare's check (CLOUDFLARE), in ms; null when none has. */
  lastChallenge?(tripId: string): number | null;
  /**
   * One page call from inside the kept tab of that name (Bash's page_fetch on it, no url), keeping the tab keepOpenMs
   * more: one byte of its answer, for its status. Null when no tab is kept under that name.
   */
  tabCall?(tripId: string, tab: string, call: PageCall, keepOpenMs: number): Promise<Capture | null>;
  /**
   * Steps on the kept hand-off tab of that name, kept in front for keepOpenMs more (Bash's url-less front fetch): a tap or
   * two on a page the person already watches. Best effort: a step not found (Bash's time runs out with the tab kept) or a
   * tab already gone is nothing; anything else Bash refuses is a TravelError.
   */
  tabSteps?(tripId: string, tab: string, steps: Step[], o: { keepOpenMs: number; timeoutMs: number }): Promise<void>;
}

export interface RunnerDeps {
  v1: Pick<V1Client, 'call'>;
  /**
   * The trip's browser (tasks/browsers.ts): the /v1 user whose Chrome every fetch here runs in, the organizer's own,
   * shared by all of their trips; again makes it on /v1 once more, when /v1 said it does not know it.
   */
  browser: { userFor(tripId: string): Promise<string>; again(tripId: string): Promise<string> };
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log: { warn(obj: object, msg: string): void };
  /** How many browser fetches Go runs at once on one trip's computer: Bash's own cap (the BROWSER_FETCH_SLOTS switch). */
  slots?: () => number;
}

const nap = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

/** Bash's cap on a computer's fetches at once, until it says otherwise: two. */
export const DEFAULT_SLOTS = 2;
/** Bash refused a fetch because all its own are taken (409 browser_busy): Go waits as long as Bash says, this many times. */
export const BUSY_TRIES = 5;
const BUSY_WAIT_MS = 1_000;

/**
 * Go's own count of the fetches running on each computer (by its /v1 user, whatever trip or run asks), so it asks Bash
 * for no more at once than Bash runs: a fetch over the count waits here for one to end, first come first served, instead
 * of being refused. A fetch that is waiting when its signal aborts leaves without asking Bash anything.
 */
function fetchSlots(slots: () => number): (box: string, signal?: AbortSignal, priority?: number) => Promise<() => void> {
  const running = new Map<string, number>();
  const waiting = new Map<string, Array<{ go: () => void; priority: number }>>();
  const room = (box: string): boolean => (running.get(box) ?? 0) < Math.max(1, slots());
  const pump = (box: string): void => {
    const queue = waiting.get(box);
    while (queue?.length && room(box)) {
      running.set(box, (running.get(box) ?? 0) + 1);
      queue.shift()!.go();
    }
    if (queue?.length === 0) waiting.delete(box);
  };
  return async (box, signal, priority = 0) => {
    if (signal?.aborted) throw signal.reason;
    if (room(box) && !waiting.has(box)) {
      running.set(box, (running.get(box) ?? 0) + 1);
    } else {
      await new Promise<void>((resolve, reject) => {
        const queue = waiting.get(box) ?? [];
        waiting.set(box, queue);
        const stop = (): void => {
          queue.splice(queue.indexOf(entry), 1);
          if (queue.length === 0) waiting.delete(box);
          reject(signal!.reason);
        };
        const entry = {
          priority,
          go: (): void => {
            signal?.removeEventListener('abort', stop);
            resolve();
          },
        };
        signal?.addEventListener('abort', stop, { once: true });
        // After every waiting fetch of its priority or a lower one; then whoever is first goes, if there is room (the
        // slots were raised while fetches waited).
        const at = queue.findIndex((w) => w.priority > priority);
        queue.splice(at === -1 ? queue.length : at, 0, entry);
        pump(box);
      });
    }
    let freed = false;
    return () => {
      if (freed) return;
      freed = true;
      const left = (running.get(box) ?? 1) - 1;
      if (left > 0) running.set(box, left);
      else running.delete(box);
      pump(box);
    };
  };
}

/** How long Bash says to wait before asking again when its fetches are all taken. */
function busyWaitMs(err: V1Error): number {
  const said = Number(err.detail?.['retry_after_ms']);
  return Number.isFinite(said) && said > 0 ? Math.min(said, 5_000) : (err.retryAfterMs ?? BUSY_WAIT_MS);
}
const isBusy = (err: unknown): boolean => err instanceof V1Error && err.status === 409 && err.code === 'browser_busy';

export const OUT_OF_CREDIT = "Go's account for the trip's computer is out of credit.";
export const PAYMENT_PAGE_BLOCKED = "That's the payment page, and Go never opens it; the payer finishes on ixigo.";

// ── the browser fetch ────────────────────────────────────────────────────────

/**
 * How long Bash may take, the box's wake included: Bash's most. It answers as soon as the captures are in, so this only
 * matters for a sleeping box, where a stays search ran past 13 s on staging.
 */
export const FETCH_TIMEOUT_MS = 20_000;
/** How wide Bash takes a fetch's pictures: the width of its window, so a picture is sharp at its own size, never stretched. */
export const FRAME_WIDTH = 1280;
/** Pictures a second Go asks Bash's watch for: its most, since Bash shares them across the open tabs (6 gave about 3 a tab). */
export const WATCH_FPS = 10;
/** A person used the browser in the last 4 s (Bash's quiet window): Go asks again past it. */
export const IN_USE_WAIT_MS = 5_000;
/**
 * How long a read waits for the browser while a person has it (ixigo's login open on Go's screen, on a Bash from before
 * reads ran behind it; a person driving it on Watch): as long as a login is held open there. It never fails for it: the
 * live card says so once, a search outlives its turn (tools.ts handOver) and its card goes up when it lands. Its signal,
 * when it has one, ends the wait sooner.
 */
export const IN_USE_PATIENCE_MS = 10 * 60_000;
/** A hand-off's own page asks again this many times while the person is still typing on Watch (staging, 9 Oct, 18:52). */
export const HANDOFF_IN_USE_TRIES = 3;
/** How long a page call may take before the run falls to the page speed: it answers in about 0.4 s on a warm tab. */
export const FAST_TIMEOUT_MS = 5_000;
/**
 * How long the warm ixigo tab stays open after a page call, or after a page a person waited on (keepOpen): the next call
 * within it needs no page load, and the live view sees the page drawn.
 */
export const WARM_TAB_MS = 120_000;
/** The stage's tab (ReadOptions.stage): one for the trip's browser, every watched read opening its page in it. */
export const STAGE_TAB = 'stage';
/** How long the stage stays on its last page after a read, on screen for the room, until the next one takes it. */
export const STAGE_MS = 300_000;
/**
 * How long Go stops trying page calls after Bash refused one as a request it doesn't take (a 400: a Bash with no
 * page_fetch yet), or answered with no page call in it. Once Bash has page_fetch, they resume within this, with no deploy
 * of Go's.
 */
export const FAST_UNSUPPORTED_MS = 10 * 60_000;
/**
 * How long Go leaves a click's within_ms out after a Bash refused it (one that predates it: its steps take no unknown
 * field): the click then looks once, as before. Once Bash has it, it is sent again within this, with no deploy of Go's.
 */
export const LOOK_UNSUPPORTED_MS = 10 * 60_000;

/** The steps with no within_ms: what an optional click is on a Bash that predates it, a single look. */
export const withoutLook = (steps: Step[]): Step[] =>
  steps.map((s) => {
    if (s.op !== 'click' || s.within_ms === undefined) return s;
    const { within_ms: _within, ...once } = s;
    return once;
  });

/** Bash refused the fetch for a click's within_ms: its 400 names that step (param "steps.0"), never by its message. */
function refusedLook(err: V1Error, steps: Step[] | undefined): boolean {
  if (err.status !== 400 || err.code !== 'invalid_request' || !steps) return false;
  const param = err.detail?.['param'];
  const at = typeof param === 'string' ? /^steps\.(\d+)(?:\.|$)/.exec(param) : null;
  const step = at ? steps[Number(at[1])] : undefined;
  return step?.op === 'click' && step.within_ms !== undefined;
}
/**
 * COLD_COMPUTER. A computer's Chrome on its first ixigo visit, with none of ixigo's cookies, can draw a page that never
 * makes its search call (staging, 8 Oct: a new trip's first stays search sat 12 s on skeletons under ixigo's popup, with
 * nothing caught). So a new trip's computer visits ixigo once at setup (prime: the home page, its popup closed if it is
 * there, one call from inside the page), and a page that runs out of time with nothing caught is asked once more at once:
 * the second visit is warm. A warm computer's too (staging, 9 Oct: a logged-in computer's stays page caught nothing for
 * 20 s at 14:54, and the same computer read stays in 8 s at 14:55), unless the read's caller has another way (fallsBack:
 * a filtered stays search, which reads the page again unfiltered, backend.ts). How long the prime may take, a computer
 * just made waking included.
 */
export const PRIME_TIMEOUT_MS = 15_000;
/**
 * When the look at a kept page goes, after the answer: ixigo drew the hotel list 2.1 s after its data on a cold box
 * (8 Oct probe), and Bash answers about 1.3 s after the data, so this is past the drawing with room to spare.
 */
export const LOOK_AFTER_MS = 2_500;
/** The look's own time: a tab already open and one tiny call inside it. */
export const LOOK_TIMEOUT_MS = 5_000;
/**
 * The look's pictures, taken through Bash's settle window (its most). Without one, a look ends about 0.3 s after it starts
 * and Bash waits only 100 ms for the picture still being taken, so it came back with none (the 8 Oct verify of #242: the
 * card kept the skeleton). With it, three pictures of the drawn page in about 1 s (probe: 155, 496 and 836 ms, 116 KB).
 */
export const LOOK_SETTLE_MS = 700;
/** The one call a look makes inside the tab: Bash takes no fetch without a call or a capture, and ixigo's icon is the smallest. */
const LOOK_STEP = { op: 'page_fetch', url: '/favicon.ico', method: 'GET', capture_as: 'look', max_bytes: 1_000 };

/**
 * CLOUDFLARE. ixigo sits behind Cloudflare, which now and then answers a page load with its own check ("Just a moment...")
 * instead of the page: about 1 in 7 front loads on a staging box (8 Oct), where every box leaves through one address.
 * The page's own document then answers 403 (or 503) at the address asked, and the page makes none of its calls. So every
 * page Go opens keeps its document's answer too (pageDoc: one byte, its status, never waited for). A check that passes
 * in the page (a real browser's usually does, in about 5 s) loads it again (200), so the last answer says, and that load
 * keeps its whole time. A page still on the check when its time ran out is opened again CHALLENGE_WAIT_MS later, at most
 * CHALLENGE_TRIES more times, while the loads fit in twice the page's own time (challengeTime: a hand-off's 12 s makes
 * 24 s before Watch or its card) with at least CHALLENGE_LOAD_MS for the next. It is never read as anything, and never
 * handed to a person. ixigo's own "too many requests" (429 on the document, staging 9 Oct: the morning computer's
 * hotels page at 18:01 and 18:04, the page then making no call for 20 s) is waited out the same way.
 */
export const CHALLENGE_WAIT_MS = 1_000;
/** The trips whose last check Go remembers (lastChallenge). */
const CHECKED_TRIPS_MAX = 1_000;
export const CHALLENGE_TRIES = 2;
/** The least a load again may have: a check that passes takes about 5 s, then the page's own calls about 3 s. */
export const CHALLENGE_LOAD_MS = 8_000;
/** How long all of a page's loads may take, from the first one's start: twice the page's own time. */
export const challengeTime = (pageMs: number): number => 2 * pageMs;
/**
 * The time the next load gets, Go waits CHALLENGE_WAIT_MS first: the page's own, or what is left of challengeTime; null
 * when that is less than CHALLENGE_LOAD_MS, or the tries are used up.
 */
function nextLoadMs(pageMs: number, started: number, now: number, loadsAgain: number): number | null {
  const left = started + challengeTime(pageMs) - now - CHALLENGE_WAIT_MS;
  return loadsAgain >= CHALLENGE_TRIES || left < CHALLENGE_LOAD_MS ? null : Math.min(pageMs, left);
}
export const CHALLENGED = "ixigo asked the trip's computer to wait a moment. Try again in a minute.";
/** A read whose page stayed on the check: unreachable, saying so; a caller that must tell it from other failures asks for this class. */
export class ChallengedError extends TravelError {
  constructor() {
    super('unreachable', CHALLENGED);
  }
}
/**
 * A read whose caller falls back (ReadOptions.fallsBack) and whose page ran out of time having caught nothing but its own
 * document: ixigo never sent its data. Unreachable as any timeout, so a caller with no other way says it as ever.
 */
export class NothingCaughtError extends TravelError {
  constructor() {
    super('unreachable', 'ixigo took too long to answer. Try again in a moment.');
  }
}
/**
 * The capture of a page's own document: its path, to the end. Bash matches it on any allowed site's response whose path
 * ends so (the home page's "/$" takes an API path ending in "/" too), so up to 4 are kept, and challenged reads only the
 * page's own.
 */
export const pageDoc = (url: string): string => `${new URL(url).pathname}$`;
const docCapture = (doc: string) => ({ match: doc, required: false, max_bytes: 1, max_count: 4 });
/**
 * Whether the page ended on Cloudflare's check, or ixigo's "too many requests": the last answer at the page's own address
 * (its origin and path exactly, the query aside: the check's own load again adds one) was 403, 429 or 503. Another
 * response its match took is never it.
 */
export function challenged(captures: Capture[], pageUrl: string): boolean {
  const page = new URL(pageUrl);
  const own = (c: Capture): boolean => {
    if (c.match !== pageDoc(pageUrl)) return false;
    try {
      const at = new URL(c.url);
      return at.origin === page.origin && at.pathname === page.pathname;
    } catch {
      return false;
    }
  };
  const last = captures.filter(own).sort((a, b) => a.at_ms - b.at_ms).at(-1)?.status;
  return last === 403 || last === 429 || last === 503;
}

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
/** A timed-out fetch that caught nothing at all but its page's own document. */
function caughtNothing(err: V1Error, doc: string): boolean {
  const captures = (err.detail?.['partial'] as { captures?: unknown } | undefined)?.captures;
  return !Array.isArray(captures) || captures.every((c) => (c as Capture | null)?.match === doc);
}

function partialFrames(err: V1Error): LiveFrame[] {
  const frames = (err.detail?.['partial'] as { frames?: unknown } | undefined)?.frames;
  return Array.isArray(frames) ? frames.filter(isFrame) : [];
}

const isCapture = (c: unknown): c is Capture =>
  typeof c === 'object' && c !== null && typeof (c as Capture).url === 'string' && typeof (c as Capture).body === 'string' && typeof (c as Capture).status === 'number';
/** What a timed-out fetch did catch. */
const partialCaptures = (err: V1Error): Capture[] => {
  const captures = (err.detail?.['partial'] as { captures?: unknown } | undefined)?.captures;
  return Array.isArray(captures) ? captures.filter(isCapture) : [];
};
/**
 * A timed-out page that showed Cloudflare's Turnstile: its document said 200 (staging, 10 Oct 05:02Z, ixigo's flight status
 * page), so challenged() can't see it, and its calls never came. Bash says the page called the check's host. Read as a
 * check: opened again after a wait, never read, never handed to the person.
 */
const turnstiled = (err: V1Error): boolean => (err.detail?.['partial'] as { challenge?: unknown } | undefined)?.challenge === 'turnstile';

/**
 * A failed fetch as Go says it; on a timeout, the captures it did get when every required one is among them. A read that
 * falls back (fallsBack), whose page caught nothing but its document (doc), throws NothingCaughtError.
 */
function fetchFailed(
  err: V1Error, what: { id: string; capture: CaptureSpec[] }, tripId: string, log: RunnerDeps['log'], o: Pick<ReadOptions, 'fallsBack' | 'about'> & { doc: string },
): Capture[] {
  if (err.status === 504) {
    const partial = (err.detail?.['partial'] as { captures?: unknown; step?: unknown } | undefined) ?? {};
    const got = Array.isArray(partial.captures) ? partial.captures.filter(isCapture).map((c) => ({ ...c, truncated: c.truncated === true })) : [];
    if (what.capture.every((c) => !c.required || bodiesFor(got, c.match).length > 0)) return got;
    // Bash's words ("stopped at 2 wait_for"), where it stopped, what it caught by then (statuses only) and what the read
    // was: the admin log keeps them. Bash's words go under bash: Railway's log takes a field named message for the line's
    // own, and lost the step (9 Oct, 14:55).
    log.warn({
      tripId, page: what.id, bash: err.message.slice(0, 300), ...(typeof partial.step === 'string' ? { step: partial.step } : {}),
      caught: got.map((c) => `${c.match === o.doc ? 'document' : 'call'} ${c.status}`), ...(o.about ? { read: o.about } : {}),
    }, 'travel: a page ran out of time');
    if (o.fallsBack && caughtNothing(err, o.doc)) throw new NothingCaughtError();
    throw new TravelError('unreachable', 'ixigo took too long to answer. Try again in a moment.');
  }
  if (err.status === 402) throw new TravelError('refused', OUT_OF_CREDIT);
  if (isBusy(err)) throw new TravelError('unreachable', "The trip's computer is busy with other searches. Try again in a moment.");
  if (err.status === 409) throw new TravelError('unreachable', "Someone is using the trip's computer's browser. Try again in a moment.");
  if (err.status === 503) throw new TravelError('unreachable', "The trip's computer did not wake up in time. Try again in a moment.");
  // Bash's block on ixigo's payment page (#4591): never a fault of Go's setup, and never a page Go opens.
  if (err.status === 403 && err.code === 'page_blocked') throw new TravelError('refused', PAYMENT_PAGE_BLOCKED);
  if (err.status === 400 || err.status === 403) {
    // Go's own setup or request is wrong (ixigo.com not allowed, a bad recipe): the admin log says so, the room hears less.
    log.warn({ tripId, page: what.id, code: err.code, message: err.message }, 'travel: the browser fetch refused a page');
    throw new TravelError('refused', err.status === 403 ? "The trip's computer is not allowed on ixigo.com yet." : 'This ixigo search could not start.');
  }
  throw new TravelError('unreachable', err.message.slice(0, 200));
}

export function createBrowserFetchRunner(d: RunnerDeps): RecipeRunner {
  const sleep = d.sleep ?? nap;
  const slot = fetchSlots(d.slots ?? (() => DEFAULT_SLOTS));
  /** When each trip's computer last met Cloudflare's check, newest last; bounded. */
  const checkedAt = new Map<string, number>();
  const metCheck = (tripId: string): void => {
    checkedAt.delete(tripId);
    checkedAt.set(tripId, d.now().getTime());
    while (checkedAt.size > CHECKED_TRIPS_MAX) checkedAt.delete(checkedAt.keys().next().value!);
  };

  /**
   * A Bash call, asked again while Bash says its fetches are all taken (one Go doesn't count, or a cap lowered), inside
   * the fetch's own time: once its signal aborts, it asks no more. A person using the browser (browser_in_use) is not this.
   */
  async function patient<T>(call: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    for (let busy = 0; ; busy++) {
      try {
        return await call();
      } catch (err) {
        if (!(err instanceof V1Error) || !isBusy(err) || busy >= BUSY_TRIES || signal?.aborted) throw err;
        await sleep(busyWaitMs(err));
      }
    }
  }

  /** A fetch on the trip's computer, once one of its slots is free; the slot frees when the fetch ends, however it ends. */
  async function inSlot<T>(tripId: string, o: Pick<ReadOptions, 'signal' | 'priority'>, run: () => Promise<T>): Promise<T> {
    const free = await slot(await d.browser.userFor(tripId), o.signal, o.priority);
    try {
      return await run();
    } finally {
      free();
    }
  }

  /** The computers a fetch of Go's has read ixigo on (COLD_COMPUTER), which the log tells from cold ones. */
  const warm = new Set<string>();
  /** Until when a click's within_ms is left out: Bash refused it (LOOK_UNSUPPORTED_MS). */
  let noLookUntil = 0;
  /** Until when a hand-off opens the phone page however asked: Bash refused front_device (LOOK_UNSUPPORTED_MS). */
  let noDesktopUntil = 0;

  /** One browser fetch: the page opened, its steps worked, and the calls the plan names kept. */
  async function fetchPage(
    tripId: string,
    url: string,
    plan: FetchPlan,
    what: { id: string; capture: CaptureSpec[] },
    o: ReadOptions,
  ): Promise<{ captures: Capture[]; finalUrl: string }> {
    const steps = plan.steps && d.now().getTime() < noLookUntil ? withoutLook(plan.steps) : plan.steps;
    const doc = pageDoc(url);
    let body = {
      url,
      // required is Go's own: Bash waits for every capture, and Go decides what a timed-out fetch can still answer. A plan
      // with a grace says which are required, so Bash answers once they are in and the rest have had the grace.
      capture: [
        ...plan.capture.map((c) => ({
          match: c.match,
          ...(plan.graceMs ? { required: c.required } : c.besides ? { required: false } : {}),
          ...(c.max_bytes ? { max_bytes: c.max_bytes } : {}),
          ...(c.min_count ? { min_count: c.min_count } : {}),
          ...(c.max_count ? { max_count: c.max_count } : {}),
        })),
        docCapture(doc),
      ],
      ...(steps ? { steps } : {}),
      timeout_ms: plan.timeoutMs ?? FETCH_TIMEOUT_MS,
      ...(plan.graceMs ? { grace_ms: plan.graceMs } : {}),
      // Pictures of the page as it loads, about one every 700 ms, for the live search card, and one once it settles when
      // the recipe says how long that takes. None of a private page, whose tab the browser watch never shows either.
      ...(o.private ? { private: true } : { frames: { width: FRAME_WIDTH, ...(plan.settleMs ? { settle_ms: plan.settleMs } : {}) } }),
      ...(o.tag ? { tag: o.tag } : {}),
      // Under Bash's default name, the one the page calls take: one warm tab a trip, never one more toward Bash's cap.
      ...(o.stage ? { stage: true, tab: STAGE_TAB, keep_open_ms: STAGE_MS } : o.keepOpen ? { keep_open_ms: WARM_TAB_MS } : {}),
    };
    let userId = await d.browser.userFor(tripId);
    let askedAgain = false;
    let waited = false;
    const pageMs = body.timeout_ms;
    const started = d.now().getTime();
    let checks = 0;
    /**
     * CLOUDFLARE: the page opened again after a wait, with the time left for it, while it fits and the caller still waits;
     * else a read that fails, saying so.
     */
    const againAfterCheck = async (): Promise<void> => {
      metCheck(tripId);
      const next = nextLoadMs(pageMs, started, d.now().getTime(), checks);
      if (next === null || o.signal?.aborted) {
        d.log.warn({ tripId, page: what.id, loads: checks + 1 }, "travel: ixigo's page stayed on Cloudflare's check");
        throw new ChallengedError();
      }
      checks += 1;
      d.log.warn({ tripId, page: what.id, again: checks, ms: next }, "travel: ixigo's page was Cloudflare's check; opening it again");
      await sleep(CHALLENGE_WAIT_MS);
      body = { ...body, timeout_ms: next };
    };
    for (let tries = 0; ; tries++) {
      const startedAt = d.now().getTime();
      try {
        const answer = await patient(() => d.v1.call<FetchAnswer>('POST', `/v1/users/${userId}/browser/fetch`, { body, ...(o.signal ? { signal: o.signal } : {}) }), o.signal);
        const calls = answer.captures.map((c) => ({ url: c.url, status: c.status, at_ms: c.at_ms }));
        // CLOUDFLARE: its pictures never go to the card, and the page is opened again.
        if (challenged(answer.captures, url)) {
          o.onTrace?.({ started_at: startedAt, elapsed_ms: answer.elapsed_ms, woke: answer.woke, timings: answer.timings ?? null, calls, failed: { status: 0, why: 'challenge' } });
          await againAfterCheck();
          continue;
        }
        const captures = answer.captures.filter((c) => c.match !== doc);
        if (captures.length > 0) warm.add(userId);
        // Pictures of the page come when Bash sends them; until then the card shows its steps alone.
        if (Array.isArray(answer.frames) && answer.frames.length > 0) o.onProgress?.({ type: 'frames', frames: answer.frames });
        o.onTrace?.({ started_at: startedAt, elapsed_ms: answer.elapsed_ms, woke: answer.woke, timings: answer.timings ?? null, calls });
        const finalUrl = typeof answer.final_url === 'string' ? answer.final_url : url;
        if ((o.keepOpen || o.stage) && o.look && o.onProgress) look(tripId, finalUrl, startedAt, o.onProgress, o.tag, o.stage === true);
        return { captures, finalUrl };
      } catch (err) {
        if (!(err instanceof V1Error)) throw err;
        // A Bash that predates private refuses it before it opens anything (an unknown key at the body's top: no param, or
        // one at private). The account's page is then not read at all, never where the room could see it.
        const param = String(err.detail?.['param'] ?? '');
        if (o.private && err.status === 400 && err.code === 'invalid_request' && (param === '' || param.startsWith('private'))) {
          throw new TravelError('refused', "The trip's ixigo account is read only where nobody else can see it, and Go's computer can't do that yet.");
        }
        // Once only: a trip whose user /v1 does not have yet, or a person who just used the browser.
        if (tries === 0 && err.status === 404 && err.code === 'user_not_found') {
          userId = await d.browser.again(tripId);
          continue;
        }
        // A person has the browser: wait for them, never "didn't work" (staging, 9 Oct: a login left open refused every
        // search on the person's browser for 10 minutes, and Go fell back to a slow job).
        if (err.status === 409 && err.code === 'browser_in_use' && !o.signal?.aborted && d.now().getTime() - started < IN_USE_PATIENCE_MS) {
          if (!waited) o.onProgress?.({ type: 'waiting' });
          waited = true;
          await sleep(IN_USE_WAIT_MS);
          continue;
        }
        // A Bash that predates within_ms refuses the whole fetch before it opens anything: the same fetch again with its
        // optional clicks looking once, as before, and none sent for a while.
        if (body.steps && refusedLook(err, body.steps)) {
          noLookUntil = d.now().getTime() + LOOK_UNSUPPORTED_MS;
          body = { ...body, steps: withoutLook(body.steps) };
          d.log.warn({ tripId, page: what.id }, "travel: this Bash takes no within_ms on a click yet; its optional clicks look once");
          continue;
        }
        // CLOUDFLARE: a page still on the check when its time ran out, opened again; never its pictures.
        if (err.status === 504 && (challenged(partialCaptures(err), url) || turnstiled(err))) {
          o.onTrace?.(failedTrace(startedAt, d.now().getTime(), err));
          await againAfterCheck();
          continue;
        }
        // A page that caught nothing (COLD_COMPUTER): once more, now that the computer has been to ixigo, cold or warm;
        // never for a caller with another way (fallsBack), which hears NothingCaughtError at once.
        if (err.status === 504 && !askedAgain && !o.fallsBack && caughtNothing(err, doc) && !o.signal?.aborted) {
          askedAgain = true;
          o.onTrace?.(failedTrace(startedAt, d.now().getTime(), err));
          d.log.warn({ tripId, page: what.id, cold: !warm.has(userId) }, 'travel: a page caught nothing; asking once more');
          continue;
        }
        // A timed-out fetch's pictures go to the card as a finished one's do, whatever its captures can answer.
        if (err.status === 504) {
          const frames = partialFrames(err);
          if (frames.length > 0) o.onProgress?.({ type: 'frames', frames });
        }
        o.onTrace?.(failedTrace(startedAt, d.now().getTime(), err));
        return { captures: fetchFailed(err, what, tripId, d.log, { doc, ...(o.fallsBack ? { fallsBack: true } : {}), ...(o.about ? { about: o.about } : {}) }).filter((c) => c.match !== doc), finalUrl: url };
      }
    }
  }

  /**
   * The page as ixigo drew it, for the live card. ixigo draws its list about 2 s after its data, after Bash has answered
   * (the 8 Oct probe), so the answer's pictures are its skeleton: one more picture of the kept tab, LOOK_AFTER_MS on. A
   * screenshot of the tab, not a page load: the tab is taken for one tiny call inside it and kept again as the warm tab.
   * Only a picture of the same page is told, timed from the page's fetch; a look that fails, or finds the tab taken or on
   * another page (a later search kept its own), tells nothing, and the card keeps the picture it has. Never awaited.
   */
  function look(tripId: string, pageUrl: string, fetchStarted: number, onProgress: OnProgress, tag: string | undefined, stage = false): void {
    const body = {
      steps: [LOOK_STEP], timeout_ms: LOOK_TIMEOUT_MS, frames: { width: FRAME_WIDTH, settle_ms: LOOK_SETTLE_MS }, ...(tag ? { tag } : {}),
      // The stage's page, looked at where it is, and left there.
      ...(stage ? { stage: true, tab: STAGE_TAB, keep_open_ms: STAGE_MS } : { keep_open_ms: WARM_TAB_MS }),
    };
    void sleep(LOOK_AFTER_MS)
      .then(() => inSlot(tripId, {}, async () => {
        const lookStarted = d.now().getTime();
        const answer = await d.v1.call<FetchAnswer>('POST', `/v1/users/${await d.browser.userFor(tripId)}/browser/fetch`, { body });
        const frames = (Array.isArray(answer.frames) ? answer.frames.filter(isFrame) : [])
          .filter((f) => f.page_url === pageUrl)
          .map((f) => ({ ...f, at_ms: lookStarted - fetchStarted + f.at_ms }));
        if (frames.length > 0) onProgress({ type: 'drawn', frames });
      }))
      .catch((err: unknown) => d.log.warn({ tripId, err: String(err instanceof Error ? err.message : err).slice(0, 200) }, 'travel: a look at the drawn page found nothing'));
  }

  /** Until when page calls are skipped: Bash said it can't make them. */
  let unsupportedUntil = 0;
  const unsupported = (): TravelError => {
    unsupportedUntil = d.now().getTime() + FAST_UNSUPPORTED_MS;
    return new TravelError('unreachable', "fast unavailable: Bash's answer had no page call");
  };

  /** One page call from the warm tab; with none kept, the same call on a tab opened at ixigo's home. */
  async function pageFetch(tripId: string, call: PageCall, o: Omit<ReadOptions, 'onProgress'>): Promise<Capture> {
    if (d.now().getTime() < unsupportedUntil) throw new TravelError('unreachable', 'fast unavailable: this Bash takes no page calls');
    const step = { op: 'page_fetch', url: call.url, method: call.method, ...(call.headers ? { headers: call.headers } : {}), ...(call.body ? { body: call.body } : {}), capture_as: 'fast', max_bytes: 1_000_000 };
    // Never asked again on browser_busy: a page call is for speed, so a busy one fails at once and the run falls to the
    // page, which waits its turn.
    const userId = await d.browser.userFor(tripId);
    const ask = (open: boolean) =>
      d.v1.call<FetchAnswer>('POST', `/v1/users/${userId}/browser/fetch`, {
        body: { ...(open ? { url: `${IXIGO}/` } : {}), steps: [step], keep_open_ms: WARM_TAB_MS, timeout_ms: FAST_TIMEOUT_MS, ...(o.tag ? { tag: o.tag } : {}) },
        ...(o.signal ? { signal: o.signal } : {}),
      });
    let answer: FetchAnswer;
    let startedAt = d.now().getTime();
    try {
      answer = await ask(false);
    } catch (err) {
      if (!(err instanceof V1Error) || !(err.status === 409 && err.code === 'no_open_tab')) {
        o.onTrace?.(failedTrace(startedAt, d.now().getTime(), err));
        // A request this Bash doesn't take: no page call is tried again for a while.
        if (err instanceof V1Error && err.status === 400) unsupportedUntil = d.now().getTime() + FAST_UNSUPPORTED_MS;
        throw pageCallFailed(err);
      }
      startedAt = d.now().getTime();
      try {
        answer = await ask(true);
      } catch (again) {
        o.onTrace?.(failedTrace(startedAt, d.now().getTime(), again));
        if (again instanceof V1Error && again.status === 400) unsupportedUntil = d.now().getTime() + FAST_UNSUPPORTED_MS;
        throw pageCallFailed(again);
      }
    }
    // A Bash whose answer has no page call in it (one without page_fetch, or a shape Go doesn't know): fast is unavailable.
    if (!Array.isArray(answer.captures)) throw unsupported();
    const got = answer.captures.find((c) => c.match === 'fast');
    // The call's own time is when its answer was in, from when Bash had the ask: the tab was already open.
    o.onTrace?.({
      started_at: startedAt, elapsed_ms: answer.elapsed_ms, woke: answer.woke, timings: answer.timings ?? null,
      calls: got ? [{ method: call.method, url: got.url || call.url, status: got.status, at_ms: got.at_ms, ms: got.at_ms }] : [],
      ...(got ? {} : { failed: { status: 0, why: 'no answer to the page call' } }),
    });
    if (!got || got.status < 200 || got.status >= 300 || got.truncated) throw new TravelError('unreachable', `ixigo's page call answered ${got ? got.status : 'nothing'}.`);
    warm.add(userId);
    return got;
  }

  /** COLD_COMPUTER's prime: ixigo's home on the trip's computer, its popup closed, and one call from inside the page. */
  async function prime(tripId: string): Promise<void> {
    const userId = await d.browser.userFor(tripId);
    // The person's browser serves all of their trips: one Go has read ixigo on already needs no first visit.
    if (warm.has(userId)) return;
    const body = {
      url: `${IXIGO}/`,
      steps: [{ op: 'click', name: 'Close modal', optional: true }, { op: 'page_fetch', url: '/', method: 'GET', capture_as: 'prime', max_bytes: 1_000 }],
      timeout_ms: PRIME_TIMEOUT_MS,
    };
    // A refusal or a timeout throws as Bash says it: setup tries again, and the first search still has its one retry.
    const answer = await d.v1.call<FetchAnswer>('POST', `/v1/users/${userId}/browser/fetch`, { body });
    if (!Array.isArray(answer.captures) || !answer.captures.some((c) => c.match === 'prime')) {
      throw new TravelError('unreachable', "ixigo's page did not answer on the trip's computer.");
    }
    warm.add(userId);
  }

  async function handOff(
    tripId: string, url: string, plan: FetchPlan, o: { keepOpenMs: number; tab: string; check?: PageCall; device?: 'desktop' },
  ): Promise<{ captures: Capture[]; challenged?: true; device?: 'phone' | 'desktop' }> {
    // The check first, from inside the page as soon as it is there (one byte, its status), then the plan's own steps.
    const check = o.check ? [{ op: 'page_fetch', url: o.check.url, method: o.check.method, capture_as: 'check', max_bytes: 1 }] : [];
    const steps = [...check, ...(plan.steps ?? [])];
    const doc = pageDoc(url);
    let body = {
      url,
      capture: [
        ...plan.capture.map((c) => ({ match: c.match, ...(plan.graceMs ? { required: c.required } : {}), ...(c.max_bytes ? { max_bytes: c.max_bytes } : {}) })),
        docCapture(doc),
      ],
      ...(steps.length ? { steps } : {}),
      timeout_ms: plan.timeoutMs ?? FETCH_TIMEOUT_MS,
      ...(plan.graceMs ? { grace_ms: plan.graceMs } : {}),
      front: true,
      // The site's desktop page (Bash's front_device): a login made on its phone page is its phone client's, which its
      // desktop pages, where every other fetch reads, refused within the hour (ixigo, staging 10 Oct).
      ...(o.device === 'desktop' && d.now().getTime() >= noDesktopUntil ? { front_device: 'desktop' as const } : {}),
      keep_open_ms: o.keepOpenMs,
      tab: o.tab,
    };
    const pageMs = body.timeout_ms;
    const started = d.now().getTime();
    let inUse = 0;
    for (let checks = 0; ; checks++) {
      let captures: Capture[];
      let turnstile = false;
      try {
        const answer = await d.v1.call<FetchAnswer>('POST', `/v1/users/${await d.browser.userFor(tripId)}/browser/fetch`, { body });
        captures = Array.isArray(answer.captures) ? answer.captures : [];
      } catch (err) {
        // A Bash that predates front_device refuses it before it opens anything: an unknown key at the body's top has no
        // param (its path is the body's), so any 400 invalid_request with none, or one at front_device, while it is sent
        // is taken as that (another refusal comes back again without it, and is thrown then). The phone page, as before,
        // and none asked for a while.
        const param = err instanceof V1Error ? String(err.detail?.['param'] ?? '') : '';
        if (err instanceof V1Error && err.status === 400 && err.code === 'invalid_request' && 'front_device' in body && (param === '' || param.startsWith('front_device'))) {
          noDesktopUntil = d.now().getTime() + LOOK_UNSUPPORTED_MS;
          body = Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'front_device')) as typeof body;
          checks -= 1;
          d.log.warn({ tripId, tab: o.tab }, "travel: this Bash takes no desktop hand-off yet; the phone page opens");
          continue;
        }
        // The person is still typing on Watch (Bash's 4 s window): "I'm logged in" tapped right after the code waits it out.
        if (err instanceof V1Error && err.status === 409 && err.code === 'browser_in_use' && inUse < HANDOFF_IN_USE_TRIES) {
          inUse += 1;
          checks -= 1;
          await sleep(IN_USE_WAIT_MS);
          continue;
        }
        // Bash keeps a timed-out tab: the page is in front for the person, with what it caught.
        if (!(err instanceof V1Error) || err.status !== 504) throw pageCallFailed(err);
        captures = partialCaptures(err);
        turnstile = turnstiled(err);
      }
      if (!challenged(captures, url) && !turnstile) {
        // Which page opened, said to a caller that asked for one (a Bash without front_device opens the phone page).
        return { captures: captures.filter((c) => c.match !== doc), ...(o.device ? { device: 'front_device' in body ? 'desktop' as const : 'phone' as const } : {}) };
      }
      metCheck(tripId);
      // CLOUDFLARE: never handed to the person. Opened again after a wait, a new page in front, with the time left for
      // it; still on it when no load fits, the caller closes it and says so.
      const next = nextLoadMs(pageMs, started, d.now().getTime(), checks);
      if (next === null) {
        d.log.warn({ tripId, tab: o.tab, loads: checks + 1 }, "travel: a hand-off's page stayed on Cloudflare's check");
        return { captures: [], challenged: true };
      }
      d.log.warn({ tripId, tab: o.tab, again: checks + 1, ms: next }, "travel: a hand-off's page was Cloudflare's check; opening it again");
      await sleep(CHALLENGE_WAIT_MS);
      body = { ...body, timeout_ms: next };
    }
  }

  /** A fetch with no url on the hand-off's tab and no keep: one call from inside its page, then the tab closes. */
  async function release(tripId: string, tab: string): Promise<void> {
    try {
      await d.v1.call<FetchAnswer>('POST', `/v1/users/${await d.browser.userFor(tripId)}/browser/fetch`, {
        body: { tab, steps: [{ op: 'page_fetch', url: '/', method: 'GET', capture_as: 'close', max_bytes: 1 }], timeout_ms: FAST_TIMEOUT_MS },
      });
    } catch (err) {
      // Its time ran out, or Chrome restarted: no tab is kept under that name, and nothing is left to close.
      if (err instanceof V1Error && err.status === 409 && err.code === 'no_open_tab') return;
      throw pageCallFailed(err);
    }
  }

  async function onStage(tripId: string, plan: FetchPlan, o: ReadOptions): Promise<{ captures: Capture[]; finalUrl: string }> {
    const body = {
      tab: STAGE_TAB,
      stage: true,
      keep_open_ms: STAGE_MS,
      capture: plan.capture.map((c) => ({
        match: c.match,
        ...(plan.graceMs ? { required: c.required } : c.besides ? { required: false } : {}),
        ...(c.max_bytes ? { max_bytes: c.max_bytes } : {}),
        ...(c.min_count ? { min_count: c.min_count } : {}),
        ...(c.max_count ? { max_count: c.max_count } : {}),
      })),
      steps: plan.steps ?? [],
      timeout_ms: plan.timeoutMs ?? FETCH_TIMEOUT_MS,
      ...(plan.graceMs ? { grace_ms: plan.graceMs } : {}),
      frames: { width: FRAME_WIDTH, ...(plan.settleMs ? { settle_ms: plan.settleMs } : {}) },
      ...(o.tag ? { tag: o.tag } : {}),
    };
    try {
      const userId = await d.browser.userFor(tripId);
      const answer = await patient(() => d.v1.call<FetchAnswer>('POST', `/v1/users/${userId}/browser/fetch`, { body, ...(o.signal ? { signal: o.signal } : {}) }), o.signal);
      if (Array.isArray(answer.frames) && answer.frames.length > 0) o.onProgress?.({ type: 'frames', frames: answer.frames });
      return { captures: answer.captures, finalUrl: typeof answer.final_url === 'string' ? answer.final_url : '' };
    } catch (err) {
      if (err instanceof V1Error && err.status === 409 && err.code === 'no_open_tab') throw new TravelError('unreachable', 'The stage has no page open.');
      throw err instanceof V1Error ? new TravelError('unreachable', `The stage's step did not answer (${err.status}).`) : err;
    }
  }

  async function tabSteps(tripId: string, tab: string, steps: Step[], o: { keepOpenMs: number; timeoutMs: number }): Promise<void> {
    // A fetch is its steps and a call: one byte of the home page closes it.
    const done = { op: 'page_fetch', url: '/', method: 'GET', capture_as: 'steps_done', max_bytes: 1 };
    try {
      await d.v1.call<FetchAnswer>('POST', `/v1/users/${await d.browser.userFor(tripId)}/browser/fetch`, {
        body: { tab, steps: [...steps, done], front: true, keep_open_ms: o.keepOpenMs, timeout_ms: o.timeoutMs },
      });
    } catch (err) {
      if (err instanceof V1Error && (err.status === 504 || (err.status === 409 && err.code === 'no_open_tab'))) return;
      throw pageCallFailed(err);
    }
  }

  async function tabCall(tripId: string, tab: string, call: PageCall, keepOpenMs: number): Promise<Capture | null> {
    const step = { op: 'page_fetch', url: call.url, method: call.method, ...(call.headers ? { headers: call.headers } : {}), ...(call.body ? { body: call.body } : {}), capture_as: 'tab_call', max_bytes: 1 };
    try {
      const answer = await d.v1.call<FetchAnswer>('POST', `/v1/users/${await d.browser.userFor(tripId)}/browser/fetch`, {
        body: { tab, steps: [step], keep_open_ms: keepOpenMs, timeout_ms: FAST_TIMEOUT_MS },
      });
      return (Array.isArray(answer.captures) ? answer.captures : []).find((c) => c.match === 'tab_call') ?? null;
    } catch (err) {
      if (err instanceof V1Error && err.status === 409 && err.code === 'no_open_tab') return null;
      throw pageCallFailed(err);
    }
  }

  return {
    name: 'browser_fetch',
    async read(tripId, url, plan, o = {}) {
      return inSlot(tripId, o, () => fetchPage(tripId, url, plan, { id: new URL(url).pathname, capture: plan.capture }, o));
    },
    pageFetch: (tripId, call, o = {}) => inSlot(tripId, o, () => pageFetch(tripId, call, o)),
    canPageFetch: () => d.now().getTime() >= unsupportedUntil,
    prime: (tripId) => inSlot(tripId, {}, () => prime(tripId)),
    handOff: (tripId, url, plan, o) => inSlot(tripId, {}, () => handOff(tripId, url, plan, o)),
    release: (tripId, tab) => inSlot(tripId, {}, () => release(tripId, tab)),
    tabCall: (tripId, tab, call, keepOpenMs) => inSlot(tripId, {}, () => tabCall(tripId, tab, call, keepOpenMs)),
    tabSteps: (tripId, tab, steps, o) => inSlot(tripId, {}, () => tabSteps(tripId, tab, steps, o)),
    lastChallenge: (tripId) => checkedAt.get(tripId) ?? null,
    onStage: (tripId, plan, o = {}) => inSlot(tripId, o, () => onStage(tripId, plan, o)),
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

/**
 * A page call that failed, as a TravelError: the run then falls to the page speed. Bash's own status and code name it
 * ("fast unavailable: Bash answered 400 invalid_request" from a Bash without page_fetch), never its message, which may
 * be a schema's ("Invalid input: expected string, received undefined").
 */
function pageCallFailed(err: unknown): TravelError {
  if (err instanceof TravelError) return err;
  if (err instanceof V1Error) {
    if (err.status === 402) return new TravelError('refused', OUT_OF_CREDIT);
    return new TravelError('unreachable', `fast unavailable: Bash answered ${err.status} ${err.code}`);
  }
  return new TravelError('unreachable', `fast unavailable: ${String(err).slice(0, 160)}`);
}
