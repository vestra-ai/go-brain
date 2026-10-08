import { describe, expect, it, vi } from 'vitest';
import { V1Error } from '../../../tasks/v1-client.js';
import { TravelError } from '../../mcp-travel.js';
import type { FetchTrace } from '../../runs.js';
import type { RecipeProgress } from '../progress.js';
import type { FetchPlan } from '../recipe.js';
import { createBrowserFetchRunner, FAST_TIMEOUT_MS, FETCH_TIMEOUT_MS, IN_USE_WAIT_MS, OUT_OF_CREDIT, WARM_TAB_MS } from '../runners.js';
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
  return { calls, computer, log, deps, elapsed: () => nowMs - Date.parse('2026-11-01T10:00:00Z') };
}

const BUSES = 'https://www.ixigo.com/buses/bus_search/Mumbai/4/Goa/102/06-11-2026/O';
const busPlan: FetchPlan = { capture: [{ match: '/buslist/v3/services$', required: true }] };
const busCapture = capture('/buslist/v3/services$', 'https://www.ixigo.com/buslist/v3/services', fixture('buses-mumbai-goa.json'));
const fetched = (captures: unknown[], finalUrl = BUSES) => ({ final_url: finalUrl, elapsed_ms: 2300, woke: false, captures });
const fails = async (p: Promise<unknown>, code: TravelError['code'], words: RegExp): Promise<void> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(TravelError);
  expect((err as TravelError).code).toBe(code);
  expect((err as TravelError).message).toMatch(words);
};

describe("the browser fetch: how the recipe engine reads a page in the trip's browser", () => {
  it("opens the page with the plan's captures, steps and pictures, and answers its calls and where the page ended", async () => {
    const SEARCH = '/accommodation-search/api/v3/accommodations/search$';
    const url = 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search';
    const page = 'https://www.ixigo.com/hotels/search/result?locationId=32';
    const w = world(() => fetched([capture(SEARCH, url, fixture('stays-goa-page1.json'))], page));
    const plan: FetchPlan = {
      capture: [{ match: SEARCH, required: true, min_count: 2, max_count: 2, max_bytes: 2_000_000 }],
      steps: [{ op: 'wait_for', match: SEARCH }, { op: 'click', name: 'Close modal', optional: true }, { op: 'scroll', times: 3 }],
      timeoutMs: 12_000,
      settleMs: 550,
    };
    const read = await createBrowserFetchRunner(w.deps).read('t1', page, plan);
    expect(w.calls).toEqual([{
      method: 'POST',
      path: '/v1/users/u-t1/browser/fetch',
      opts: {
        body: {
          url: page,
          // Go's own required flag is never sent: Go decides what a timed-out fetch can still answer.
          capture: [{ match: SEARCH, max_bytes: 2_000_000, min_count: 2, max_count: 2 }],
          steps: plan.steps,
          timeout_ms: 12_000,
          // Bash's last picture once the hotels have drawn (#4585).
          frames: { settle_ms: 550 },
        },
      },
    }]);
    expect(read.captures).toHaveLength(1);
    expect(read.finalUrl).toBe(page);
    // Bash's most, for a sleeping box; it answers as soon as the captures are in. No settle: no settle_ms.
    expect(FETCH_TIMEOUT_MS).toBe(20_000);
    const plain = world(() => fetched([busCapture]));
    await createBrowserFetchRunner(plain.deps).read('t1', BUSES, busPlan);
    expect(plain.calls[0]!.opts['body']).toEqual({ url: BUSES, capture: [{ match: '/buslist/v3/services$' }], timeout_ms: FETCH_TIMEOUT_MS, frames: {} });
  });

  it('answers a timed-out fetch with what it did get when every required call is in it, and shows the pictures it took', async () => {
    const SEARCH = '/accommodation-search/api/v3/accommodations/search$';
    const url = 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search';
    const frame = { label: 'results', at_ms: 6100, page_url: 'https://www.ixigo.com/hotels/search/result?locationId=32', jpeg_base64: '/9j/4AAQ' };
    const timedOut = (captures: unknown[]) => new V1Error(504, 'timeout', 'The fetch timed out.', null, {
      code: 'timeout', partial: { final_url: 'x', elapsed_ms: 12_000, woke: true, captures, frames: [frame, { label: 'broken' }] },
    });
    const got = world(() => {
      throw timedOut([capture(SEARCH, url, fixture('stays-goa-page1.json'))]);
    });
    const seen: RecipeProgress[] = [];
    const plan: FetchPlan = { capture: [{ match: SEARCH, required: true, min_count: 2, max_count: 2 }] };
    const read = await createBrowserFetchRunner(got.deps).read('t1', 'https://www.ixigo.com/hotels/search/result', plan, { onProgress: (e) => seen.push(e) });
    expect(read.captures).toHaveLength(1);
    expect(seen).toEqual([{ type: 'frames', frames: [frame] }]);
    const missing = world(() => {
      throw timedOut([]);
    });
    await fails(createBrowserFetchRunner(missing.deps).read('t1', 'https://www.ixigo.com/hotels/search/result', plan), 'unreachable', /took too long/);
  });

  it("makes a page's own call from the warm tab, keeping it open; with no tab kept, from a tab opened at ixigo's home", async () => {
    const answer = (status = 200) => ({ ...fetched([{ ...capture('fast', 'https://www.ixigo.com/plan/goa', '0:{}'), status }]), final_url: 'https://www.ixigo.com/' });
    const w = world((_, n) => {
      if (n === 1) throw new V1Error(409, 'no_open_tab', 'No tab is kept.');
      return answer();
    });
    const runner = createBrowserFetchRunner(w.deps);
    const got = await runner.pageFetch!('t1', { url: '/plan/goa', method: 'GET', headers: { RSC: '1' } });
    expect(got).toMatchObject({ match: 'fast', status: 200, body: '0:{}' });
    const step = { op: 'page_fetch', url: '/plan/goa', method: 'GET', headers: { RSC: '1' }, capture_as: 'fast', max_bytes: 1_000_000 };
    expect(w.calls.map((c) => c.opts['body'])).toEqual([
      { steps: [step], keep_open_ms: WARM_TAB_MS, timeout_ms: FAST_TIMEOUT_MS },
      { url: 'https://www.ixigo.com/', steps: [step], keep_open_ms: WARM_TAB_MS, timeout_ms: FAST_TIMEOUT_MS },
    ]);
    // ixigo answering the call with an error is a failed call: the run falls to the page.
    const refused = world(() => answer(403));
    await fails(createBrowserFetchRunner(refused.deps).pageFetch!('t1', { url: '/plan/goa', method: 'GET' }), 'unreachable', /answered 403/);
    const blocked = world(() => {
      throw new V1Error(403, 'page_blocked', 'ixigo.com/payments/ is blocked.');
    });
    await fails(createBrowserFetchRunner(blocked.deps).pageFetch!('t1', { url: '/payments/x', method: 'GET' }), 'unreachable', /blocked/);
  });

  it('makes the trip user when /v1 does not have it, then asks once more', async () => {
    const w = world((_, n) => {
      if (n === 1) throw new V1Error(404, 'user_not_found', 'No such user.');
      return fetched([busCapture]);
    });
    const read = await createBrowserFetchRunner(w.deps).read('t1', BUSES, busPlan);
    expect(w.computer.ensureUser).toHaveBeenCalledWith('t1');
    expect(w.calls.map((c) => c.path)).toEqual(['/v1/users/u-t1/browser/fetch', '/v1/users/u2-t1/browser/fetch']);
    expect(read.captures).toHaveLength(1);
  });

  it('waits once for a person who just used the browser, then gives up', async () => {
    const once = world((_, n) => {
      if (n === 1) throw new V1Error(409, 'browser_in_use', 'A person has the browser.');
      return fetched([busCapture]);
    });
    await createBrowserFetchRunner(once.deps).read('t1', BUSES, busPlan);
    expect(once.elapsed()).toBe(IN_USE_WAIT_MS);
    const always = world(() => {
      throw new V1Error(409, 'browser_in_use', 'A person has the browser.');
    });
    await fails(createBrowserFetchRunner(always.deps).read('t1', BUSES, busPlan), 'unreachable', /Someone is using/);
    expect(always.calls).toHaveLength(2);
  });

  it("says plainly what went wrong, and puts Go's own setup faults in the admin log", async () => {
    const said = async (err: V1Error) => {
      const w = world(() => {
        throw err;
      });
      const p = createBrowserFetchRunner(w.deps).read('t1', BUSES, busPlan);
      return { w, err: (await p.then(() => null, (e: unknown) => e)) as TravelError };
    };
    expect((await said(new V1Error(402, 'wallet_empty', 'Empty.'))).err).toMatchObject({ code: 'refused', message: OUT_OF_CREDIT });
    expect((await said(new V1Error(503, 'box_unavailable', 'Asleep.'))).err).toMatchObject({ code: 'unreachable' });
    const blocked = await said(new V1Error(403, 'domain_not_allowed', 'ixigo.com is not allowed.'));
    expect(blocked.err).toMatchObject({ code: 'refused', message: "The trip's computer is not allowed on ixigo.com yet." });
    expect(blocked.w.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tripId: 't1', page: '/buses/bus_search/Mumbai/4/Goa/102/06-11-2026/O', code: 'domain_not_allowed' }),
      expect.any(String),
    );
  });

  it('tells the live view where each call\'s time went: the wake, the page, each kept call; and on a timeout, where it stopped', async () => {
    const timings = { wake_ms: 4_000, nav_ms: 5_200, first_capture_ms: 7_000, done_ms: 7_400 };
    const ok = world(() => ({ ...fetched([busCapture]), woke: true, timings }));
    const traces: FetchTrace[] = [];
    await createBrowserFetchRunner(ok.deps).read('t1', BUSES, busPlan, { onTrace: (t) => traces.push(t) });
    expect(traces).toEqual([{
      speed: 'page', started_at: Date.parse('2026-11-01T10:00:00Z'), elapsed_ms: 2300, woke: true, timings,
      calls: [{ url: busCapture.url, status: busCapture.status, at_ms: busCapture.at_ms }],
    }]);
    const partial = { final_url: BUSES, elapsed_ms: 12_000, woke: false, timings, step: '2 scroll', captures: [busCapture] };
    const late = world(() => {
      throw new V1Error(504, 'timeout', 'The fetch timed out.', null, { code: 'timeout', partial });
    });
    const lateTraces: FetchTrace[] = [];
    await createBrowserFetchRunner(late.deps).read('t1', BUSES, busPlan, { onTrace: (t) => lateTraces.push(t) });
    expect(lateTraces).toEqual([expect.objectContaining({ speed: 'page', elapsed_ms: 12_000, timings, failed: { status: 504, why: 'ran out of time at 2 scroll' } })]);
    expect(lateTraces[0]!.calls).toHaveLength(1);
    const refused = world(() => {
      throw new V1Error(403, 'domain_not_allowed', 'Not allowed.');
    });
    const refusedTraces: FetchTrace[] = [];
    await createBrowserFetchRunner(refused.deps).read('t1', BUSES, busPlan, { onTrace: (t) => refusedTraces.push(t) }).catch(() => undefined);
    expect(refusedTraces).toEqual([expect.objectContaining({ calls: [], failed: { status: 403, why: 'domain_not_allowed' } })]);
  });

  it("tells the live view a page call's own time, and a page call that failed", async () => {
    const fast = { ...capture('fast', '/plan/goa', '{}'), at_ms: 380 };
    const ok = world(() => ({ final_url: 'https://www.ixigo.com/', elapsed_ms: 420, woke: false, captures: [fast] }));
    const traces: FetchTrace[] = [];
    await createBrowserFetchRunner(ok.deps).pageFetch!('t1', { url: '/plan/goa', method: 'GET' }, { onTrace: (t) => traces.push(t) });
    expect(traces).toEqual([expect.objectContaining({ speed: 'fast', elapsed_ms: 420, calls: [{ method: 'GET', url: fast.url, status: fast.status, at_ms: 380, ms: 380 }] })]);
    const down = world(() => {
      throw new V1Error(402, 'out_of_credit', 'No credit.');
    });
    const downTraces: FetchTrace[] = [];
    await createBrowserFetchRunner(down.deps).pageFetch!('t1', { url: '/plan/goa', method: 'GET' }, { onTrace: (t) => downTraces.push(t) }).catch(() => undefined);
    expect(downTraces).toEqual([expect.objectContaining({ speed: 'fast', calls: [], failed: { status: 402, why: 'out_of_credit' } })]);
  });
});
