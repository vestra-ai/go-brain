import { describe, expect, it, vi } from 'vitest';
import { V1Error } from '../../../tasks/v1-client.js';
import { TravelError } from '../../mcp-travel.js';
import type { RecipeProgress } from '../progress.js';
import type { FetchPlan } from '../recipe.js';
import { createBrowserFetchRunner, FETCH_TIMEOUT_MS, IN_USE_WAIT_MS, OUT_OF_CREDIT } from '../runners.js';
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
});
