import { describe, expect, it, vi } from 'vitest';
import { V1Error } from '../../../tasks/v1-client.js';
import { TravelError } from '../../mcp-travel.js';
import { buses, readBusesPage } from '../buses.js';
import { flights } from '../flights.js';
import { trains } from '../trains.js';
import {
  AGENT_POLL_MS, AGENT_WAIT_MS, createAgentJobRunner, createBrowserFetchRunner, FETCH_TIMEOUT_MS, IN_USE_WAIT_MS, OUT_OF_CREDIT, recipeMessage, runnerFor,
  type RecipeRunner,
} from '../runners.js';
import type { RecipeProgress } from '../progress.js';
import { capture, fixture } from './fixtures.js';

type Call = { method: string; path: string; opts: Record<string, unknown> };

function world(handler: (c: Call, n: number) => unknown) {
  let nowMs = Date.parse('2026-11-01T10:00:00Z');
  const calls: Call[] = [];
  const v1 = {
    async call<T>(method: string, path: string, opts: Record<string, unknown> = {}): Promise<T> {
      const c = { method, path, opts };
      calls.push(c);
      return (await handler(c, calls.length)) as T;
    },
  };
  const computer = { userIdFor: (t: string) => `u-${t}`, ensureUser: vi.fn(async (t: string) => `u2-${t}`) };
  const log = { warn: vi.fn() };
  const deps = { v1, computer, log, now: () => new Date(nowMs), sleep: async (ms: number) => { nowMs += ms; } };
  return { calls, computer, log, deps };
}

const busSlots = buses.slotsFrom({ from: 'Mumbai', to: 'Goa', date: '2026-11-06' }, { people: 4 });
const busCapture = capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services', fixture('buses-mumbai-goa.json'));
const fetched = (captures: unknown[]) => ({ final_url: 'https://www.ixigo.com/x', elapsed_ms: 2300, woke: false, captures });
const fails = async (p: Promise<unknown>, code: TravelError['code'], words: RegExp): Promise<void> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(TravelError);
  expect((err as TravelError).code).toBe(code);
  expect((err as TravelError).message).toMatch(words);
};

describe('the browser fetch runner', () => {
  it("opens the page in the trip's browser with the recipe's captures, and reads the options from what came back", async () => {
    const w = world(() => fetched([busCapture]));
    const r = await createBrowserFetchRunner(w.deps).run('t1', buses, busSlots);
    expect(w.calls).toEqual([{
      method: 'POST',
      path: '/v1/users/u-t1/browser/fetch',
      opts: { body: { url: 'https://www.ixigo.com/buses/bus_search/Mumbai/4/Goa/102/06-11-2026/O', capture: [{ match: '/buslist/v3/services$' }], timeout_ms: FETCH_TIMEOUT_MS } },
    }]);
    expect(r.options).toHaveLength(71);
    expect(r).toMatchObject({ checkedAt: '2026-11-01T10:00:00.000Z', ms: 0 });
  });

  it("sends a capture's size limit, and never Go's own required flag", async () => {
    const w = world(() => fetched([]));
    await createBrowserFetchRunner(w.deps).run('t1', flights, flights.slotsFrom({ from: 'DEL', to: 'GOI', date: '2026-11-06' }, { people: 4 })).catch(() => undefined);
    expect((w.calls[0]!.opts['body'] as { capture: unknown }).capture).toEqual([{ match: '/flights/v2/search/stream', max_bytes: 2_000_000 }]);
  });

  it('makes the trip user when /v1 does not have it, then asks once more', async () => {
    const w = world((_, n) => {
      if (n === 1) throw new V1Error(404, 'user_not_found', 'No such user.');
      return fetched([busCapture]);
    });
    const r = await createBrowserFetchRunner(w.deps).run('t1', buses, busSlots);
    expect(w.computer.ensureUser).toHaveBeenCalledWith('t1');
    expect(w.calls.map((c) => c.path)).toEqual(['/v1/users/u-t1/browser/fetch', '/v1/users/u2-t1/browser/fetch']);
    expect(r.options).toHaveLength(71);
  });

  it('waits once for a person who just used the browser, then gives up', async () => {
    const once = world((_, n) => {
      if (n === 1) throw new V1Error(409, 'browser_in_use', 'A person has the browser.');
      return fetched([busCapture]);
    });
    expect((await createBrowserFetchRunner(once.deps).run('t1', buses, busSlots)).ms).toBe(IN_USE_WAIT_MS);
    const always = world(() => {
      throw new V1Error(409, 'browser_in_use', 'A person has the browser.');
    });
    await fails(createBrowserFetchRunner(always.deps).run('t1', buses, busSlots), 'unreachable', /Someone is using/);
    expect(always.calls).toHaveLength(2);
  });

  it('uses what a timed-out fetch did get when every required call is in it', async () => {
    const trainSlots = trains.slotsFrom({ from: 'Delhi', to: 'Goa', date: '2026-11-06' }, { people: 4 });
    const between = capture('/trains/v1/search/between/', 'https://www.ixigo.com/trains/v1/search/between/NDLS/MAO?date=2026-11-06', fixture('trains-ndls-mao-between.json'));
    const timedOut = (captures: unknown[]) => new V1Error(504, 'timeout', 'The fetch timed out.', null, { code: 'timeout', partial: { final_url: 'x', elapsed_ms: 8000, woke: true, captures } });
    const got = world(() => {
      throw timedOut([between]);
    });
    const r = await createBrowserFetchRunner(got.deps).run('t1', trains, trainSlots);
    expect(r.options).toHaveLength(25);
    expect(r.options[0]!.facts).not.toHaveProperty('availability');
    const missing = world(() => {
      throw timedOut([]);
    });
    await fails(createBrowserFetchRunner(missing.deps).run('t1', trains, trainSlots), 'unreachable', /took too long/);
  });

  it("says plainly what went wrong, and puts Go's own setup faults in the admin log", async () => {
    const said = async (err: V1Error) => {
      const w = world(() => {
        throw err;
      });
      const p = createBrowserFetchRunner(w.deps).run('t1', buses, busSlots);
      return { w, err: (await p.then(() => null, (e: unknown) => e)) as TravelError };
    };
    expect((await said(new V1Error(402, 'wallet_empty', 'Empty.'))).err).toMatchObject({ code: 'refused', message: OUT_OF_CREDIT });
    expect((await said(new V1Error(503, 'box_unavailable', 'Asleep.'))).err).toMatchObject({ code: 'unreachable' });
    const blocked = await said(new V1Error(403, 'domain_not_allowed', 'ixigo.com is not allowed.'));
    expect(blocked.err).toMatchObject({ code: 'refused', message: "The trip's computer is not allowed on ixigo.com yet." });
    expect(blocked.w.log.warn).toHaveBeenCalledWith(expect.objectContaining({ tripId: 't1', recipe: 'ixigo.buses', code: 'domain_not_allowed' }), expect.any(String));
  });
});

describe('the agent job runner (the fallback)', () => {
  const rows = readBusesPage(fixture('buses-mumbai-goa.txt'));

  it("runs one job on the go-recipe deployment: the page and the script, then the rows it returned, checked", async () => {
    let polls = 0;
    const w = world((c) => {
      if (c.path === '/v1/conversations') return { id: 'conv_1' };
      if (c.path === '/v1/conversations/conv_1/messages') return { id: 'turn_1', work: [{ task_id: 'task_1' }] };
      if (c.path === '/v1/tasks/task_1') return ++polls < 3 ? { status: 'working' } : { status: 'done', result: { text: 'Done.', data: { rows } } };
      throw new Error(`unexpected ${c.method} ${c.path}`);
    });
    const r = await createAgentJobRunner({ ...w.deps, deploymentId: 'dep_recipe' }).run('t1', buses, busSlots);
    expect(w.computer.ensureUser).toHaveBeenCalledWith('t1');
    expect(w.calls[0]!.opts['body']).toEqual({ user_id: 'u2-t1', deployment: 'dep_recipe', metadata: { go_trip_id: 't1', go_recipe: 'ixigo.buses' } });
    const message = w.calls[1]!.opts['body'] as { message: string; output_schema: { properties: { rows: { maxItems: number } } }; hand_off: string };
    expect(message.message).toBe(recipeMessage(buses.url(busSlots), 'Select Seats', buses.agentExtractor));
    // Bash's computer_eval takes the script as `expression`: a model that sends `script` is refused, and retries for 7 s.
    expect(message.message).toContain('computer_eval with this script as its `expression` argument');
    expect(message.message).toContain('computer_wait with the text "Select Seats"');
    expect(message.output_schema.properties.rows.maxItems).toBe(15);
    expect(message.hand_off).toBe('always');
    expect(w.calls[0]!.opts['idempotencyKey']).toMatch(/^go-recipe-conv-/);
    expect(r.options).toHaveLength(16);
    expect(r.ms).toBe(3 * AGENT_POLL_MS);
  });

  it("reads a snapshot's text with the recipe's own reader when the job could not run the script", async () => {
    // As Bash's computer_snapshot shows the page: a link's name holds the whole card, its text nodes the lines.
    const page = fixture('buses-mumbai-goa.txt').split('\n').filter((l) => l.trim().length > 0);
    const snapshot = ['- link "Paulo Travels Express VE AC Sleeper (2 + 1) 18:20 Mumbai 16h.25m 10:45 Goa" [@e3]', ...page.map((l) => `  - StaticText "${l.trim()}"`)].join('\n');
    const w = world((c) => {
      if (c.path === '/v1/conversations') return { id: 'conv_1' };
      if (c.path === '/v1/conversations/conv_1/messages') return { id: 'turn_1', work: [{ task_id: 'task_1' }] };
      return { status: 'done', result: { data: { snapshot } } };
    });
    const r = await createAgentJobRunner({ ...w.deps, deploymentId: 'dep_recipe' }).run('t1', buses, busSlots);
    expect(r.options).toHaveLength(15);
    expect(r.options[0]).toMatchObject({ title: 'Paulo Travels Express', priceMinor: 270_000 });
    const message = (w.calls[1]!.opts['body'] as { message: string }).message;
    expect(message).toContain('call computer_snapshot with full set to true instead');
  });

  it('finds the job on the turn when the first answer did not name it', async () => {
    const w = world((c) => {
      if (c.path === '/v1/conversations') return { id: 'conv_1' };
      if (c.method === 'POST' && c.path === '/v1/conversations/conv_1/messages') return { id: 'turn_1', work: [] };
      // The list holds lines, not turns: the job is on Bash's line of the turn.
      if (c.method === 'GET' && c.path === '/v1/conversations/conv_1/messages') {
        return { data: [{ id: 'msg_1', turn_id: 'turn_1', role: 'user', work: [] }, { id: 'msg_2', turn_id: 'turn_1', role: 'assistant', work: [{ task_id: 'task_1' }] }], next_cursor: null };
      }
      if (c.path === '/v1/tasks/task_1') return { status: 'done', result: { data: { rows } } };
      throw new Error(`unexpected ${c.method} ${c.path}`);
    });
    expect((await createAgentJobRunner({ ...w.deps, deploymentId: 'dep_recipe' }).run('t1', buses, busSlots)).options).toHaveLength(16);
  });

  it('stops a job that is not done in 90 s', async () => {
    const w = world((c) => {
      if (c.path === '/v1/conversations') return { id: 'conv_1' };
      if (c.path === '/v1/conversations/conv_1/messages') return { id: 'turn_1', work: [{ task_id: 'task_1' }] };
      if (c.path === '/v1/tasks/task_1') return { status: 'working' };
      if (c.path === '/v1/conversations/conv_1/stop') return { id: 'conv_1', object: 'conversation.stop', stopped_work: ['task_1'] };
      throw new Error(`unexpected ${c.method} ${c.path}`);
    });
    await fails(createAgentJobRunner({ ...w.deps, deploymentId: 'dep_recipe' }).run('t1', buses, busSlots), 'unreachable', /took too long/);
    // Stopped by its own conversation, so the stop is sent even when the job's id never came.
    expect(w.calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/conversations/conv_1/stop' });
    expect(w.calls.filter((c) => c.path === '/v1/tasks/task_1')).toHaveLength(AGENT_WAIT_MS / AGENT_POLL_MS);
    expect(w.log.warn).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv_1', stopped: ['task_1'] }), expect.stringContaining('too slow'));
  });

  it('fails closed: a failed job, a job that stops to ask, and rows that do not check out give no options', async () => {
    const job = (task: unknown) =>
      world((c) => {
        if (c.path === '/v1/conversations') return { id: 'conv_1' };
        if (c.path === '/v1/conversations/conv_1/messages') return { id: 'turn_1', work: [{ task_id: 'task_1' }] };
        if (c.path === '/v1/tasks/task_1') return task;
        return { stopped: true };
      });
    await fails(createAgentJobRunner({ ...job({ status: 'failed' }).deps, deploymentId: 'dep_recipe' }).run('t1', buses, busSlots), 'refused', /could not read/);
    const asks = job({ status: 'waiting' });
    await fails(createAgentJobRunner({ ...asks.deps, deploymentId: 'dep_recipe' }).run('t1', buses, busSlots), 'refused', /stopped to ask/);
    expect(asks.calls.at(-1)).toMatchObject({ path: '/v1/conversations/conv_1/stop' });
    const bad = job({ status: 'done', result: { data: { rows: [{ operator: 'A bus', price: 'cheap' }] } } });
    await fails(createAgentJobRunner({ ...bad.deps, deploymentId: 'dep_recipe' }).run('t1', buses, busSlots), 'refused', /did not check out/);
    const none = job({ status: 'done', result: { data: null } });
    await fails(createAgentJobRunner({ ...none.deps, deploymentId: 'dep_recipe' }).run('t1', buses, busSlots), 'refused', /did not check out/);
  });

  it('refuses plainly when it is not set up, or the account is out of credit', async () => {
    const unset = world(() => ({}));
    await fails(createAgentJobRunner({ ...unset.deps, deploymentId: null }).run('t1', buses, busSlots), 'refused', /not set up/);
    expect(unset.calls).toEqual([]);
    const broke = world(() => {
      throw new V1Error(402, 'wallet_empty', 'Empty.');
    });
    await fails(createAgentJobRunner({ ...broke.deps, deploymentId: 'dep_recipe' }).run('t1', buses, busSlots), 'refused', /out of credit/);
  });
});

describe('the steps a run reports, for the live search card', () => {
  it('the browser fetch: opening, the pictures when Bash sends them, then captured', async () => {
    const frame = { label: 'results', at_ms: 2100, page_url: 'https://www.ixigo.com/buses/bus_search/Mumbai/4/Goa/102/06-11-2026/O', jpeg_base64: '/9j/4AAQ' };
    const w = world(() => ({ ...fetched([busCapture]), frames: [frame] }));
    const seen: RecipeProgress[] = [];
    await createBrowserFetchRunner(w.deps).run('t1', buses, busSlots, { onProgress: (e) => seen.push(e) });
    expect(seen.map((e) => e.type)).toEqual(['opening', 'frames', 'captured']);
    expect(seen[0]).toEqual({ type: 'opening', recipeId: 'ixigo.buses', url: buses.url(busSlots) });
    expect(seen[1]).toEqual({ type: 'frames', frames: [frame] });
    const none = world(() => fetched([busCapture]));
    const quiet: RecipeProgress[] = [];
    await createBrowserFetchRunner(none.deps).run('t1', buses, busSlots, { onProgress: (e) => quiet.push(e) });
    expect(quiet.map((e) => e.type)).toEqual(['opening', 'captured']);
  });

  it('the agent job: opening, then captured when the job is done', async () => {
    const rows = readBusesPage(fixture('buses-mumbai-goa.txt'));
    const w = world((c) => {
      if (c.path === '/v1/conversations') return { id: 'conv_1' };
      if (c.path === '/v1/conversations/conv_1/messages') return { id: 'turn_1', work: [{ task_id: 'task_1' }] };
      return { status: 'done', result: { data: { rows } } };
    });
    const seen: RecipeProgress[] = [];
    await createAgentJobRunner({ ...w.deps, deploymentId: 'dep_recipe' }).run('t1', buses, busSlots, { onProgress: (e) => seen.push(e) });
    expect(seen).toEqual([{ type: 'opening', recipeId: 'ixigo.buses', url: buses.url(busSlots) }, { type: 'captured', ms: AGENT_POLL_MS }]);
  });
});

describe('runnerFor', () => {
  it('follows the TRAVEL_RUNNER switch, the agent job unless it says browser_fetch', () => {
    const browserFetch = { name: 'browser_fetch' } as RecipeRunner;
    const agentJob = { name: 'agent_job' } as RecipeRunner;
    expect(runnerFor({ get: () => 'browser_fetch' }, { browserFetch, agentJob })).toBe(browserFetch);
    expect(runnerFor({ get: () => 'agent_job' }, { browserFetch, agentJob })).toBe(agentJob);
  });
});
