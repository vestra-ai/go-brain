/**
 * Two ways to run a recipe in the trip's own browser. The browser fetch is Bash's model-free call: the page opens in a
 * background tab and the page's own data calls come back, in 3 to 8 s. The agent job is the fallback: a /v1 job on the
 * go-recipe deployment opens the page and runs the recipe's page script, in 25 to 55 s, so nothing waits on it inline.
 * The TRAVEL_RUNNER switch picks one on every search. Either way, what comes back goes through the recipe's checks, and
 * the run reports its steps (onProgress) for the live search card.
 */
import { createHash } from 'node:crypto';
import type { Switches } from '../../admin/switches.js';
import { V1Error, type V1Client } from '../../tasks/v1-client.js';
import { TravelError } from '../mcp-travel.js';
import type { LiveFrame, OnProgress } from './progress.js';
import { AGENT_MAX_ROWS, bodiesFor, snapshotText, type Capture, type CaptureSpec, type FetchPlan, type Recipe, type RecipeOption } from './recipe.js';

export interface RecipeRun {
  options: RecipeOption[];
  /** When the page was read. */
  checkedAt: string;
  ms: number;
}

export interface RecipeRunner {
  name: 'browser_fetch' | 'agent_job';
  /** onProgress: the run's steps, for the live search card; called, never awaited. */
  run<S>(tripId: string, recipe: Recipe<S>, slots: S, o?: { signal?: AbortSignal; onProgress?: OnProgress }): Promise<RecipeRun>;
  /** Opens a page, works its steps and brings back the calls the plan keeps, and the address the page ended on: ixigo's
   *  own search box, or a recipe's page. Only the browser fetch can; the agent job reads results pages alone. */
  read?(tripId: string, url: string, plan: FetchPlan, o?: { signal?: AbortSignal; onProgress?: OnProgress }): Promise<{ captures: Capture[]; finalUrl: string }>;
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

interface FetchAnswer { final_url: string; elapsed_ms: number; woke: boolean; captures: Capture[]; frames?: LiveFrame[] }

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
function fetchFailed(err: V1Error, recipe: { id: string; capture: CaptureSpec[] }, tripId: string, log: RunnerDeps['log']): Capture[] {
  if (err.status === 504) {
    const partial = (err.detail?.['partial'] as { captures?: unknown } | undefined)?.captures;
    const got = Array.isArray(partial) ? partial.filter(isCapture).map((c) => ({ ...c, truncated: c.truncated === true })) : [];
    if (recipe.capture.every((c) => !c.required || bodiesFor(got, c.match).length > 0)) return got;
    throw new TravelError('unreachable', 'ixigo took too long to answer. Try again in a moment.');
  }
  if (err.status === 402) throw new TravelError('refused', OUT_OF_CREDIT);
  if (err.status === 409) throw new TravelError('unreachable', "Someone is using the trip's computer's browser. Try again in a moment.");
  if (err.status === 503) throw new TravelError('unreachable', "The trip's computer did not wake up in time. Try again in a moment.");
  if (err.status === 400 || err.status === 403) {
    // Go's own setup or request is wrong (ixigo.com not allowed, a bad recipe): the admin log says so, the room hears less.
    log.warn({ tripId, recipe: recipe.id, code: err.code, message: err.message }, 'travel: the browser fetch refused a recipe');
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
    o: { signal?: AbortSignal; onProgress?: OnProgress },
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
      try {
        const answer = await d.v1.call<FetchAnswer>('POST', `/v1/users/${userId}/browser/fetch`, { body, ...(o.signal ? { signal: o.signal } : {}) });
        // Pictures of the page come when Bash sends them; until then the card shows its steps alone.
        if (Array.isArray(answer.frames) && answer.frames.length > 0) o.onProgress?.({ type: 'frames', frames: answer.frames });
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
        return { captures: fetchFailed(err, what, tripId, d.log), finalUrl: url };
      }
    }
  }

  return {
    name: 'browser_fetch',
    async run(tripId, recipe, slots, o = {}) {
      const started = d.now().getTime();
      const url = recipe.url(slots);
      o.onProgress?.({ type: 'opening', recipeId: recipe.id, url });
      const plan: FetchPlan = recipe.fetchFor?.(slots) ?? { capture: recipe.capture, ...(recipe.steps ? { steps: recipe.steps } : {}) };
      const { captures } = await fetchPage(tripId, url, plan, recipe, o);
      o.onProgress?.({ type: 'captured', ms: d.now().getTime() - started });
      const options = recipe.extract(captures, slots);
      const at = d.now();
      return { options, checkedAt: at.toISOString(), ms: at.getTime() - started };
    },
    async read(tripId, url, plan, o = {}) {
      return fetchPage(tripId, url, plan, { id: `page ${new URL(url).pathname}`, capture: plan.capture }, o);
    },
  };
}

// ── the agent job (the fallback) ─────────────────────────────────────────────

/** computer_snapshot answers up to 15,000 characters before it pages to a file. */
const SNAPSHOT_MAX_CHARS = 16_000;

/** /v1 allows about 60 calls a minute a key: one look a second, for one job, leaves room for everything else. */
export const AGENT_POLL_MS = 1_000;
/** A job took 25 to 53 s on staging; past this it is stopped. Nothing waits on it inline (the search tool goes on). */
export const AGENT_WAIT_MS = 90_000;

/** What the job returns: the script's rows, or, when computer_eval was held or refused, a snapshot's text to read in Go. */
const ROWS_SCHEMA = {
  type: 'object',
  properties: {
    rows: { type: 'array', items: { type: 'object' }, maxItems: AGENT_MAX_ROWS },
    snapshot: { type: 'string', maxLength: SNAPSHOT_MAX_CHARS },
  },
  additionalProperties: false,
};

interface Turn { id: string; work?: Array<{ task_id: string }> }
/** One line of a conversation, as GET /v1/conversations/{id}/messages lists them: the work is on Bash's line of the turn. */
interface Line { turn_id: string; work?: Array<{ task_id: string }> }
interface Task { status: 'queued' | 'working' | 'waiting' | 'done' | 'failed'; result?: { data?: unknown } | null }

/** The job's one message: the page, the text that shows its results are in, and the script, exactly as Go wrote them. */
export const recipeMessage = (url: string, readyText: string, script: string): string =>
  `Open this page with computer_navigate:\n${url}\n\n` +
  `Then call computer_wait with the text ${JSON.stringify(readyText)} and timeoutMs 15000, so the results are on the page.\n\n` +
  'Then call computer_eval with this script as its `expression` argument, exactly as written, and return what it returns as rows:\n\n' +
  `${script}\n\n` +
  'If computer_eval is refused, or waits for a person to allow it, call computer_snapshot with full set to true instead, and return ' +
  'what it shows, exactly as it shows it, as snapshot (and no rows).';

export function createAgentJobRunner(d: RunnerDeps & { deploymentId: string | null }): RecipeRunner {
  const sleep = d.sleep ?? nap;
  async function runJob<S>(tripId: string, recipe: Recipe<S>, slots: S, o: { signal?: AbortSignal; onProgress?: OnProgress }): Promise<RecipeRun> {
    if (!d.deploymentId) throw new TravelError('refused', 'The fallback travel search is not set up yet (VESTRA_RECIPE_DEPLOYMENT_ID).');
    const started = d.now().getTime();
    const userId = await d.computer.ensureUser(tripId);
    const url = recipe.url(slots);
    o.onProgress?.({ type: 'opening', recipeId: recipe.id, url });
    // One job per search: a resend of the same start finds the same conversation and message.
    const run = createHash('sha256').update(`${tripId}|${url}|${started}`).digest('hex').slice(0, 24);
    const metadata = { go_trip_id: tripId, go_recipe: recipe.id };
    const conversation = await d.v1.call<{ id: string }>('POST', '/v1/conversations', {
      idempotencyKey: `go-recipe-conv-${run}`,
      body: { user_id: userId, deployment: d.deploymentId, metadata },
    });
    const turn = await d.v1.call<Turn>('POST', `/v1/conversations/${conversation.id}/messages`, {
      idempotencyKey: `go-recipe-msg-${run}`,
      body: { message: recipeMessage(url, recipe.readyText, recipe.agentExtractor), output_schema: ROWS_SCHEMA, hand_off: 'always', metadata },
    });
    let taskId = turn.work?.[0]?.task_id ?? null;
    // The conversation is this search's alone, so stopping it stops its job, whether or not Go has learnt the job's id yet.
    const stop = async (why: string): Promise<void> => {
      try {
        const r = await d.v1.call<{ stopped_work?: string[] }>('POST', `/v1/conversations/${conversation.id}/stop`, { idempotencyKey: `go-recipe-stop-${run}` });
        d.log.warn({ tripId, recipe: recipe.id, conversationId: conversation.id, stopped: r?.stopped_work ?? [] }, `travel: stopped a recipe job (${why})`);
      } catch (err) {
        d.log.warn({ err, tripId, recipe: recipe.id, conversationId: conversation.id }, `travel: stopping a recipe job (${why}) failed`);
      }
    };
    let data: unknown;
    for (;;) {
      if (o.signal?.aborted) {
        await stop('called off');
        throw new TravelError('unreachable', 'The search was called off.');
      }
      if (d.now().getTime() - started >= AGENT_WAIT_MS) {
        await stop('too slow');
        throw new TravelError('unreachable', 'ixigo took too long to answer. Try again in a moment.');
      }
      await sleep(AGENT_POLL_MS);
      if (!taskId) {
        const lines = await d.v1.call<{ data: Line[] }>('GET', `/v1/conversations/${conversation.id}/messages`);
        taskId = lines.data.find((l) => l.turn_id === turn.id && (l.work?.length ?? 0) > 0)?.work?.[0]?.task_id ?? null;
        continue;
      }
      const task = await d.v1.call<Task>('GET', `/v1/tasks/${taskId}`);
      if (task.status === 'done') {
        data = task.result?.data;
        break;
      }
      if (task.status === 'failed') throw new TravelError('refused', "The trip's computer could not read ixigo's page.");
      // It waits on an approval or a question: a page read never needs one, so it is stopped, not left waiting.
      if (task.status === 'waiting') {
        await stop('it stopped to ask');
        throw new TravelError('refused', "The trip's computer stopped to ask something while reading ixigo's page.");
      }
    }
    o.onProgress?.({ type: 'captured', ms: d.now().getTime() - started });
    const out = data as { rows?: unknown; snapshot?: unknown } | null | undefined;
    // The script's rows; else the snapshot's text, read by the recipe's own reader. Either way the rows are checked.
    const rows = out?.rows === undefined && typeof out?.snapshot === 'string' ? recipe.readPage(snapshotText(out.snapshot), []).slice(0, AGENT_MAX_ROWS) : out?.rows;
    const options = recipe.fromAgent(rows, slots);
    const at = d.now();
    return { options, checkedAt: at.toISOString(), ms: at.getTime() - started };
  }

  return {
    name: 'agent_job',
    async run(tripId, recipe, slots, o = {}) {
      try {
        return await runJob(tripId, recipe, slots, o);
      } catch (err) {
        if (!(err instanceof V1Error)) throw err;
        throw err.status === 402 ? new TravelError('refused', OUT_OF_CREDIT) : new TravelError('unreachable', err.message.slice(0, 200));
      }
    },
  };
}

/** The runner the TRAVEL_RUNNER switch names now. */
export function runnerFor(switches: Pick<Switches, 'get'>, runners: { browserFetch: RecipeRunner; agentJob: RecipeRunner }): RecipeRunner {
  return switches.get('TRAVEL_RUNNER') === 'browser_fetch' ? runners.browserFetch : runners.agentJob;
}

