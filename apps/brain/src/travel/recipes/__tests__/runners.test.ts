import { describe, expect, it, vi } from 'vitest';
import { V1Error } from '../../../tasks/v1-client.js';
import { TravelError } from '../../mcp-travel.js';
import type { RecipeProgress } from '../progress.js';
import type { FetchPlan } from '../recipe.js';
import {
  BUSY_TRIES, CHALLENGE_TRIES, CHALLENGE_WAIT_MS, CHALLENGED, ChallengedError, challenged, challengeTime, createBrowserFetchRunner, DEFAULT_SLOTS, FAST_TIMEOUT_MS, FAST_UNSUPPORTED_MS, FETCH_TIMEOUT_MS, FRAME_WIDTH, IN_USE_WAIT_MS, LOOK_AFTER_MS, LOOK_UNSUPPORTED_MS,
  LOOK_SETTLE_MS, LOOK_TIMEOUT_MS, OUT_OF_CREDIT, PAYMENT_PAGE_BLOCKED, PRIME_TIMEOUT_MS, WARM_TAB_MS, type FetchTrace,
} from '../runners.js';
import { capture, fixture } from './fixtures.js';

type Call = { method: string; path: string; opts: Record<string, unknown> };

/**
 * Bash's own rule for a browser fetch (packages/shared/src/platform/browser.ts, BrowserFetchBody): at least one capture
 * required, or a page_fetch step. The fake refuses what Bash refuses: a login plan of optional captures alone passed every
 * test here and was 400 invalid_request on every hand-off on staging (9 Oct, 13:24).
 */
function bashTakes(body: unknown): boolean {
  const b = (body ?? {}) as { capture?: Array<{ required?: boolean }>; steps?: Array<{ op?: string }> };
  return (b.capture ?? []).some((c) => c.required !== false) || (b.steps ?? []).some((x) => x.op === 'page_fetch');
}

function world(handler: (c: Call, n: number) => unknown) {
  let nowMs = Date.parse('2026-11-01T10:00:00Z');
  const calls: Call[] = [];
  const v1 = {
    async call<T>(method: string, path: string, opts: Record<string, unknown> = {}): Promise<T> {
      const c = { method, path, opts };
      calls.push(c);
      if (path.endsWith('/browser/fetch') && !bashTakes(opts['body'])) {
        throw new V1Error(400, 'invalid_request', 'Mark at least one capture required, or call the page with a page_fetch step', null, { code: 'invalid_request' });
      }
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
/** The page's own document as every fetch keeps it (CLOUDFLARE): one byte, its status, never waited for. */
const docOf = (match: string) => ({ match, required: false, max_bytes: 1, max_count: 4 });
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
          capture: [{ match: SEARCH, max_bytes: 2_000_000, min_count: 2, max_count: 2 }, docOf('/hotels/search/result$')],
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
    expect(plain.calls[0]!.opts['body']).toEqual({
      url: BUSES, capture: [{ match: '/buslist/v3/services$' }, docOf('/buses/bus_search/Mumbai/4/Goa/102/06-11-2026/O$')], timeout_ms: FETCH_TIMEOUT_MS, frames: { width: FRAME_WIDTH },
    });
  });

  it("a plan with a grace tells Bash which captures it needs, on a page read and in a hand-off: the rest get the grace", async () => {
    const WALLET = '/api/v3/ixigo-money/wallet';
    const plan: FetchPlan = {
      capture: [
        { match: '/api/flights/locations/nearby', required: true, max_bytes: 1 },
        { match: WALLET, required: false, max_bytes: 1 }, { match: '/api/v2/oauth/userinfo', required: false, max_bytes: 1 },
      ],
      steps: [],
      timeoutMs: 12_000,
      graceMs: 3_000,
    };
    const w = world(() => fetched([capture(WALLET, `https://www.ixigo.com${WALLET}`, '{', 200)], 'https://www.ixigo.com/'));
    const runner = createBrowserFetchRunner(w.deps);
    await runner.read('t1', 'https://www.ixigo.com/', plan);
    await runner.handOff!('t1', 'https://www.ixigo.com/', plan, { keepOpenMs: 600_000, tab: 'ixigo_login' });
    const sent = [
      { match: '/api/flights/locations/nearby', required: true, max_bytes: 1 },
      { match: WALLET, required: false, max_bytes: 1 }, { match: '/api/v2/oauth/userinfo', required: false, max_bytes: 1 }, docOf('/$'),
    ];
    expect(w.calls.map((c) => c.opts['body'])).toEqual([
      { url: 'https://www.ixigo.com/', capture: sent, steps: plan.steps, timeout_ms: 12_000, grace_ms: 3_000, frames: { width: FRAME_WIDTH } },
      { url: 'https://www.ixigo.com/', capture: sent, timeout_ms: 12_000, grace_ms: 3_000, front: true, keep_open_ms: 600_000, tab: 'ixigo_login' },
    ]);
  });

  // ixigo's hotel popup shows 1 s after the page mounts, so the recipe's first click looks for it up to 3 s (Bash's
  // within_ms). A Bash from before within_ms takes no unknown field in a step: its 400 names the step (param), and Go
  // asks the same fetch again with that click looking once, as it did before, and sends none for a while.
  it('sends an optional click its within_ms; a Bash that refuses it gets the same fetch with the click looking once, for a while', async () => {
    const SEARCH = '/accommodation-search/api/v3/accommodations/search$';
    const url = 'https://www.ixigo.com/accommodation-search/api/v3/accommodations/search';
    const page = 'https://www.ixigo.com/hotels/search/result?locationId=1026';
    const plan: FetchPlan = {
      capture: [{ match: SEARCH, required: true }],
      steps: [{ op: 'click', name: 'Close modal', optional: true, within_ms: 3_000 }, { op: 'wait_for', match: SEARCH }, { op: 'click', name: 'Close modal', optional: true }],
    };
    const once = [{ op: 'click', name: 'Close modal', optional: true }, { op: 'wait_for', match: SEARCH }, { op: 'click', name: 'Close modal', optional: true }];
    const answer = fetched([capture(SEARCH, url, fixture('stays-goa-page1.json'))], page);
    const stepsSent = (w: ReturnType<typeof world>) => w.calls.map((c) => (c.opts['body'] as { steps: unknown }).steps);
    // A Bash that takes it.
    const today = world(() => answer);
    await createBrowserFetchRunner(today.deps).read('t1', page, plan);
    expect(stepsSent(today)).toEqual([plan.steps]);
    // One that predates it: refused before anything opens, then the same fetch with one look.
    const older = world((c) => {
      const steps = (c.opts['body'] as { steps: Array<Record<string, unknown>> }).steps;
      if (steps.some((x) => 'within_ms' in x)) throw new V1Error(400, 'invalid_request', 'Invalid input', null, { code: 'invalid_request', param: 'steps.0' });
      return answer;
    });
    const runner = createBrowserFetchRunner(older.deps);
    expect((await runner.read('t1', page, plan)).captures).toHaveLength(1);
    expect(stepsSent(older)).toEqual([plan.steps, once]);
    expect(older.log.warn).toHaveBeenCalledOnce();
    // For a while after, none is sent: one fetch each. Past LOOK_UNSUPPORTED_MS it is asked again, in case Bash has it now.
    await runner.read('t1', page, plan);
    expect(stepsSent(older)).toEqual([plan.steps, once, once]);
    await older.deps.sleep(LOOK_UNSUPPORTED_MS);
    await runner.read('t1', page, plan);
    expect(stepsSent(older)).toEqual([plan.steps, once, once, plan.steps, once]);
    // A 400 that names another step is not this one: never asked again.
    const other = world(() => {
      throw new V1Error(400, 'invalid_request', 'Invalid input', null, { code: 'invalid_request', param: 'steps.1' });
    });
    await createBrowserFetchRunner(other.deps).read('t1', page, plan).catch(() => undefined);
    expect(other.calls).toHaveLength(1);
  });

  // CLOUDFLARE: ixigo's "Just a moment..." check (about 1 in 7 front loads on a staging box, 8 Oct) answers the page's
  // own document 403 and the page makes none of its calls, so the fetch runs out of time with only that.
  const BUS_DOC = '/buses/bus_search/Mumbai/4/Goa/102/06-11-2026/O$';
  const docAt = (status: number, at_ms: number) => ({ ...capture(BUS_DOC, BUSES, '<', status), at_ms });
  const onCheck = (captures: unknown[]) => new V1Error(504, 'timeout', 'The page did not send every capture within 20000 ms (it stopped at captures).', null, {
    code: 'timeout', partial: { captures, frames: [{ label: 'navigated', at_ms: 900, page_url: BUSES, jpeg_base64: '/9j/CHECK' }] },
  });

  it("opens a page on Cloudflare's check again after a wait, and reads it once it is the page: the check is never read, nor pictured", async () => {
    const w = world((_, n) => {
      if (n === 1) throw onCheck([docAt(403, 300)]);
      // The second load met the check too, and it passed in the page: the page loaded again, and answered.
      return fetched([docAt(403, 300), docAt(200, 2_100), busCapture]);
    });
    const seen: RecipeProgress[] = [];
    const read = await createBrowserFetchRunner(w.deps).read('t1', BUSES, busPlan, { onProgress: (e) => seen.push(e) });
    expect(read.captures).toEqual([busCapture]);
    expect(w.calls).toHaveLength(2);
    expect(w.elapsed()).toBe(CHALLENGE_WAIT_MS);
    expect(seen).toEqual([]);
    expect(w.log.warn).toHaveBeenCalledWith(expect.objectContaining({ again: 1 }), "travel: ixigo's page was Cloudflare's check; opening it again");
  });

  it(`a page still on the check after ${CHALLENGE_TRIES} more loads fails saying so, and is never the cold computer's retry`, async () => {
    const w = world(() => {
      throw onCheck([docAt(403, 300)]);
    });
    const err = await createBrowserFetchRunner(w.deps).read('t1', BUSES, busPlan).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ChallengedError);
    expect(err).toMatchObject({ code: 'unreachable', message: CHALLENGED });
    expect(w.calls).toHaveLength(1 + CHALLENGE_TRIES);
    // An answer that ends on the check is one too, and a page whose time is up for its caller is not loaded again.
    const ended = new AbortController();
    const fast = world(() => {
      ended.abort();
      return fetched([docAt(503, 300)]);
    });
    await expect(createBrowserFetchRunner(fast.deps).read('t1', BUSES, busPlan, { signal: ended.signal })).rejects.toBeInstanceOf(ChallengedError);
    expect(fast.calls).toHaveLength(1);
    // A cold computer's page that caught only its document, 200, is the cold retry as before: no check, no wait.
    const cold = world((_, n) => {
      if (n === 1) throw onCheck([docAt(200, 300)]);
      return fetched([busCapture]);
    });
    expect((await createBrowserFetchRunner(cold.deps).read('t1', BUSES, busPlan)).captures).toEqual([busCapture]);
    expect(cold.elapsed()).toBe(0);
  });

  it("never hands a page on the check to the person: a hand-off loads it again, and says challenged when it stays", async () => {
    const HOME = 'https://www.ixigo.com/';
    const homeDoc = (status: number) => ({ ...capture('/$', HOME, '<', status), at_ms: 300 });
    const WALLET = capture('/api/v3/ixigo-money/wallet', `${HOME}api/v3/ixigo-money/wallet`, '{', 200);
    const plan: FetchPlan = {
      capture: [{ match: '/api/flights/locations/nearby', required: true, max_bytes: 1 }, { match: '/api/v3/ixigo-money/wallet', required: false, max_bytes: 1 }], timeoutMs: 12_000, graceMs: 3_000,
    };
    const passes = world((_, n) => {
      if (n < 3) throw new V1Error(504, 'timeout', 'The page did not send every capture.', null, { partial: { captures: [homeDoc(403)] } });
      return fetched([homeDoc(200), WALLET], HOME);
    });
    expect(await createBrowserFetchRunner(passes.deps).handOff!('t1', HOME, plan, { keepOpenMs: 600_000, tab: 'ixigo_login' })).toEqual({ captures: [WALLET] });
    expect(passes.calls).toHaveLength(3);
    expect(passes.elapsed()).toBe(2 * CHALLENGE_WAIT_MS);
    const stays = world(() => fetched([homeDoc(403)], HOME));
    expect(await createBrowserFetchRunner(stays.deps).handOff!('t1', HOME, plan, { keepOpenMs: 600_000, tab: 'ixigo_login' })).toEqual({ captures: [], challenged: true });
    expect(stays.calls).toHaveLength(1 + CHALLENGE_TRIES);
  });

  it("reads only the page's own address as its document: an API path ending in / that answers 403 on the home page is not the check", async () => {
    const HOME = 'https://www.ixigo.com/';
    const at = (url: string, status: number, at_ms: number) => ({ ...capture('/$', url, '<', status), at_ms });
    // The home page's "/$" also takes a same-site API whose path ends in "/": a logged-out page's 403 there is not the check.
    const stray = [at(HOME, 200, 300), at('https://www.ixigo.com/api/x/', 403, 2_400)];
    expect(challenged(stray, HOME)).toBe(false);
    // The page's own address, its query aside (the check's own load again adds one), is: on the check, and passed.
    expect(challenged([at(HOME, 403, 300), at('https://www.ixigo.com/api/x/', 200, 900)], HOME)).toBe(true);
    expect(challenged([at(HOME, 403, 300), at('https://www.ixigo.com/?__cf_chl_tk=t', 200, 5_400)], HOME)).toBe(false);
    // Another site's "/" is never the page's.
    expect(challenged([at(HOME, 200, 300), at('https://images.ixigo.com/', 403, 900)], HOME)).toBe(false);
    // A hand-off on that page is handed over at once, never loaded again.
    const w = world(() => fetched(stray, HOME));
    const plan: FetchPlan = { capture: [{ match: '/api/flights/locations/nearby', required: true, max_bytes: 1 }], timeoutMs: 12_000 };
    expect(await createBrowserFetchRunner(w.deps).handOff!('t1', HOME, plan, { keepOpenMs: 600_000, tab: 'ixigo_login' })).toEqual({ captures: [] });
    expect(w.calls).toHaveLength(1);
  });

  it("gives the loads again their own time: a hand-off stuck on the check for its whole 12 s still loads once more, and is done within 25 s", async () => {
    const HOME = 'https://www.ixigo.com/';
    const homeDoc = (status: number, at_ms: number) => ({ ...capture('/$', HOME, '<', status), at_ms });
    const WALLET = capture('/api/v3/ixigo-money/wallet', `${HOME}api/v3/ixigo-money/wallet`, '{', 200);
    // The login's own plan: Bash waits for ixigo's nearby call, which a page on the check never makes.
    const plan: FetchPlan = {
      capture: [{ match: '/api/flights/locations/nearby', required: true, max_bytes: 1 }, { match: '/api/v3/ixigo-money/wallet', required: false, max_bytes: 1 }], steps: [], timeoutMs: 12_000, graceMs: 3_000,
    };
    const timeOf = (c: Call): number => (c.opts['body'] as { timeout_ms: number }).timeout_ms;
    /** A load that stays on the check runs to its time on Bash's clock, then times out with only its document. */
    const stuck = async (w: ReturnType<typeof world>, c: Call): Promise<never> => {
      await w.deps.sleep(timeOf(c));
      throw new V1Error(504, 'timeout', 'The page did not send every capture (it stopped at 1 wait_for).', null, { partial: { captures: [homeDoc(403, 300)] } });
    };
    const loads = (w: ReturnType<typeof world>) => w.calls.map((c) => timeOf(c));
    const hand = (w: ReturnType<typeof world>) => createBrowserFetchRunner(w.deps).handOff!('t1', HOME, plan, { keepOpenMs: 600_000, tab: 'ixigo_login' });

    // On the check for all of its 12 s; loaded again 1 s later with the 11 s left, where the check passes in the page
    // (about 5 s) and the page answers.
    const passes: ReturnType<typeof world> = world(async (c, n) => {
      if (n === 1) return stuck(passes, c);
      await passes.deps.sleep(9_500);
      return fetched([homeDoc(403, 300), homeDoc(200, 5_500), WALLET], HOME);
    });
    expect(await hand(passes)).toEqual({ captures: [WALLET] });
    expect(loads(passes)).toEqual([12_000, 11_000]);
    expect(passes.elapsed()).toBe(12_000 + CHALLENGE_WAIT_MS + 9_500);
    expect(challengeTime(12_000)).toBeLessThanOrEqual(25_000);

    // On it both times: the card comes at 24 s, with no third load that would not fit (less than CHALLENGE_LOAD_MS left).
    const stays: ReturnType<typeof world> = world(async (c) => stuck(stays, c));
    expect(await hand(stays)).toEqual({ captures: [], challenged: true });
    expect(loads(stays)).toEqual([12_000, 11_000]);
    expect(stays.elapsed()).toBe(challengeTime(12_000));

    // The common good case: a check that passes in the page, its nearby call late, the load running out its time with the
    // page in: never loaded again.
    const late: ReturnType<typeof world> = world(async (c) => {
      await late.deps.sleep(timeOf(c));
      throw new V1Error(504, 'timeout', 'The page did not send every capture.', null, { partial: { captures: [homeDoc(403, 300), homeDoc(200, 6_000), WALLET] } });
    });
    expect(await hand(late)).toEqual({ captures: [WALLET] });
    expect(late.calls).toHaveLength(1);

    // A read the same way: a recipe page's 20 s, then once more with the 19 s left, within the 40 s.
    const read: ReturnType<typeof world> = world(async (c, n) => {
      if (n === 1) {
        await read.deps.sleep(timeOf(c));
        throw onCheck([docAt(403, 300)]);
      }
      return fetched([busCapture]);
    });
    expect((await createBrowserFetchRunner(read.deps).read('t1', BUSES, busPlan)).captures).toEqual([busCapture]);
    expect(loads(read)).toEqual([FETCH_TIMEOUT_MS, challengeTime(FETCH_TIMEOUT_MS) - FETCH_TIMEOUT_MS - CHALLENGE_WAIT_MS]);
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

  it("hands a page to the person in front of their window (Bash's front), keeping its tab for them, and closes it after", async () => {
    const USERINFO_URL = 'https://www.ixigo.com/api/v2/oauth/userinfo';
    const w = world(() => fetched([capture('check', USERINFO_URL, '{', 403)], 'https://www.ixigo.com/'));
    const runner = createBrowserFetchRunner(w.deps);
    const plan: FetchPlan = { capture: [], steps: [{ op: 'click', role: 'button', name: 'Login' }, { op: 'click', role: 'textbox', text: 'mobile' }], timeoutMs: 12_000 };
    const opened = await runner.handOff!('t1', 'https://www.ixigo.com/', plan, { keepOpenMs: 600_000, tab: 'ixigo_login', check: { url: '/api/v2/oauth/userinfo', method: 'POST' } });
    expect(opened.captures).toMatchObject([{ match: 'check', status: 403 }]);
    // No pictures: the person watches the page itself. The check goes first, from inside the page, one byte.
    expect(w.calls).toEqual([{
      method: 'POST', path: '/v1/users/u-t1/browser/fetch',
      opts: { body: {
        url: 'https://www.ixigo.com/', capture: [docOf('/$')],
        steps: [
          { op: 'page_fetch', url: '/api/v2/oauth/userinfo', method: 'POST', capture_as: 'check', max_bytes: 1 },
          { op: 'click', role: 'button', name: 'Login' }, { op: 'click', role: 'textbox', text: 'mobile' },
        ],
        timeout_ms: 12_000, front: true, keep_open_ms: 600_000, tab: 'ixigo_login',
      } },
    }]);
    // Taps on the kept hand-off tab, in front, after the page: a call closes the fetch; a tap not found (504) or a tab
    // gone (no_open_tab) is nothing.
    const taps = world(() => fetched([capture('steps_done', 'https://www.ixigo.com/', '<', 200)], 'https://www.ixigo.com/'));
    await createBrowserFetchRunner(taps.deps).tabSteps!('t1', 'ixigo_login', [{ op: 'click', role: 'button', name: 'Login' }], { keepOpenMs: 600_000, timeoutMs: 12_000 });
    expect(taps.calls[0]!.opts['body']).toEqual({
      tab: 'ixigo_login', front: true, keep_open_ms: 600_000, timeout_ms: 12_000,
      steps: [{ op: 'click', role: 'button', name: 'Login' }, { op: 'page_fetch', url: '/', method: 'GET', capture_as: 'steps_done', max_bytes: 1 }],
    });
    for (const err of [new V1Error(504, 'timeout', 'The page did not send every capture (it stopped at 1 click).'), new V1Error(409, 'no_open_tab', 'No tab is kept open.')]) {
      const failing = world(() => {
        throw err;
      });
      await expect(createBrowserFetchRunner(failing.deps).tabSteps!('t1', 'ixigo_login', [], { keepOpenMs: 600_000, timeoutMs: 12_000 })).resolves.toBeUndefined();
    }
    await runner.release!('t1', 'ixigo_login');
    expect(w.calls[1]!.opts['body']).toEqual({ tab: 'ixigo_login', steps: [{ op: 'page_fetch', url: '/', method: 'GET', capture_as: 'close', max_bytes: 1 }], timeout_ms: FAST_TIMEOUT_MS });

    // A call from inside the hand-off's page (I'm logged in), keeping it open: one byte of the answer, for its status.
    const inPage = world(() => fetched([capture('tab_call', USERINFO_URL, '{', 200)], 'https://www.ixigo.com/?loginVisible=true'));
    const said = await createBrowserFetchRunner(inPage.deps).tabCall!('t1', 'ixigo_login', { url: '/api/v2/oauth/userinfo', method: 'POST' }, 600_000);
    expect(said).toMatchObject({ match: 'tab_call', status: 200 });
    expect(inPage.calls[0]!.opts['body']).toEqual({
      tab: 'ixigo_login', steps: [{ op: 'page_fetch', url: '/api/v2/oauth/userinfo', method: 'POST', capture_as: 'tab_call', max_bytes: 1 }], keep_open_ms: 600_000, timeout_ms: FAST_TIMEOUT_MS,
    });
    const none = world(() => {
      throw new V1Error(409, 'no_open_tab', 'No tab is kept open.');
    });
    expect(await createBrowserFetchRunner(none.deps).tabCall!('t1', 'ixigo_login', { url: '/api/v2/oauth/userinfo', method: 'POST' }, 600_000)).toBeNull();

    // A page that ran out of time stays in front for the person: what it caught, never a failure.
    const slow = world(() => {
      throw new V1Error(504, 'timeout', 'The page did not send every capture within 12000 ms (it stopped at 1 click).', null, { partial: { captures: [] } });
    });
    expect(await createBrowserFetchRunner(slow.deps).handOff!('t1', 'https://www.ixigo.com/', plan, { keepOpenMs: 600_000, tab: 'ixigo_login', check: { url: '/api/v2/oauth/userinfo', method: 'POST' } })).toEqual({ captures: [] });
    // Its taps are a convenience: ixigo's Login not found (the page's time ran out at that step), the page is still the
    // person's, in front, with the check it caught.
    const missed = world(() => {
      throw new V1Error(504, 'timeout', 'The page did not send every capture within 12000 ms (it stopped at 2 click).', null, {
        partial: { step: '2 click', captures: [capture('check', USERINFO_URL, '{', 403)] },
      });
    });
    expect(await createBrowserFetchRunner(missed.deps).handOff!('t1', 'https://www.ixigo.com/', plan, { keepOpenMs: 600_000, tab: 'ixigo_login', check: { url: '/api/v2/oauth/userinfo', method: 'POST' } }))
      .toMatchObject({ captures: [{ match: 'check', status: 403 }] });
    // A tab already gone (its time ran out) is nothing to close; anything else Bash refuses is said as a travel error.
    const gone = world(() => {
      throw new V1Error(409, 'no_open_tab', 'No tab is kept open.');
    });
    await expect(createBrowserFetchRunner(gone.deps).release!('t1', 'ixigo_login')).resolves.toBeUndefined();
    const old = world(() => {
      throw new V1Error(400, 'invalid_request', 'Unrecognized key: "front"');
    });
    await expect(createBrowserFetchRunner(old.deps).handOff!('t1', 'https://www.ixigo.com/', plan, { keepOpenMs: 600_000, tab: 'ixigo_login', check: { url: '/api/v2/oauth/userinfo', method: 'POST' } })).rejects.toBeInstanceOf(TravelError);
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

  it('keeps the tab of a page a person waits on open as the warm tab, so the live view sees ixigo draw it; never otherwise', async () => {
    const w = world(() => fetched([busCapture]));
    const runner = createBrowserFetchRunner(w.deps);
    await runner.read('t1', BUSES, busPlan, { keepOpen: true });
    await runner.read('t1', BUSES, busPlan);
    const kept = w.calls.map((c) => (c.opts['body'] as { keep_open_ms?: number; tab?: string }));
    // Under Bash's default name, the warm tab the page calls take: no tab of its own toward Bash's cap.
    expect(kept.map((b) => [b.keep_open_ms, b.tab])).toEqual([[WARM_TAB_MS, undefined], [undefined, undefined]]);
  });

  it("looks at a kept page once ixigo has drawn it, for a live card: one tiny call in the tab, its pictures of the same page", async () => {
    const OTHER = 'https://www.ixigo.com/buses/bus_search/Delhi/1/Goa/102/06-11-2026/O';
    const pic = (page_url: string, jpeg_base64: string) => ({ label: 'done', at_ms: 120, page_url, jpeg_base64 });
    const w = world((c) => ((c.opts['body'] as { url?: string }).url
      ? { ...fetched([busCapture]), frames: [pic(BUSES, '/9j/S')] }
      : { ...fetched([capture('look', 'https://www.ixigo.com/favicon.ico', '')]), frames: [pic(BUSES, '/9j/D'), pic(OTHER, '/9j/X')] }));
    const runner = createBrowserFetchRunner(w.deps);
    const seen: RecipeProgress[] = [];
    await runner.read('t1', BUSES, busPlan, { keepOpen: true, look: true, tag: '01JRUNPAGE', onProgress: (e) => seen.push(e) });
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(w.calls.map((c) => c.opts['body'])[1]).toEqual({
      steps: [{ op: 'page_fetch', url: '/favicon.ico', method: 'GET', capture_as: 'look', max_bytes: 1_000 }],
      // Through Bash's settle window: without one, Bash answers before the tab's picture is back, with none.
      keep_open_ms: WARM_TAB_MS, timeout_ms: LOOK_TIMEOUT_MS, frames: { width: FRAME_WIDTH, settle_ms: LOOK_SETTLE_MS }, tag: '01JRUNPAGE',
    });
    // Only the run's own page, timed from the page's fetch: the look went LOOK_AFTER_MS after the answer.
    expect(seen.at(-1)).toEqual({ type: 'drawn', frames: [{ ...pic(BUSES, '/9j/D'), at_ms: LOOK_AFTER_MS + 120 }] });

    // No look without a live card, nor for a page whose tab is not kept; a look that fails tells nothing and throws nothing.
    const quiet = world(() => fetched([busCapture]));
    const r2 = createBrowserFetchRunner(quiet.deps);
    await r2.read('t1', BUSES, busPlan, { keepOpen: true, onProgress: () => undefined });
    await r2.read('t1', BUSES, busPlan, { look: true, onProgress: () => undefined });
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(quiet.calls).toHaveLength(2);
    const taken = world((c) => {
      if ((c.opts['body'] as { url?: string }).url) return fetched([busCapture]);
      throw new V1Error(409, 'no_open_tab', 'No tab is kept open under the name default.');
    });
    const told: RecipeProgress[] = [];
    await createBrowserFetchRunner(taken.deps).read('t1', BUSES, busPlan, { keepOpen: true, look: true, onProgress: (e) => told.push(e) });
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(taken.calls).toHaveLength(2);
    expect(told.some((e) => e.type === 'drawn')).toBe(false);
    expect(taken.log.warn).toHaveBeenCalledWith(expect.objectContaining({ tripId: 't1' }), 'travel: a look at the drawn page found nothing');
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
