/**
 * Two ways to run a recipe in the trip's own browser. The browser fetch is Bash's model-free call: the page opens in a
 * background tab and the page's own data calls come back, in about 4 s. The agent job is the fallback until that call is
 * live: a /v1 job on the go-recipe deployment opens the page and runs the recipe's page script, in 12 to 18 s. The
 * TRAVEL_RUNNER switch picks one on every search. Either way, what comes back goes through the recipe's checks.
 */
import { createHash } from 'node:crypto';
import type { Switches } from '../../admin/switches.js';
import { V1Error, type V1Client } from '../../tasks/v1-client.js';
import { TravelError } from '../mcp-travel.js';
import { AGENT_MAX_ROWS, bodiesFor, type Capture, type Recipe, type RecipeOption } from './recipe.js';

export interface RecipeRun {
  options: RecipeOption[];
  /** When the page was read. */
  checkedAt: string;
  ms: number;
}

export interface RecipeRunner {
  name: 'browser_fetch' | 'agent_job';
  run<S>(tripId: string, recipe: Recipe<S>, slots: S, o?: { signal?: AbortSignal }): Promise<RecipeRun>;
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

/** How long Bash may take, the box's wake included. */
export const FETCH_TIMEOUT_MS = 8_000;
/** A person used the browser in the last 4 s: Go waits that out once, then gives up. */
export const IN_USE_WAIT_MS = 4_000;

interface FetchAnswer { final_url: string; elapsed_ms: number; woke: boolean; captures: Capture[] }

const isCapture = (c: unknown): c is Capture =>
  typeof c === 'object' && c !== null && typeof (c as Capture).url === 'string' && typeof (c as Capture).body === 'string' && typeof (c as Capture).status === 'number';

/** A failed fetch as Go says it; on a timeout, the captures it did get when every required one is among them. */
function fetchFailed<S>(err: V1Error, recipe: Recipe<S>, tripId: string, log: RunnerDeps['log']): Capture[] {
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
  return {
    name: 'browser_fetch',
    async run(tripId, recipe, slots, o = {}) {
      const started = d.now().getTime();
      const body = {
        url: recipe.url(slots),
        // required is Go's own: Bash waits for every capture, and Go decides what a timed-out fetch can still answer.
        capture: recipe.capture.map((c) => ({ match: c.match, ...(c.max_bytes ? { max_bytes: c.max_bytes } : {}) })),
        ...(recipe.steps ? { steps: recipe.steps } : {}),
        timeout_ms: FETCH_TIMEOUT_MS,
      };
      const fetchCaptures = async (): Promise<Capture[]> => {
        let userId = d.computer.userIdFor(tripId);
        for (let tries = 0; ; tries++) {
          try {
            const answer = await d.v1.call<FetchAnswer>('POST', `/v1/users/${userId}/browser/fetch`, { body, ...(o.signal ? { signal: o.signal } : {}) });
            return answer.captures;
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
            return fetchFailed(err, recipe, tripId, d.log);
          }
        }
      };
      const options = recipe.extract(await fetchCaptures(), slots);
      const at = d.now();
      return { options, checkedAt: at.toISOString(), ms: at.getTime() - started };
    },
  };
}

// ── the agent job (the fallback) ─────────────────────────────────────────────

export const AGENT_POLL_MS = 500;
export const AGENT_WAIT_MS = 25_000;

const ROWS_SCHEMA = {
  type: 'object',
  properties: { rows: { type: 'array', items: { type: 'object' }, maxItems: AGENT_MAX_ROWS } },
  required: ['rows'],
  additionalProperties: false,
};

interface Turn { id: string; work?: Array<{ task_id: string }> }
interface Task { status: 'queued' | 'working' | 'waiting' | 'done' | 'failed'; result?: { data?: unknown } | null }

/** The job's one message: the page and the script, exactly as Go wrote them. */
export const recipeMessage = (url: string, script: string): string =>
  `Open this page with computer_navigate:\n${url}\n\nThen run this script with computer_eval, exactly as written, and return what it returns as rows:\n\n${script}`;

export function createAgentJobRunner(d: RunnerDeps & { deploymentId: string | null }): RecipeRunner {
  const sleep = d.sleep ?? nap;
  async function runJob<S>(tripId: string, recipe: Recipe<S>, slots: S, o: { signal?: AbortSignal }): Promise<RecipeRun> {
    if (!d.deploymentId) throw new TravelError('refused', 'The fallback travel search is not set up yet (VESTRA_RECIPE_DEPLOYMENT_ID).');
    const started = d.now().getTime();
    const userId = await d.computer.ensureUser(tripId);
    const url = recipe.url(slots);
    // One job per search: a resend of the same start finds the same conversation and message.
    const run = createHash('sha256').update(`${tripId}|${url}|${started}`).digest('hex').slice(0, 24);
    const metadata = { go_trip_id: tripId, go_recipe: recipe.id };
    const conversation = await d.v1.call<{ id: string }>('POST', '/v1/conversations', {
      idempotencyKey: `go-recipe-conv-${run}`,
      body: { user_id: userId, deployment: d.deploymentId, metadata },
    });
    const turn = await d.v1.call<Turn>('POST', `/v1/conversations/${conversation.id}/messages`, {
      idempotencyKey: `go-recipe-msg-${run}`,
      body: { message: recipeMessage(url, recipe.agentExtractor), output_schema: ROWS_SCHEMA, hand_off: 'always', metadata },
    });
    let taskId = turn.work?.[0]?.task_id ?? null;
    const stop = async (): Promise<void> => {
      if (taskId) await d.v1.call('POST', `/v1/tasks/${taskId}/stop`, { idempotencyKey: `go-stop-${taskId}` }).catch(() => undefined);
    };
    let data: unknown;
    for (;;) {
      if (o.signal?.aborted) {
        await stop();
        throw new TravelError('unreachable', 'The search was called off.');
      }
      if (d.now().getTime() - started >= AGENT_WAIT_MS) {
        await stop();
        throw new TravelError('unreachable', 'ixigo took too long to answer. Try again in a moment.');
      }
      await sleep(AGENT_POLL_MS);
      if (!taskId) {
        const turns = await d.v1.call<{ data: Turn[] }>('GET', `/v1/conversations/${conversation.id}/messages`);
        taskId = turns.data.find((t) => t.id === turn.id)?.work?.[0]?.task_id ?? null;
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
        await stop();
        throw new TravelError('refused', "The trip's computer stopped to ask something while reading ixigo's page.");
      }
    }
    const options = recipe.fromAgent((data as { rows?: unknown } | null | undefined)?.rows, slots);
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

