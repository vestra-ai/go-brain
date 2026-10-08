import { describe, expect, it, vi } from 'vitest';
import { V1Error } from '../../../tasks/v1-client.js';
import { TravelError } from '../../mcp-travel.js';
import type { RecipeProgress } from '../progress.js';
import type { FetchPlan } from '../recipe.js';
import {
  BUSY_TRIES, createBrowserFetchRunner, DEFAULT_SLOTS, FAST_TIMEOUT_MS, FAST_UNSUPPORTED_MS, FETCH_TIMEOUT_MS, FRAME_WIDTH, IN_USE_WAIT_MS, OUT_OF_CREDIT,
  PAYMENT_PAGE_BLOCKED, PRIME_TIMEOUT_MS, WARM_TAB_MS, type FetchTrace,
} from '../runners.js';
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
          // Pictures as wide as the fetch's window, so the try room never stretches one.
          frames: { width: FRAME_WIDTH, settle_ms: 550 },
        },
      },
    }]);
    expect(read.captures).toHaveLength(1);
    expect(read.finalUrl).toBe(page);
    // Bash's most, for a sleeping box; it answers as soon as the captures are in. No settle: no settle_ms.
    expect(FETCH_TIMEOUT_MS).toBe(20_000);
    const plain = world(() => fetched([busCapture]));
    await createBrowserFetchRunner(plain.deps).read('t1', BUSES, busPlan);
    expect(plain.calls[0]!.opts['body']).toEqual({ url: BUSES, capture: [{ match: '/buslist/v3/services$' }], timeout_ms: FETCH_TIMEOUT_MS, frames: { width: FRAME_WIDTH } });
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

  it("names each fetch's tab by its run, so Bash's browser watch labels it: on a page and on a page call", async () => {
    const w = world((c) =>
      (c.opts['body'] as { steps?: Array<{ op: string }> }).steps?.[0]?.op === 'page_fetch'
        ? { ...fetched([capture('fast', 'https://www.ixigo.com/plan/goa', '0:{}')]), final_url: 'https://www.ixigo.com/' }
        : fetched([busCapture]));
    const runner = createBrowserFetchRunner(w.deps);
    await runner.read('t1', BUSES, busPlan, { tag: '01JRUNPAGE' });
    await runner.pageFetch!('t1', { url: '/plan/goa', method: 'GET' }, { tag: '01JRUNFAST' });
    await runner.read('t1', BUSES, busPlan);
    expect(w.calls.map((c) => (c.opts['body'] as { tag?: string }).tag)).toEqual(['01JRUNPAGE', '01JRUNFAST', undefined]);
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
    // ixigo's payment page, blocked by Bash (#4591): said plainly, and not logged as a fault of Go's setup.
    const payment = await said(new V1Error(403, 'page_blocked', 'ixigo.com/payments/ is blocked.'));
    expect(payment.err).toMatchObject({ code: 'refused', message: PAYMENT_PAGE_BLOCKED });
    expect(PAYMENT_PAGE_BLOCKED).toBe("That's the payment page, and Go never opens it; the payer finishes on ixigo.");
    expect(payment.w.log.warn).not.toHaveBeenCalled();
  });

  it("falls to the page when Bash has no page_fetch, naming Bash's own status, never its schema's words (the 8 Oct drill)", async () => {
    // Today's staging Bash refuses a fetch with no url: "Invalid input: expected string, received undefined".
    const old = world(() => {
      throw new V1Error(400, 'invalid_request', 'Invalid input: expected string, received undefined');
    });
    const err = await createBrowserFetchRunner(old.deps).pageFetch!('t1', { url: '/plan/goa', method: 'GET' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TravelError);
    expect(err).toMatchObject({ code: 'unreachable', message: 'fast unavailable: Bash answered 400 invalid_request' });
    // An answer with no page call in it at all: fast is unavailable too, not a crash.
    const odd = world(() => ({ final_url: 'https://www.ixigo.com/', elapsed_ms: 10, woke: false }));
    await fails(createBrowserFetchRunner(odd.deps).pageFetch!('t1', { url: '/plan/goa', method: 'GET' }), 'unreachable', /fast unavailable: Bash's answer had no page call/);
  });

  it('remembers for 10 minutes that a Bash takes no page calls, asking it nothing meanwhile, then tries again', async () => {
    const w = world(() => {
      throw new V1Error(400, 'invalid_request', 'Invalid input: expected string, received undefined');
    });
    const runner = createBrowserFetchRunner(w.deps);
    expect(runner.canPageFetch!()).toBe(true);
    await runner.pageFetch!('t1', { url: '/plan/goa', method: 'GET' }).catch(() => undefined);
    expect(runner.canPageFetch!()).toBe(false);
    await fails(runner.pageFetch!('t1', { url: '/plan/goa', method: 'GET' }), 'unreachable', /takes no page calls/);
    expect(w.calls).toHaveLength(1);
    // Once Bash has page_fetch, page calls resume within 10 minutes, with no deploy of Go's.
    await w.deps.sleep(FAST_UNSUPPORTED_MS);
    expect(runner.canPageFetch!()).toBe(true);
    // A refusal for one call (403, a blocked page) is not a Bash without page_fetch.
    const blocked = world(() => {
      throw new V1Error(403, 'page_blocked', 'Blocked.');
    });
    const other = createBrowserFetchRunner(blocked.deps);
    await other.pageFetch!('t1', { url: '/payments/x', method: 'GET' }).catch(() => undefined);
    expect(other.canPageFetch!()).toBe(true);
  });

  describe('a cold computer (COLD_COMPUTER)', () => {
    const caughtNothing = () =>
      new V1Error(504, 'timeout', 'The page did not send every capture within 12000 ms (it stopped at 1 wait_for).', null, {
        code: 'timeout', partial: { elapsed_ms: 12_300, step: '1 wait_for', captures: [] },
      });

    it('asks a page that caught nothing once more on a computer Go has not read ixigo on, and tells the strip both', async () => {
      const w = world((_, n) => {
        if (n === 1) throw caughtNothing();
        return fetched([busCapture]);
      });
      const traces: FetchTrace[] = [];
      const read = await createBrowserFetchRunner(w.deps).read('t1', BUSES, busPlan, { onTrace: (t) => traces.push(t) });
      expect(read.captures).toHaveLength(1);
      expect(w.calls).toHaveLength(2);
      expect(traces.map((t) => t.failed?.why ?? 'ok')).toEqual(['ran out of time at 1 wait_for', 'ok']);
    });

    it('asks only once more, and never again once a fetch has read ixigo on that computer', async () => {
      const twice = world(() => {
        throw caughtNothing();
      });
      await fails(createBrowserFetchRunner(twice.deps).read('t1', BUSES, busPlan), 'unreachable', /took too long/);
      expect(twice.calls).toHaveLength(2);
      const w = world((_, n) => {
        if (n === 1) return fetched([busCapture]);
        throw caughtNothing();
      });
      const runner = createBrowserFetchRunner(w.deps);
      await runner.read('t1', BUSES, busPlan);
      await fails(runner.read('t1', BUSES, busPlan), 'unreachable', /took too long/);
      expect(w.calls).toHaveLength(2);
    });

    it("primes a new trip's computer with one visit to ixigo's home, its popup closed, and a primed computer's page is asked once", async () => {
      const w = world((_, n) => {
        if (n === 1) return { ...fetched([capture('prime', 'https://www.ixigo.com/', '<html>')]), final_url: 'https://www.ixigo.com/' };
        throw caughtNothing();
      });
      const runner = createBrowserFetchRunner(w.deps);
      await runner.prime!('t1');
      expect(w.calls[0]).toEqual({
        method: 'POST', path: '/v1/users/u-t1/browser/fetch',
        opts: { body: {
          url: 'https://www.ixigo.com/',
          steps: [{ op: 'click', name: 'Close modal', optional: true }, { op: 'page_fetch', url: '/', method: 'GET', capture_as: 'prime', max_bytes: 1_000 }],
          timeout_ms: PRIME_TIMEOUT_MS,
        } },
      });
      await fails(runner.read('t1', BUSES, busPlan), 'unreachable', /took too long/);
      expect(w.calls).toHaveLength(2);
    });

    it('a prime ixigo did not answer throws, so setup tries again, and leaves the first search its one more ask', async () => {
      const w = world((_, n) => {
        if (n === 1) throw new V1Error(503, 'box_unavailable', 'The computer did not wake.');
        if (n === 2) return fetched([]);
        if (n === 3) throw caughtNothing();
        return fetched([busCapture]);
      });
      const runner = createBrowserFetchRunner(w.deps);
      await expect(runner.prime!('t1')).rejects.toMatchObject({ status: 503, code: 'box_unavailable' });
      await fails(runner.prime!('t1'), 'unreachable', /did not answer/);
      expect((await runner.read('t1', BUSES, busPlan)).captures).toHaveLength(1);
      expect(w.calls).toHaveLength(4);
    });
  });

  it('logs where a page was when its time ran out, as Bash says it, so the next drill shows the step', async () => {
    const late = world(() => {
      throw new V1Error(504, 'timeout', 'The page did not send every capture within 20000 ms (it stopped at 2 type). What it sent is in partial.', null, { code: 'timeout', partial: { captures: [] } });
    });
    await fails(createBrowserFetchRunner(late.deps).read('t1', BUSES, busPlan), 'unreachable', /took too long/);
    expect(late.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tripId: 't1', message: expect.stringContaining('it stopped at 2 type') }),
      'travel: a page ran out of time',
    );
  });

  it("tells the run strip where each call's time went: the wake, the page, each kept call; and on a timeout, where it stopped", async () => {
    const timings = { wake_ms: 4_000, nav_ms: 5_200, first_capture_ms: 7_000, done_ms: 7_400 };
    const ok = world(() => ({ ...fetched([busCapture]), woke: true, timings }));
    const traces: FetchTrace[] = [];
    await createBrowserFetchRunner(ok.deps).read('t1', BUSES, busPlan, { onTrace: (t) => traces.push(t) });
    expect(traces).toEqual([{
      started_at: Date.parse('2026-11-01T10:00:00Z'), elapsed_ms: 2300, woke: true, timings,
      calls: [{ url: busCapture.url, status: busCapture.status, at_ms: busCapture.at_ms }],
    }]);
    const partial = { final_url: BUSES, elapsed_ms: 12_000, woke: false, timings, step: '2 scroll', captures: [busCapture] };
    const late = world(() => {
      throw new V1Error(504, 'timeout', 'The fetch timed out.', null, { code: 'timeout', partial });
    });
    const lateTraces: FetchTrace[] = [];
    await createBrowserFetchRunner(late.deps).read('t1', BUSES, busPlan, { onTrace: (t) => lateTraces.push(t) });
    expect(lateTraces).toEqual([expect.objectContaining({ elapsed_ms: 12_000, timings, failed: { status: 504, why: 'ran out of time at 2 scroll' } })]);
    expect(lateTraces[0]!.calls).toHaveLength(1);
    const refused = world(() => {
      throw new V1Error(403, 'domain_not_allowed', 'Not allowed.');
    });
    const refusedTraces: FetchTrace[] = [];
    await createBrowserFetchRunner(refused.deps).read('t1', BUSES, busPlan, { onTrace: (t) => refusedTraces.push(t) }).catch(() => undefined);
    // A failure by its status and code, never its message.
    expect(refusedTraces).toEqual([expect.objectContaining({ calls: [], failed: { status: 403, why: 'domain_not_allowed' } })]);
  });

  it("tells the run strip a page call's own time, and a page call that failed", async () => {
    const fast = { ...capture('fast', '/plan/goa', '{}'), at_ms: 380 };
    const ok = world(() => ({ final_url: 'https://www.ixigo.com/', elapsed_ms: 420, woke: false, captures: [fast] }));
    const traces: FetchTrace[] = [];
    await createBrowserFetchRunner(ok.deps).pageFetch!('t1', { url: '/plan/goa', method: 'GET' }, { onTrace: (t) => traces.push(t) });
    expect(traces).toEqual([expect.objectContaining({ elapsed_ms: 420, calls: [{ method: 'GET', url: fast.url, status: fast.status, at_ms: 380, ms: 380 }] })]);
    const down = world(() => {
      throw new V1Error(402, 'out_of_credit', 'No credit.');
    });
    const downTraces: FetchTrace[] = [];
    await createBrowserFetchRunner(down.deps).pageFetch!('t1', { url: '/plan/goa', method: 'GET' }, { onTrace: (t) => downTraces.push(t) }).catch(() => undefined);
    expect(downTraces).toEqual([expect.objectContaining({ calls: [], failed: { status: 402, why: 'out_of_credit' } })]);
  });
});

describe("fetches at once on one trip's computer: Bash runs only so many (409 browser_busy past them)", () => {
  /** Lets every promise that can move, move: a fetch that got a slot has asked Bash by then. */
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r));
  const busy = () => new V1Error(409, 'browser_busy', "This user's browser is already running 2 fetches.", 1_000, { code: 'browser_busy', retry_after_ms: 1_000 });

  it("asks Bash for no more at once than the computer's slots: the rest wait their turn, in order, and the switch lets more in", async () => {
    let slots = DEFAULT_SLOTS;
    const ends: Array<() => void> = [];
    let going = 0;
    let most = 0;
    const w = world(async () => {
      going += 1;
      most = Math.max(most, going);
      await new Promise<void>((r) => ends.push(r));
      going -= 1;
      return fetched([busCapture]);
    });
    const runner = createBrowserFetchRunner({ ...w.deps, slots: () => slots });
    const asked = () => w.calls.map((c) => `${c.path.split('/')[3]} ${String((c.opts['body'] as { url?: string }).url).split('?n=')[1]}`);
    const reads = [1, 2, 3, 4, 5].map((n) => runner.read('t1', `${BUSES}?n=${n}`, busPlan));
    await settle();
    expect(asked()).toEqual(['u-t1 1', 'u-t1 2']);
    // Another trip's computer has slots of its own.
    const other = runner.read('t2', `${BUSES}?n=9`, busPlan);
    await settle();
    expect(asked()).toEqual(['u-t1 1', 'u-t1 2', 'u-t2 9']);
    ends.shift()!();
    await settle();
    // The first to wait goes first.
    expect(asked().slice(3)).toEqual(['u-t1 3']);
    // Bash runs four now: the next fetch to end lets two more in.
    slots = 4;
    ends.shift()!();
    await settle();
    expect(asked().slice(4)).toEqual(['u-t1 4', 'u-t1 5']);
    while (ends.length > 0) {
      ends.shift()!();
      await settle();
    }
    await Promise.all([...reads, other]);
    expect(w.calls).toHaveLength(6);
    expect(most).toBe(4);
  });

  it("lets a waiting fetch of a lower priority go first: a composite's trains before its buses, first come first served within one", async () => {
    const ends: Array<() => void> = [];
    const w = world(async () => {
      await new Promise<void>((r) => ends.push(r));
      return fetched([busCapture]);
    });
    const runner = createBrowserFetchRunner({ ...w.deps, slots: () => 1 });
    const asked = () => w.calls.map((c) => String((c.opts['body'] as { url?: string }).url).split('?n=')[1]);
    const reads = [
      runner.read('t1', `${BUSES}?n=1`, busPlan),
      runner.read('t1', `${BUSES}?n=2`, busPlan, { priority: 1 }),
      runner.read('t1', `${BUSES}?n=3`, busPlan, { priority: 0 }),
      runner.read('t1', `${BUSES}?n=4`, busPlan, { priority: 1 }),
    ];
    for (let i = 0; i < 4; i++) {
      await settle();
      ends.shift()?.();
    }
    await Promise.all(reads);
    expect(asked()).toEqual(['1', '3', '2', '4']);
  });

  it('lets a waiting fetch go as soon as the slots are raised, without waiting for one to end', async () => {
    let slots = 1;
    const ends: Array<() => void> = [];
    const w = world(async () => {
      await new Promise<void>((r) => ends.push(r));
      return fetched([busCapture]);
    });
    const runner = createBrowserFetchRunner({ ...w.deps, slots: () => slots });
    const reads = [runner.read('t1', `${BUSES}?n=1`, busPlan), runner.read('t1', `${BUSES}?n=2`, busPlan)];
    await settle();
    expect(w.calls).toHaveLength(1);
    // Bash runs more now: the next fetch to come lets the one waiting go at once, and waits itself.
    slots = 2;
    reads.push(runner.read('t1', `${BUSES}?n=3`, busPlan));
    await settle();
    expect(w.calls.map((c) => String((c.opts['body'] as { url?: string }).url).split('?n=')[1])).toEqual(['1', '2']);
    while (ends.length > 0) {
      ends.shift()!();
      await settle();
    }
    await Promise.all(reads);
    expect(w.calls).toHaveLength(3);
  });

  it("counts by the computer, not the trip: two trips on one /v1 user share its slots", async () => {
    const ends: Array<() => void> = [];
    const w = world(async () => {
      await new Promise<void>((r) => ends.push(r));
      return fetched([busCapture]);
    });
    const runner = createBrowserFetchRunner({ ...w.deps, computer: { userIdFor: () => 'u-box', ensureUser: async () => 'u-box' }, slots: () => 1 });
    const both = [runner.read('t1', BUSES, busPlan), runner.read('t2', BUSES, busPlan)];
    await settle();
    expect(w.calls).toHaveLength(1);
    ends.shift()!();
    await settle();
    expect(w.calls).toHaveLength(2);
    ends.shift()!();
    await Promise.all(both);
  });

  it('frees the slot of a fetch that failed, and lets a waiting fetch whose turn is over leave without asking Bash', async () => {
    const ends: Array<() => void> = [];
    const w = world(async (_, n) => {
      await new Promise<void>((r) => ends.push(r));
      if (n === 1) throw new V1Error(503, 'not_ready', 'The computer did not wake.');
      return fetched([busCapture]);
    });
    const runner = createBrowserFetchRunner({ ...w.deps, slots: () => 1 });
    const first = runner.read('t1', BUSES, busPlan).then(() => 'ok', (e: unknown) => (e as TravelError).code);
    const stop = new AbortController();
    const gaveUp = runner.read('t1', BUSES, busPlan, { signal: stop.signal }).then(() => 'ok', () => 'left');
    const next = runner.read('t1', BUSES, busPlan);
    await settle();
    stop.abort();
    expect(await gaveUp).toBe('left');
    ends.shift()!();
    expect(await first).toBe('unreachable');
    await settle();
    ends.shift()!();
    await next;
    // The one that left never reached Bash: the failed fetch's slot went to the next.
    expect(w.calls).toHaveLength(2);
  });

  it("waits as long as Bash says when its fetches are all taken, and asks again, then says the computer is busy; a page call doesn't wait", async () => {
    const twice = world((_, n) => {
      if (n <= 2) throw busy();
      return fetched([busCapture]);
    });
    const read = await createBrowserFetchRunner(twice.deps).read('t1', BUSES, busPlan);
    expect(read.captures).toHaveLength(1);
    expect(twice.calls).toHaveLength(3);
    expect(twice.elapsed()).toBe(2_000);
    const always = world(() => {
      throw busy();
    });
    // Not "someone is using the browser": nobody is, the computer is reading other pages.
    await fails(createBrowserFetchRunner(always.deps).read('t1', BUSES, busPlan), 'unreachable', /busy with other searches/);
    expect(always.calls).toHaveLength(BUSY_TRIES + 1);
    // A page call is for speed: a busy one fails at once, and the run falls to the page, which waits its turn.
    const call = world((_, n) => {
      if (n === 1) throw busy();
      return { ...fetched([capture('fast', 'https://www.ixigo.com/plan/goa', '0:{}')]), final_url: 'https://www.ixigo.com/' };
    });
    await fails(createBrowserFetchRunner(call.deps).pageFetch!('t1', { url: '/plan/goa', method: 'GET' }), 'unreachable', /409 browser_busy/);
    expect(call.calls).toHaveLength(1);
    expect(call.elapsed()).toBe(0);
  });
});
